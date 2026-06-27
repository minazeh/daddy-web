"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  GUILD_LABEL,
  normalizePower,
  type Guild,
  type ManagedMember,
} from "@/lib/types";
import { setMemberPower } from "@/lib/actions";
import { GuildToggle } from "./GuildToggle";

// Member management dashboard for ONE guild: stat cards + a grid of every
// member (active + departed). Click a member → modal with all details + an
// editable Power Rating that persists via setMemberPower (optimistic UI).
// No heavy DnD; deterministic order comes pre-sorted from the server.

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-indigo-400/30 bg-gradient-to-b from-[#161634] to-[#10101f] p-4">
      <div className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-slate-100">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

export function MembersDashboard({
  guild,
  members: initial,
  partiesFilled,
  membersAssigned,
  persistenceEnabled,
}: {
  guild: Guild;
  members: ManagedMember[];
  partiesFilled: number;
  membersAssigned: number;
  persistenceEnabled: boolean;
}) {
  const [members, setMembers] = useState<ManagedMember[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const selected = useMemo(
    () => members.find((m) => m.userId === selectedId) ?? null,
    [members, selectedId],
  );

  const stats = useMemo(() => {
    const active = members.filter((m) => m.active);
    const departed = members.length - active.length;
    const avgPower =
      active.length === 0
        ? 0
        : Math.round(
            active.reduce((s, m) => s + m.power, 0) / active.length,
          );
    return { active: active.length, departed, avgPower };
  }, [members]);

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

  return (
    <div className="flex h-screen w-full flex-col bg-[#0a0a16] text-slate-100">
      {/* Top bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-indigo-500/20 bg-[#0c0c1c]/90 px-6 py-2">
        <Link
          href={`/?guild=${guild}`}
          className="rounded-md border border-indigo-400/40 bg-indigo-950/70 px-3 py-1.5 text-sm font-medium text-indigo-100 hover:bg-indigo-900/70"
        >
          ← Back to parties
        </Link>
        <span className="text-base font-bold">Members</span>
        <span className="text-xs text-slate-400">
          {GUILD_LABEL[guild]} — manage power ratings
        </span>
        <div className="ml-auto">
          <GuildToggle active={guild} basePath="/members" />
        </div>
      </div>

      {!persistenceEnabled && (
        <div className="shrink-0 border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200">
          <strong>Not configured.</strong> Mock data (in-memory) — set{" "}
          <code>MONGODB_URI</code> in <code>.env.local</code> to persist.
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1500px] p-6">
        {/* Stat cards — REAL data only. */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Active Members" value={stats.active} />
          <StatCard
            label="Departed"
            value={stats.departed}
            hint="left server / lost role"
          />
          <StatCard
            label="Avg Power (active)"
            value={stats.avgPower}
            hint="unrated count as 0"
          />
          <StatCard
            label="Parties Filled"
            value={`${partiesFilled}/30`}
            hint={`${membersAssigned} members assigned`}
          />
        </div>

        {/* Attendance placeholder — intentionally empty (voice-chat tracking is
            a later phase). No fabricated numbers. */}
        <div className="mt-4 rounded-xl border border-dashed border-indigo-400/20 bg-indigo-950/10 p-4">
          <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            Attendance — coming soon
          </div>
          <div className="mt-1 text-xs text-slate-600">
            Voice-chat attendance tracking will appear here in a later phase.
          </div>
        </div>

        {/* Member grid. */}
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {members.map((m) => (
            <button
              key={m.userId}
              type="button"
              onClick={() => setSelectedId(m.userId)}
              className={[
                "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                m.active
                  ? "border-indigo-400/30 bg-gradient-to-b from-[#161634] to-[#10101f] hover:border-indigo-300/60"
                  : "border-neutral-700/50 bg-neutral-900/40 opacity-60 hover:opacity-80",
              ].join(" ")}
            >
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-600 text-sm font-bold text-white"
                aria-hidden
              >
                {(Array.from(m.displayName)[0] ?? "?").toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{m.displayName}</span>
                  {!m.active && (
                    <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-px text-[9px] font-bold text-red-300 ring-1 ring-red-400/40">
                      Left server
                    </span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  {m.className && (
                    <span className="rounded bg-indigo-500/20 px-1.5 py-px text-[10px] text-indigo-200">
                      {m.className}
                    </span>
                  )}
                  <span className="text-[11px] text-slate-400">
                    ⚡ {m.power}
                  </span>
                </span>
              </span>
            </button>
          ))}
          {members.length === 0 && (
            <p className="col-span-full rounded-xl border border-dashed border-indigo-400/20 px-4 py-6 text-center text-sm text-slate-500">
              No members for {GUILD_LABEL[guild]} yet.
            </p>
          )}
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
