"use client";

import { useMemo, useState, useTransition } from "react";
import {
  CLASS_ROLE,
  normalizePower,
  roleForClass,
  type Guild,
  type ManagedMember,
  type Role,
} from "@/lib/types";
import { setMemberPower } from "@/lib/actions";
import { TopNav } from "./TopNav";

// Member management dashboard for ONE guild — two-pane:
//   LEFT  = scrollable member list (search + sort), each card opens the modal.
//   RIGHT = analytics dashboard (stat cards, per-class table, CSS/SVG charts,
//           top-power + needs-rating lists), all REAL data for the guild.
//
// HYDRATION-SAFE CHARTS: every chart is plain CSS/SVG with deterministic widths/
// heights derived from the data (no DOM measurement, no charting lib) — so SSR
// and the first client render are byte-identical. No mounted guard needed.
// The sort control defaults to "Name A→Z" (a single deterministic order applied
// identically on the server + first client render); changing it re-sorts on the
// client only.

const KNOWN_CLASSES = [
  "Assassin",
  "Hunter",
  "Knight",
  "Priest",
  "Gunslinger",
  "Blacksmith",
  "Wizard",
  "Druid",
];

const ROLE_LABEL: Record<Role, string> = {
  tank: "Tank",
  healer: "Healer",
  dps: "DPS",
};

type SortMode = "name-asc" | "name-desc" | "power-desc" | "power-asc";

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

