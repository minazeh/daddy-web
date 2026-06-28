"use client";

import { useState, useTransition } from "react";
import {
  KNOWN_CLASSES,
  PARTY_COUNT_MAX,
  PARTY_COUNT_MIN,
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  ROLES,
  validateSettings,
  type Guild,
  type RequiredClass,
  type Role,
  type Settings,
} from "@/lib/types";
import { updateSettings } from "@/lib/actions";
import { TopNav } from "./TopNav";

// Global settings editor. Each section saves via updateSettings. Initial state
// is deterministic from the loaded `settings` prop (no client-only values), so
// SSR === first client render. Structural changes (party size / counts) reseed
// the board and are CONFIRM-gated.

const ROLE_LABEL: Record<Role, string> = {
  tank: "Tank",
  healer: "Healer",
  dps: "DPS",
};

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-indigo-400/30 bg-gradient-to-b from-[#161634] to-[#10101f] p-4">
      <h2 className="text-sm font-bold text-slate-100">{title}</h2>
      {desc && <p className="mt-0.5 text-xs text-slate-400">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsForm({
  guild,
  settings: initial,
  persistenceEnabled,
}: {
  guild: Guild;
  settings: Settings;
  persistenceEnabled: boolean;
}) {
  // One working copy edited across sections; each Save validates + persists it.
  const [s, setS] = useState<Settings>(initial);
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const knownClasses = KNOWN_CLASSES as readonly string[];

  function save(next: Settings, structural: boolean) {
    if (!persistenceEnabled) {
      setMsg({ ok: false, text: "Set MONGODB_URI to persist settings." });
      return;
    }
    const v = validateSettings(next);
    if (!v.ok) {
      setMsg({ ok: false, text: v.error });
      return;
    }
    if (structural) {
      const ok = window.confirm(
        "Changing party size or counts RESEEDS the board for both guilds. " +
          "Removed parties/slots free their members back to the pool (members " +
          "are never deleted); raid-group references are cleaned up. Continue?",
      );
      if (!ok) return;
    }
    setBusy(true);
    startTransition(async () => {
      const res = await updateSettings(v.settings);
      setBusy(false);
      if (res.ok && res.settings) {
        setS(res.settings);
        setMsg({ ok: true, text: "Saved." });
      } else {
        setMsg({ ok: false, text: res.message ?? "Save failed." });
      }
    });
  }

  // ---- required composition editing ----
  const usedClasses = new Set(s.requiredClasses.map((r) => r.className));
  const addableClass = knownClasses.find((c) => !usedClasses.has(c));
  const minSum = s.requiredClasses.reduce((acc, r) => acc + (r.min || 0), 0);

  function setRequired(next: RequiredClass[]) {
    setS((p) => ({ ...p, requiredClasses: next }));
  }

  return (
    <div className="flex h-screen w-full flex-col bg-[#0a0a16] text-slate-100">
      <TopNav guild={guild} active="settings" />

      {!persistenceEnabled && (
        <div className="shrink-0 border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200">
          <strong>Not configured.</strong> Mock data (in-memory) — set{" "}
          <code>MONGODB_URI</code> in <code>.env.local</code> to persist.
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[900px] space-y-5 p-6">
          <div>
            <h1 className="text-xl font-bold">Settings</h1>
            <p className="mt-0.5 text-sm text-slate-400">
              Global party-composition rules. Changes apply to both guilds.
            </p>
            {msg && (
              <div
                className={[
                  "mt-3 rounded-md px-3 py-1.5 text-sm",
                  msg.ok
                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40"
                    : "bg-red-500/15 text-red-300 ring-1 ring-red-400/40",
                ].join(" ")}
              >
                {msg.text}
              </div>
            )}
          </div>

          {/* Required party composition */}
          <Section
            title="Required party composition"
            desc={`Every party must contain at least the listed count of each class. Sum of mins (${minSum}) must be ≤ party size (${s.partySize}).`}
          >
            <div className="space-y-2">
              {s.requiredClasses.length === 0 && (
                <p className="text-xs text-slate-500">
                  No required classes — Generate has no hard rule.
                </p>
              )}
              {s.requiredClasses.map((rc, i) => (
                <div key={rc.className} className="flex items-center gap-2">
                  <select
                    value={rc.className}
                    onChange={(e) => {
                      const next = [...s.requiredClasses];
                      next[i] = { ...rc, className: e.target.value };
                      setRequired(next);
                    }}
                    className="rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-sm"
                  >
                    {knownClasses
                      .filter((c) => c === rc.className || !usedClasses.has(c))
                      .map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                  </select>
                  <span className="text-xs text-slate-400">min</span>
                  <input
                    type="number"
                    min={1}
                    value={rc.min}
                    onChange={(e) => {
                      const next = [...s.requiredClasses];
                      next[i] = { ...rc, min: Math.max(1, Number(e.target.value) || 1) };
                      setRequired(next);
                    }}
                    className="w-16 rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setRequired(s.requiredClasses.filter((_, j) => j !== i))
                    }
                    className="rounded px-1.5 text-xs text-slate-400 hover:text-red-400"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={!addableClass}
                  onClick={() =>
                    addableClass &&
                    setRequired([
                      ...s.requiredClasses,
                      { className: addableClass, min: 1 },
                    ])
                  }
                  className="rounded-md border border-indigo-400/40 bg-indigo-950/70 px-3 py-1 text-xs font-medium hover:bg-indigo-900/70 disabled:opacity-40"
                >
                  + Add required class
                </button>
                <button
                  type="button"
                  onClick={() => save(s, false)}
                  disabled={busy}
                  className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-3 py-1 text-xs font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
                >
                  Save composition
                </button>
              </div>
            </div>
          </Section>

          {/* Class → role map */}
          <Section
            title="Class → Role map"
            desc="Roles drive Generate's tank spread and the analytics role split."
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {knownClasses.map((cls) => (
                <div key={cls} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-200">{cls}</span>
                  <select
                    value={s.classRoles[cls] ?? "dps"}
                    onChange={(e) =>
                      setS((p) => ({
                        ...p,
                        classRoles: {
                          ...p.classRoles,
                          [cls]: e.target.value as Role,
                        },
                      }))
                    }
                    className="rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-sm"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => save(s, false)}
                disabled={busy}
                className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-3 py-1 text-xs font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
              >
                Save roles
              </button>
            </div>
          </Section>

          {/* Party size + counts (structural → confirm + reseed) */}
          <Section
            title="Party size & counts"
            desc="Changing these RESEEDS the board (confirm required). Reducing frees displaced members back to the pool — never deletes them."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Party size ({PARTY_SIZE_MIN}–{PARTY_SIZE_MAX})
                <input
                  type="number"
                  min={PARTY_SIZE_MIN}
                  max={PARTY_SIZE_MAX}
                  value={s.partySize}
                  onChange={(e) =>
                    setS((p) => ({ ...p, partySize: Number(e.target.value) || 0 }))
                  }
                  className="rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-sm text-slate-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Main parties ({PARTY_COUNT_MIN}–{PARTY_COUNT_MAX})
                <input
                  type="number"
                  min={PARTY_COUNT_MIN}
                  max={PARTY_COUNT_MAX}
                  value={s.mainPartyCount}
                  onChange={(e) =>
                    setS((p) => ({
                      ...p,
                      mainPartyCount: Number(e.target.value) || 0,
                    }))
                  }
                  className="rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-sm text-slate-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Sub parties ({PARTY_COUNT_MIN}–{PARTY_COUNT_MAX})
                <input
                  type="number"
                  min={PARTY_COUNT_MIN}
                  max={PARTY_COUNT_MAX}
                  value={s.subPartyCount}
                  onChange={(e) =>
                    setS((p) => ({
                      ...p,
                      subPartyCount: Number(e.target.value) || 0,
                    }))
                  }
                  className="rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-sm text-slate-100"
                />
              </label>
            </div>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => save(s, true)}
                disabled={busy}
                className="rounded-md border border-amber-400/50 bg-amber-950/40 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
              >
                Save & reseed
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
