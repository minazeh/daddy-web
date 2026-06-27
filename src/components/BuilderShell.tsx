"use client";

import { useMemo, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  CARDS_PER_ROW,
  FIELDS,
  FIELD_LABEL,
  GUILD_LABEL,
  MAX_PARTY_SLOTS,
  partyHasPriest,
  type Field,
  type Guild,
  type Member,
  type Party,
} from "@/lib/types";
import {
  generateGuild,
  renameParty,
  resetGuild,
  resetLockGuild,
  setPartyLocks,
  updateParty,
} from "@/lib/actions";
import { MemberPool, POOL_ID } from "./MemberPool";
import { PartyCard } from "./PartyCard";
import { MemberChip, type DragData } from "./MemberChip";

// The interactive builder for ONE guild. Holds all client state (optimistic
// UI) and orchestrates member drag-and-drop inside a single DndContext. Every
// slot change auto-saves immediately via a server action — there is NO manual
// save button. The parent re-mounts this (key={guild}) on toggle, so no state
// crosses the Daddy/Mummy boundary.
//
// The field structure is FIXED: each guild has a Main Field (12 parties) above
// and a Sub Field (18 parties) below, laid out in a deterministic grid (5 per
// row). The board is a plain VERTICALLY-SCROLLABLE container (no zoom/pan) — so
// it's plain DOM that SSRs normally with no hydration mismatch. Seeding is
// server-side (data.ts).
//
// DnD: dnd-kit collision uses droppable client rects from getBoundingClientRect.
// MeasuringStrategy.Always re-measures slot rects during the drag (harmless;
// kept so a slot that scrolls into view mid-drag still registers). The
// DragOverlay renders in screen space and tracks the cursor 1:1.