function StatCard({
  label,
  value,
  hint,
  warn = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={[
        "rounded-xl border bg-gradient-to-b from-[#161634] to-[#10101f] p-4",
        warn ? "border-amber-400/50" : "border-indigo-400/30",
      ].join(" ")}
    >
      <div className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div
        className={[
          "mt-1 text-2xl font-bold",
          warn ? "text-amber-300" : "text-slate-100",
        ].join(" ")}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

// A horizontal CSS bar (deterministic width %). SSR-safe.
function Bar({
  label,
  value,
  max,
  suffix,
  tone = "indigo",
}: {
  label: string;
  value: number;
  max: number;
  suffix?: string;
  tone?: "indigo" | "fuchsia" | "sky";
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const bar =
    tone === "fuchsia"
      ? "from-fuchsia-500 to-fuchsia-400"
      : tone === "sky"
        ? "from-sky-500 to-sky-400"
        : "from-indigo-500 to-fuchsia-500";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 truncate text-slate-300">{label}</span>
      <span className="h-4 flex-1 overflow-hidden rounded bg-indigo-950/40">
        <span
          className={`block h-full rounded bg-gradient-to-r ${bar}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-slate-400">
        {value}
        {suffix ?? ""}
      </span>
    </div>
  );
}

export function MembersDashboard({
  guild,
  members: initial,
  partyCount,
  assignedMemberIds,
  persistenceEnabled,
}: {
  guild: Guild;
  members: ManagedMember[];
  partyCount: number;
  assignedMemberIds: string[];
  persistenceEnabled: boolean;
}) {
  const [members, setMembers] = useState<ManagedMember[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Default sort is deterministic (Name A→Z) so SSR === first client render.
  const [sortMode, setSortMode] = useState<SortMode>("name-asc");
  const [, startTransition] = useTransition();

  const assignedSet = useMemo(
    () => new Set(assignedMemberIds),
    [assignedMemberIds],
  );

  const selected = useMemo(
    () => members.find((m) => m.userId === selectedId) ?? null,
    [members, selectedId],
  );

  // ---- left list: filter + deterministic sort ----
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? members.filter(
          (m) =>
            m.displayName.toLowerCase().includes(q) ||
            (m.className ?? "").toLowerCase().includes(q),
        )
      : members.slice();
    const byNameThenId = (a: ManagedMember, b: ManagedMember) => {
      const n = a.displayName.localeCompare(b.displayName);
      return n !== 0 ? n : a.userId.localeCompare(b.userId);
    };
    filtered.sort((a, b) => {
      switch (sortMode) {
        case "name-asc":
          return byNameThenId(a, b);
        case "name-desc":
          return -byNameThenId(a, b);
        case "power-desc":
          return b.power !== a.power
            ? b.power - a.power
            : byNameThenId(a, b); // power ties broken by name
        case "power-asc":
          return a.power !== b.power ? a.power - b.power : byNameThenId(a, b);
      }
    });
    return filtered;
  }, [members, query, sortMode]);

  // ---- analytics (active members for stats unless noted) ----
  const a = useMemo(() => {
    const active = members.filter((m) => m.active);
    const departed = members.length - active.length;
    const avgPower =
      active.length === 0
        ? 0
        : Math.round(active.reduce((s, m) => s + m.power, 0) / active.length);

    const priests = active.filter((m) => m.className === "Priest").length;
    const assignedActive = active.filter((m) =>
      assignedSet.has(m.userId),
    ).length;
    const bench = active.length - assignedActive;
    const rated = active.filter((m) => m.power > 0).length;
    const unrated = active.length - rated;

    // Per-class rows (8 known + Unknown/none), from ACTIVE members.
    const classKeys = [...KNOWN_CLASSES, "Unknown/none"];
    const perClass = classKeys.map((cls) => {
      const isUnknown = cls === "Unknown/none";
      const rows = active.filter((m) =>
        isUnknown ? !m.className || !KNOWN_CLASSES.includes(m.className) : m.className === cls,
      );
      const powers = rows.map((m) => m.power);
      const role: Role = isUnknown ? "dps" : (CLASS_ROLE[cls] ?? "dps");
      return {
        cls,
        role,
        count: rows.length,
        avg: powers.length
          ? Math.round(powers.reduce((s, p) => s + p, 0) / powers.length)
          : 0,
        min: powers.length ? Math.min(...powers) : 0,
        max: powers.length ? Math.max(...powers) : 0,
        median: median(powers),
        unrated: rows.filter((m) => m.power === 0).length,
      };
    });

    // Power histogram buckets across ACTIVE roster.
    const buckets = [
      { label: "0", test: (p: number) => p === 0 },
      { label: "1–25", test: (p: number) => p >= 1 && p <= 25 },
      { label: "26–50", test: (p: number) => p >= 26 && p <= 50 },
      { label: "51–75", test: (p: number) => p >= 51 && p <= 75 },
      { label: "76–100", test: (p: number) => p >= 76 && p <= 100 },
      { label: "100+", test: (p: number) => p > 100 },
    ].map((b) => ({
      label: b.label,
      count: active.filter((m) => b.test(m.power)).length,
    }));

    // Role split (Tank/Healer/DPS) from ACTIVE members.
    const roleSplit: Record<Role, number> = { tank: 0, healer: 0, dps: 0 };
    for (const m of active) roleSplit[roleForClass(m.className)]++;

    // Top 10 by power (active), then needs-rating (active, power 0).
    const byNameThenId = (x: ManagedMember, y: ManagedMember) => {
      const n = x.displayName.localeCompare(y.displayName);
      return n !== 0 ? n : x.userId.localeCompare(y.userId);
    };
    const top10 = [...active]
      .sort((x, y) => (y.power !== x.power ? y.power - x.power : byNameThenId(x, y)))
      .slice(0, 10);
    const needsRating = active
      .filter((m) => m.power === 0)
      .sort(byNameThenId);

    return {
      active: active.length,
      departed,
      avgPower,
      priests,
      assignedActive,
      bench,
      rated,
      unrated,
      perClass,
      buckets,
      roleSplit,
      top10,
      needsRating,
    };
  }, [members, assignedSet]);

  function handleSavePower(userId: string, power: number) {
    const value = normalizePower(power);
    setMembers((prev) =>
      prev.map((m) => (m.userId === userId ? { ...m, power: value } : m)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        await setMemberPower(userId, value);
      });
    }
  }

  const classMax = Math.max(1, ...a.perClass.map((r) => r.count));
  const classAvgMax = Math.max(1, ...a.perClass.map((r) => r.avg));
  const bucketMax = Math.max(1, ...a.buckets.map((b) => b.count));
  const roleTotal = a.roleSplit.tank + a.roleSplit.healer + a.roleSplit.dps;

  return (
    <div className="flex h-screen w-full flex-col bg-[#0a0a16] text-slate-100">
      <TopNav guild={guild} active="members" />

      {!persistenceEnabled && (
        <div className="shrink-0 border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200">
          <strong>Not configured.</strong> Mock data (in-memory) — set{" "}
          <code>MONGODB_URI</code> in <code>.env.local</code> to persist.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* LEFT: member list */}
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-indigo-500/20 bg-[#0c0c1c]/60">
          <div className="space-y-2 border-b border-indigo-500/20 p-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or class…"
              className="w-full rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
            />
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                Sort
              </label>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="flex-1 rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-xs text-slate-100"
              >
                <option value="name-asc">Name: A → Z</option>
                <option value="name-desc">Name: Z → A</option>
                <option value="power-desc">Power: high → low</option>
                <option value="power-asc">Power: low → high</option>
              </select>
            </div>
            <div className="text-[10px] text-slate-500">
              {visible.length} shown · {a.active} active · {a.departed} departed
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {visible.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => setSelectedId(m.userId)}
                className={[
                  "flex w-full items-center gap-2.5 rounded-lg border p-2 text-left transition-colors",
                  m.active
                    ? "border-indigo-400/30 bg-indigo-950/40 hover:border-indigo-300/60"
                    : "border-neutral-700/50 bg-neutral-900/40 opacity-60 hover:opacity-80",
                ].join(" ")}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-600 text-xs font-bold text-white"
                  aria-hidden
                >
                  {(Array.from(m.displayName)[0] ?? "?").toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {m.displayName}
                    </span>
                    {!m.active && (
                      <span className="shrink-0 rounded bg-red-500/20 px-1 py-px text-[8px] font-bold text-red-300 ring-1 ring-red-400/40">
                        Left
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[10px] text-slate-400">
                    {m.className ?? "—"}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-300">
                  ⚡{m.power}
                </span>
              </button>
            ))}
            {visible.length === 0 && (
              <p className="px-1 py-4 text-center text-xs text-slate-500">
                No members match.
              </p>
            )}
          </div>
        </aside>

        {/* RIGHT: analytics dashboard */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1100px] space-y-6 p-6">
            {/* Roster-health stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard label="Active" value={a.active} />
              <StatCard label="Departed" value={a.departed} hint="left server" />
              <StatCard label="Avg Power" value={a.avgPower} hint="active, unrated=0" />
              <StatCard
                label="Priest Coverage"
                value={`${a.priests}/${partyCount}`}
                hint={a.priests < partyCount ? "short of 1/party" : "≥ 1 per party"}
                warn={a.priests < partyCount}
              />
              <StatCard
                label="Assigned / Bench"
                value={`${a.assignedActive} / ${a.bench}`}
                hint="in a party vs not"
              />
              <StatCard
                label="Rated / Unrated"
                value={`${a.rated} / ${a.unrated}`}
                hint="power > 0 vs = 0"
              />
            </div>

            {/* Attendance placeholder — no fabricated numbers. */}
            <div className="rounded-xl border border-dashed border-indigo-400/20 bg-indigo-950/10 p-4">
              <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                Attendance — coming soon
              </div>
              <div className="mt-1 text-xs text-slate-600">
                Voice-chat attendance tracking will appear here in a later phase.
              </div>
            </div>

            {/* Per-class table */}
            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <h3 className="mb-3 text-sm font-bold text-slate-100">
                Per-class breakdown (active)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th className="py-1 pr-3 font-semibold">Class</th>
                      <th className="py-1 pr-3 font-semibold">Role</th>
                      <th className="py-1 pr-3 text-right font-semibold">Count</th>
                      <th className="py-1 pr-3 text-right font-semibold">Avg</th>
                      <th className="py-1 pr-3 text-right font-semibold">Min</th>
                      <th className="py-1 pr-3 text-right font-semibold">Max</th>
                      <th className="py-1 pr-3 text-right font-semibold">Median</th>
                      <th className="py-1 text-right font-semibold">Unrated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.perClass.map((r) => (
                      <tr
                        key={r.cls}
                        className="border-t border-indigo-500/10 text-slate-200"
                      >
                        <td className="py-1 pr-3">{r.cls}</td>
                        <td className="py-1 pr-3 text-slate-400">
                          {ROLE_LABEL[r.role]}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">{r.count}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{r.avg}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{r.min}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{r.max}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{r.median}</td>
                        <td className="py-1 text-right tabular-nums">{r.unrated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Charts: members per class + avg power per class */}
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
                <h3 className="mb-3 text-sm font-bold text-slate-100">
                  Members per class
                </h3>
                <div className="space-y-1.5">
                  {a.perClass.map((r) => (
                    <Bar key={r.cls} label={r.cls} value={r.count} max={classMax} />
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
                <h3 className="mb-3 text-sm font-bold text-slate-100">
                  Average power per class
                </h3>
                <div className="space-y-1.5">
                  {a.perClass.map((r) => (
                    <Bar
                      key={r.cls}
                      label={r.cls}
                      value={r.avg}
                      max={classAvgMax}
                      tone="fuchsia"
                    />
                  ))}
                </div>
              </section>
            </div>

            {/* Charts: histogram + role split */}
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
                <h3 className="mb-3 text-sm font-bold text-slate-100">
                  Power distribution
                </h3>
                {/* Vertical SVG-ish bars via flex; heights are deterministic %. */}
                <div className="flex h-40 items-end gap-2">
                  {a.buckets.map((b) => {
                    const h = bucketMax > 0 ? Math.round((b.count / bucketMax) * 100) : 0;
                    return (
                      <div key={b.label} className="flex flex-1 flex-col items-center gap-1">
                        <div className="flex w-full flex-1 items-end">
                          <div
                            className="w-full rounded-t bg-gradient-to-t from-indigo-600 to-fuchsia-500"
                            style={{ height: `${h}%` }}
                            title={`${b.count}`}
                          />
                        </div>
                        <div className="text-[10px] tabular-nums text-slate-400">
                          {b.count}
                        </div>
                        <div className="text-[9px] text-slate-500">{b.label}</div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
                <h3 className="mb-3 text-sm font-bold text-slate-100">Role split</h3>
                {/* Stacked horizontal bar (deterministic widths). */}
                <div className="flex h-6 w-full overflow-hidden rounded-md">
                  {(["tank", "healer", "dps"] as Role[]).map((role) => {
                    const v = a.roleSplit[role];
                    const pct = roleTotal > 0 ? (v / roleTotal) * 100 : 0;
                    const tone =
                      role === "tank"
                        ? "bg-sky-500"
                        : role === "healer"
                          ? "bg-emerald-500"
                          : "bg-fuchsia-500";
                    return (
                      <div
                        key={role}
                        className={tone}
                        style={{ width: `${pct}%` }}
                        title={`${ROLE_LABEL[role]}: ${v}`}
                      />
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  {(["tank", "healer", "dps"] as Role[]).map((role) => (
                    <span key={role} className="flex items-center gap-1.5">
                      <span
                        className={[
                          "h-2.5 w-2.5 rounded-sm",
                          role === "tank"
                            ? "bg-sky-500"
                            : role === "healer"
                              ? "bg-emerald-500"
                              : "bg-fuchsia-500",
                        ].join(" ")}
                      />
                      <span className="text-slate-300">{ROLE_LABEL[role]}</span>
                      <span className="tabular-nums text-slate-400">
                        {a.roleSplit[role]}
                      </span>
                    </span>
                  ))}
                </div>
              </section>
            </div>

            {/* Lists: top 10 by power + needs rating */}
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
                <h3 className="mb-3 text-sm font-bold text-slate-100">
                  Top 10 by power
                </h3>
                {a.top10.length === 0 ? (
                  <p className="text-xs text-slate-500">No active members.</p>
                ) : (
                  <ol className="space-y-1 text-xs">
                    {a.top10.map((m, i) => (
                      <li
                        key={m.userId}
                        className="flex items-center gap-2 rounded px-1 py-0.5"
                      >
                        <span className="w-5 shrink-0 text-right tabular-nums text-slate-500">
                          {i + 1}.
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedId(m.userId)}
                          className="truncate font-medium text-slate-200 hover:text-indigo-200"
                        >
                          {m.displayName}
                        </button>
                        <span className="truncate text-slate-500">
                          {m.className ?? "—"}
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums text-indigo-300">
                          ⚡{m.power}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="rounded-xl border border-amber-400/30 bg-[#10101f] p-4">
                <h3 className="mb-3 text-sm font-bold text-amber-200">
                  Needs rating ({a.needsRating.length})
                </h3>
                {a.needsRating.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Everyone active has a power rating. 🎉
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {a.needsRating.map((m) => (
                      <li key={m.userId} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedId(m.userId)}
                          className="truncate font-medium text-slate-200 hover:text-amber-200"
                        >
                          {m.displayName}
                        </button>
                        <span className="truncate text-slate-500">
                          {m.className ?? "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>

      {selected && (
        <MemberModal
          member={selected}
          onClose={() => setSelectedId(null)}
          onSave={handleSavePower}
          persistenceEnabled={persistenceEnabled}
        />
      )}
    </div>
  );
}

function MemberModal({
  member,
  onClose,
  onSave,
  persistenceEnabled,
}: {
  member: ManagedMember;
  onClose: () => void;
  onSave: (userId: string, power: number) => void;
  persistenceEnabled: boolean;
}) {
  const [draft, setDraft] = useState(String(member.power));

  function save() {
    onSave(member.userId, normalizePower(draft));
    onClose();
  }

  const rows: [string, string][] = [
    ["User ID", member.userId],
    ["Username", member.username || "—"],
    ["Display name", member.displayName],
    ["Class", member.className ?? "—"],
    ["Class role ID", member.classRoleId ?? "—"],
    ["Guild", member.isMain ? "Main (Daddy)" : member.isSub ? "Sub (Mummy)" : "—"],
    ["Status", member.active ? "Active" : "Departed (left server / lost role)"],
    ["Last seen", member.lastSeenAt.slice(0, 19).replace("T", " ")],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="neon-edge w-full max-w-md rounded-2xl border border-indigo-400/40 bg-gradient-to-b from-[#161634] to-[#10101f] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-3">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-600 text-lg font-bold text-white"
            aria-hidden
          >
            {(Array.from(member.displayName)[0] ?? "?").toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-lg font-bold">
                {member.displayName}
              </span>
              {!member.active && (
                <span className="rounded bg-red-500/20 px-1.5 py-px text-[10px] font-bold text-red-300 ring-1 ring-red-400/40">
                  Left server
                </span>
              )}
            </div>
            <div className="text-xs text-slate-400">{member.className ?? "—"}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-slate-400 hover:text-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <dl className="space-y-1.5 rounded-lg border border-indigo-400/20 bg-indigo-950/20 p-3 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-slate-400">{k}</dt>
              <dd className="truncate text-right text-slate-200">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4">
          <label className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            Power Rating
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") onClose();
              }}
              disabled={!persistenceEnabled}
              className="w-32 rounded-md border border-indigo-400/40 bg-[#0c0c1c] px-2 py-1.5 text-sm text-slate-100"
            />
            <button
              type="button"
              onClick={save}
              disabled={!persistenceEnabled}
              className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-4 py-1.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
            >
              Save
            </button>
          </div>
          {!persistenceEnabled && (
            <p className="mt-1 text-[11px] text-amber-300/80">
              Set MONGODB_URI to persist power ratings.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