export function BuilderShell({
  guild,
  members,
  parties: initialParties,
  persistenceEnabled,
}: {
  guild: Guild;
  members: Member[];
  parties: Party[];
  persistenceEnabled: boolean;
}) {
  const [parties, setParties] = useState<Party[]>(initialParties);
  const [activeMember, setActiveMember] = useState<Member | null>(null);
  const [, startTransition] = useTransition();

  // Disables the toolbar buttons while a bulk op is running.
  const [busy, setBusy] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const membersById = useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  const assignedIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of parties) for (const id of p.memberIds) s.add(id);
    return s;
  }, [parties]);

  // LIVE "no Priest" set — computed from CURRENT party membership (locked OR
  // unlocked) via the shared partyHasPriest helper, NOT from a flag stored at
  // Generate time. So manually dragging/locking a Priest into a party clears its
  // badge immediately. A party with NO members isn't flagged (nothing to heal
  // yet) — only a party that has members but none of them are a Priest.
  const noHealerIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of parties) {
      if (p.memberIds.length > 0 && !partyHasPriest(p, membersById)) {
        s.add(p.partyId);
      }
    }
    return s;
  }, [parties, membersById]);

  // Group parties by field for the two stacked sections, each sorted by index.
  const partiesByField = useMemo(() => {
    const groups: Record<Field, Party[]> = { main: [], sub: [] };
    for (const p of parties) groups[p.field].push(p);
    for (const f of FIELDS) groups[f].sort((a, b) => a.position - b.position);
    return groups;
  }, [parties]);

  // ---- persistence helpers (each fires immediately; no save button) ----
  function persistMembers(partyId: string, memberIds: string[]) {
    if (!persistenceEnabled) return;
    startTransition(async () => {
      await updateParty(partyId, memberIds);
    });
  }
  function persistLocks(partyId: string, lockedSlots: number[]) {
    if (!persistenceEnabled) return;
    startTransition(async () => {
      await setPartyLocks(partyId, lockedSlots);
    });
  }

  // ---- drag lifecycle ----
  function handleDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (data?.kind === "member") {
      setActiveMember(membersById.get(data.memberId) ?? null);
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    const data = e.active.data.current as DragData | undefined;
    setActiveMember(null);

    if (!data) return;

    // --- Member assignment / removal ---
    if (!e.over) return;
    const { memberId, from } = data;
    const overData = e.over.data.current as
      | { kind?: string; partyId?: string; slotIndex?: number }
      | undefined;

    // Dropped onto the pool -> remove from its source party.
    if (overData?.kind === "pool" || e.over.id === POOL_ID) {
      if (from === "pool") return;
      removeFromParty(from, memberId);
      return;
    }

    // Dropped onto a slot -> assign to that party (respecting locks/cap).
    if (overData?.kind === "slot" && overData.partyId) {
      const toPartyId = overData.partyId;
      const slotIndex = overData.slotIndex ?? -1;
      assignToParty(memberId, from, toPartyId, slotIndex);
    }
  }

  // ---- mutations (compute next state, then persist OUTSIDE setState so each
  //      drag writes exactly once, even under Strict Mode) ----

  function removeFromParty(partyId: string, memberId: string) {
    const target = parties.find((p) => p.partyId === partyId);
    if (!target || !target.memberIds.includes(memberId)) return;
    const nextIds = target.memberIds.filter((id) => id !== memberId);
    setParties((prev) =>
      prev.map((p) => (p.partyId === partyId ? { ...p, memberIds: nextIds } : p)),
    );
    persistMembers(partyId, nextIds);
  }

  function assignToParty(
    memberId: string,
    from: string,
    toPartyId: string,
    slotIndex: number,
  ) {
    const target = parties.find((p) => p.partyId === toPartyId);
    if (!target) return;

    // A locked slot can't be overwritten by a drop.
    if (target.lockedSlots.includes(slotIndex) && target.memberIds[slotIndex]) {
      return;
    }
    if (from === toPartyId) return; // already in this party
    if (target.memberIds.includes(memberId)) return; // dedupe
    if (target.memberIds.length >= MAX_PARTY_SLOTS) return; // full

    const toIds = [...target.memberIds, memberId];
    let fromIds: string[] | null = null;
    if (from !== "pool") {
      const fromParty = parties.find((p) => p.partyId === from);
      if (fromParty) {
        fromIds = fromParty.memberIds.filter((id) => id !== memberId);
      }
    }

    setParties((prev) =>
      prev.map((p) => {
        if (p.partyId === toPartyId) return { ...p, memberIds: toIds };
        if (p.partyId === from && fromIds) return { ...p, memberIds: fromIds };
        return p;
      }),
    );

    persistMembers(toPartyId, toIds);
    if (from !== "pool" && fromIds) persistMembers(from, fromIds);
  }

  function handleToggleLock(partyId: string, index: number) {
    const target = parties.find((p) => p.partyId === partyId);
    if (!target) return;
    const set = new Set(target.lockedSlots);
    if (set.has(index)) set.delete(index);
    else set.add(index);
    const next = Array.from(set).sort((a, b) => a - b);
    setParties((prev) =>
      prev.map((p) => (p.partyId === partyId ? { ...p, lockedSlots: next } : p)),
    );
    persistLocks(partyId, next);
  }

  function handleRename(partyId: string, name: string) {
    setParties((prev) =>
      prev.map((p) => (p.partyId === partyId ? { ...p, name } : p)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        await renameParty(partyId, name);
      });
    }
  }

  // ---- roster auto-fill toolbar (all scoped to THIS guild, both fields) ----
  async function handleGenerate() {
    if (!persistenceEnabled || busy) return;
    setBusy(true);
    try {
      const res = await generateGuild(guild);
      if (res.ok && res.parties) {
        setParties(res.parties);
        // No need to read res.partiesWithoutHealer — the badge/shortage are
        // now computed LIVE from party membership (see noHealerIds memo).
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!persistenceEnabled || busy) return;
    if (
      !window.confirm(
        "Reset will clear all UNLOCKED slots for this guild (locked members stay). Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await resetGuild(guild);
      if (res.ok && res.parties) setParties(res.parties);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetLock() {
    if (!persistenceEnabled || busy) return;
    if (
      !window.confirm(
        "Reset Lock will clear EVERYTHING for this guild — all assignments AND all locks — leaving a blank board. This cannot be undone. Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await resetLockGuild(guild);
      if (res.ok && res.parties) setParties(res.parties);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DndContext
      // Stable explicit id: without it dnd-kit auto-generates the
      // DndDescribedBy/DndLiveRegion ids via an internal counter that differs
      // between the server render and client hydration (key={guild} re-mounts
      // bump it), causing an aria-describedby hydration mismatch on every
      // draggable. A fixed id makes those ids deterministic. Only one
      // BuilderShell renders at a time, so a single static id can't collide.
      id="builder-dnd"
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-screen w-full overflow-hidden">
        <MemberPool guild={guild} members={members} assignedIds={assignedIds} />

        {/* RIGHT: vertically-scrollable board (no zoom/pan). */}
        <div className="relative flex-1 overflow-y-auto overflow-x-hidden canvas-grid">
          {!persistenceEnabled && (
            <div className="sticky top-0 z-30 border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200 backdrop-blur">
              <strong>Not configured.</strong> Mock data — set{" "}
              <code>MONGODB_URI</code> in <code>.env.local</code> to persist.
            </div>
          )}

          {/* Roster auto-fill toolbar (scoped to the current guild, both fields). */}
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-indigo-500/20 bg-[#0c0c1c]/90 px-6 py-2 backdrop-blur">
            <span className="mr-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
              {GUILD_LABEL[guild]} roster
            </span>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!persistenceEnabled || busy}
              title={
                persistenceEnabled
                  ? "Auto-fill unlocked slots (a Priest per party, balanced)"
                  : "Needs MONGODB_URI"
              }
              className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-3 py-1.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
            >
              {busy ? "Working…" : "Generate"}
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!persistenceEnabled || busy}
              title="Clear unlocked slots (locked members stay)"
              className="rounded-md border border-indigo-400/40 bg-indigo-950/70 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-indigo-900/70 disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={handleResetLock}
              disabled={!persistenceEnabled || busy}
              title="Clear everything incl. locks (blank board)"
              className="rounded-md border border-red-400/40 bg-red-950/40 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/40 disabled:opacity-40"
            >
              Reset Lock
            </button>
            {noHealerIds.size > 0 && (
              <span className="ml-1 rounded bg-amber-500/20 px-2 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-400/40">
                ⚠ {noHealerIds.size}{" "}
                {noHealerIds.size === 1 ? "party" : "parties"} without a Priest
              </span>
            )}
          </div>

          {/* Two stacked field sections: Main Field (12) above, a divider,
              Sub Field (18) below — each a 5-per-row grid. */}
          <div className="mx-auto flex max-w-[1500px] flex-col gap-6 p-6">
            {FIELDS.map((field, fi) => (
              <section key={field}>
                {fi > 0 && (
                  <div className="mb-6 h-px w-full bg-gradient-to-r from-transparent via-fuchsia-400/40 to-transparent" />
                )}
                <h2 className="mb-3 flex items-center gap-2 text-lg font-bold tracking-wide text-slate-100">
                  <span
                    className={
                      field === "main"
                        ? "h-3 w-3 rounded-full bg-sky-400"
                        : "h-3 w-3 rounded-full bg-fuchsia-400"
                    }
                    aria-hidden
                  />
                  {FIELD_LABEL[field]}
                  <span className="text-xs font-normal text-slate-400">
                    ({partiesByField[field].length} parties)
                  </span>
                </h2>
                <div
                  className="grid gap-4"
                  style={{
                    gridTemplateColumns: `repeat(${CARDS_PER_ROW}, minmax(0, 1fr))`,
                  }}
                >
                  {partiesByField[field].map((p) => (
                    <PartyCard
                      key={p.partyId}
                      party={p}
                      membersById={membersById}
                      onRename={handleRename}
                      onToggleLock={handleToggleLock}
                      onRemoveMember={removeFromParty}
                      persistenceEnabled={persistenceEnabled}
                      noHealer={noHealerIds.has(p.partyId)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {/* Drag preview renders in screen space — tracks the cursor 1:1. */}
      <DragOverlay>
        {activeMember ? (
          <MemberChip
            member={activeMember}
            instanceId="overlay"
            from="overlay"
            overlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
