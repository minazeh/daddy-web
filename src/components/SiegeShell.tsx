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
  GUILD_LABEL,
  missingRequiredClasses,
  type Guild,
  type Member,
  type Settings,
} from "@/lib/types";
import {
  isFlexParty,
  SIEGE_CARDS_PER_ROW,
  SIEGE_EXPECTED_PARTY_COUNT,
  siegeExpectedCapacity,
  siegeRaidCapacity,
  siegeTotalCapacity,
  type SiegeParty,
  type SiegeRaid,
} from "@/lib/siege";
import type { SiegeBoard } from "@/lib/siege-data";
import {
  generateSiege,
  renameSiegeParty,
  renameSiegeRaid,
  resetLockSiege,
  resetSiege,
  setSiegePartyLocks,
  setSiegeRaidLeader,
  updateSiegeParty,
} from "@/lib/siege-actions";
import { MemberPool, POOL_ID } from "./MemberPool";
import { PartyCard } from "./PartyCard";
import { MemberChip, type DragData } from "./MemberChip";
import { TopNav } from "./TopNav";

// The Siege builder for ONE guild. A THIRD, independent layout alongside the
// GvG main/sub board and the Polarity board, sharing none of their data:
//   Alpha / Bravo / Charlie / Delta Flex  x  8 parties x 5 slots = 160 slots
//
// Daddy and Mummy are two entirely separate sieges. The parent re-mounts this
// (key={guild}) on toggle, so no client state crosses the boundary.
//
// Interaction mirrors the Polarity builder exactly: one DndContext, drag members
// between the pool and any slot, swap on an occupied slot, per-slot locking,
// party + raid rename, one leader per raid — every change auto-saves immediately
// via a server action.
//
// DELTA FLEX: all 8 of Delta's parties render, always. Parties 7-8 are drawn
// dimmed with a dashed outline and a "flex" tag, purely to say "these are
// overflow, we normally run 6". They are completely ordinary otherwise —
// droppable, lockable, renameable, and filled by Generate like any other party.
// Nothing here caps, gates or unlocks them.

export function SiegeShell({
  guild,
  members,
  board: initialBoard,
  settings,
  unavailableIds,
  persistenceEnabled,
}: {
  guild: Guild;
  members: Member[];
  board: SiegeBoard;
  settings: Settings;
  unavailableIds: Set<string>;
  persistenceEnabled: boolean;
}) {
  const [parties, setParties] = useState<SiegeParty[]>(initialBoard.parties);
  const [raids, setRaids] = useState<SiegeRaid[]>(initialBoard.raids);
  const [activeMember, setActiveMember] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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

  // LIVE per-party "missing required classes" — recomputed from CURRENT party
  // membership (locked OR unlocked), never a flag stored at Generate time, so a
  // manual drag clears the badge immediately. Same helper the other boards use.
  const missingByParty = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of parties) {
      if (p.memberIds.length === 0) continue;
      const miss = missingRequiredClasses(
        p,
        membersById,
        settings.requiredClasses,
      );
      if (miss.length > 0) m.set(p.partyId, miss);
    }
    return m;
  }, [parties, membersById, settings.requiredClasses]);

  // Parties grouped by raid, in each raid's party order.
  const partiesByRaid = useMemo(() => {
    const groups = new Map<string, SiegeParty[]>();
    for (const p of parties) {
      const list = groups.get(p.raidId);
      if (list) list.push(p);
      else groups.set(p.raidId, [p]);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.position - b.position);
    }
    return groups;
  }, [parties]);

  const totalCapacity = siegeTotalCapacity(settings.partySize);
  const unassignedCount = members.filter(
    (m) => !assignedIds.has(m.userId),
  ).length;
  const overflow = Math.max(0, members.length - totalCapacity);

  // ---- persistence helpers (each fires immediately; no save button) ----
  function persistMembers(partyId: string, memberIds: string[]) {
    if (!persistenceEnabled) return;
    startTransition(async () => {
      await updateSiegeParty(partyId, memberIds);
    });
  }
  function persistLocks(partyId: string, lockedSlots: number[]) {
    if (!persistenceEnabled) return;
    startTransition(async () => {
      await setSiegePartyLocks(partyId, lockedSlots);
    });
  }

  // ---- drag lifecycle (identical contract to the GvG / Polarity builders) ----
  function handleDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (data?.kind === "member") {
      setActiveMember(membersById.get(data.memberId) ?? null);
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    const data = e.active.data.current as DragData | undefined;
    setActiveMember(null);
    if (!data || !e.over) return;

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
      assignToParty(memberId, from, overData.partyId, overData.slotIndex ?? -1);
    }
  }

  function removeFromParty(partyId: string, memberId: string) {
    const target = parties.find((p) => p.partyId === partyId);
    if (!target || !target.memberIds.includes(memberId)) return;
    const nextIds = target.memberIds.filter((id) => id !== memberId);
    setParties((prev) =>
      prev.map((p) => (p.partyId === partyId ? { ...p, memberIds: nextIds } : p)),
    );
    persistMembers(partyId, nextIds);
  }

  // Drop member A (from = pool | partyId) onto slot (toPartyId, slotIndex).
  //   - target slot LOCKED        -> no-op (can't displace a locked member).
  //   - target slot OCCUPIED by B -> SWAP A and B (net-zero sizes).
  //   - target slot EMPTY         -> move A into the target party (partySize cap).
  function assignToParty(
    memberId: string,
    from: string,
    toPartyId: string,
    slotIndex: number,
  ) {
    const target = parties.find((p) => p.partyId === toPartyId);
    if (!target) return;
    if (target.lockedSlots.includes(slotIndex)) return;

    const occupantB = target.memberIds[slotIndex] ?? null;

    if (occupantB && occupantB !== memberId) {
      if (from === "pool") {
        // A takes B's slot; B is displaced back to the pool.
        const toIds = target.memberIds.map((id) =>
          id === occupantB ? memberId : id,
        );
        setParties((prev) =>
          prev.map((p) =>
            p.partyId === toPartyId ? { ...p, memberIds: toIds } : p,
          ),
        );
        persistMembers(toPartyId, toIds);
        return;
      }

      const fromParty = parties.find((p) => p.partyId === from);
      if (!fromParty) return;
      if (from === toPartyId) {
        // Same-party swap = reorder (cosmetic).
        const aIdx = fromParty.memberIds.indexOf(memberId);
        if (aIdx === -1) return;
        const ids = [...target.memberIds];
        [ids[aIdx], ids[slotIndex]] = [ids[slotIndex], ids[aIdx]];
        setParties((prev) =>
          prev.map((p) =>
            p.partyId === toPartyId ? { ...p, memberIds: ids } : p,
          ),
        );
        persistMembers(toPartyId, ids);
        return;
      }

      // Cross-party swap: A -> B's slot in toParty; B -> A's slot in fromParty.
      const toIds = target.memberIds.map((id) =>
        id === occupantB ? memberId : id,
      );
      const fromIds = fromParty.memberIds.map((id) =>
        id === memberId ? occupantB : id,
      );
      setParties((prev) =>
        prev.map((p) => {
          if (p.partyId === toPartyId) return { ...p, memberIds: toIds };
          if (p.partyId === from) return { ...p, memberIds: fromIds };
          return p;
        }),
      );
      persistMembers(toPartyId, toIds);
      persistMembers(from, fromIds);
      return;
    }

    // ---- MOVE into an EMPTY slot ----
    if (from === toPartyId) return;
    if (target.memberIds.includes(memberId)) return;
    if (target.memberIds.length >= settings.partySize) return;

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

  function handleRenameParty(partyId: string, name: string) {
    setParties((prev) =>
      prev.map((p) => (p.partyId === partyId ? { ...p, name } : p)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        await renameSiegeParty(partyId, name);
      });
    }
  }

  function handleRenameRaid(raidId: string, name: string) {
    setRaids((prev) =>
      prev.map((r) => (r.raidId === raidId ? { ...r, name } : r)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        await renameSiegeRaid(guild, raidId, name);
      });
    }
  }

  function handleSetLeader(raidId: string, userId: string | null) {
    setRaids((prev) =>
      prev.map((r) => (r.raidId === raidId ? { ...r, leaderId: userId } : r)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        const res = await setSiegeRaidLeader(guild, raidId, userId);
        if (res.ok && res.board) setRaids(res.board.raids);
      });
    }
  }

  function applyBoard(board: SiegeBoard | undefined) {
    if (!board) return;
    setParties(board.parties);
    setRaids(board.raids);
  }

  async function handleGenerate() {
    if (!persistenceEnabled || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await generateSiege(guild);
      if (res.ok) {
        applyBoard(res.board);
        if (res.unassignedCount && res.unassignedCount > 0) {
          setNotice(
            `${res.unassignedCount} member${res.unassignedCount === 1 ? "" : "s"} could not be placed — the roster exceeds the ${totalCapacity}-person siege capacity. They are left UNASSIGNED in the pool, not dropped.`,
          );
        }
      } else if (res.message) {
        setNotice(res.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!persistenceEnabled || busy) return;
    if (
      !window.confirm(
        "Reset will clear all UNLOCKED siege slots for this guild (locked members stay). Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      applyBoard((await resetSiege(guild)).board);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetLock() {
    if (!persistenceEnabled || busy) return;
    if (
      !window.confirm(
        "Reset Lock will clear EVERYTHING on this guild's siege board — all assignments, all locks and all raid leaders — leaving a blank board. This cannot be undone. Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      applyBoard((await resetLockSiege(guild)).board);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DndContext
      // Stable explicit id so dnd-kit's aria ids are deterministic SSR↔client
      // (mirrors id="builder-dnd" / "raid-dnd" / "polarity-dnd"). Only one shell
      // renders at once.
      id="siege-dnd"
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <TopNav guild={guild} active="siege" />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MemberPool
            guild={guild}
            members={members}
            assignedIds={assignedIds}
            unavailableIds={unavailableIds}
          />

          <div className="relative flex-1 overflow-y-auto overflow-x-hidden canvas-grid">
            {!persistenceEnabled && (
              <div className="sticky top-0 z-30 border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200 backdrop-blur">
                <strong>Not configured.</strong> Mock data — set{" "}
                <code>MONGODB_URI</code> in <code>.env.local</code> to persist.
              </div>
            )}

            <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-indigo-500/20 bg-[#0c0c1c]/90 px-6 py-2 backdrop-blur">
              <span className="mr-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                {GUILD_LABEL[guild]} siege
              </span>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!persistenceEnabled || busy}
                title={
                  persistenceEnabled
                    ? "Auto-fill unlocked slots — the roster is split evenly across all four raids, Delta Flex included"
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
                title="Clear everything incl. locks and leaders (blank board)"
                className="rounded-md border border-red-400/40 bg-red-950/40 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/40 disabled:opacity-40"
              >
                Reset Lock
              </button>

              <span className="ml-1 rounded bg-indigo-500/15 px-2 py-1 text-xs text-indigo-200 ring-1 ring-indigo-400/30">
                {assignedIds.size}/{totalCapacity} assigned
              </span>
              <span
                className={[
                  "rounded px-2 py-1 text-xs ring-1",
                  overflow > 0
                    ? "bg-amber-500/20 text-amber-200 ring-amber-400/40"
                    : "bg-slate-500/10 text-slate-300 ring-slate-400/20",
                ].join(" ")}
                title={
                  overflow > 0
                    ? `The roster (${members.length}) exceeds the ${totalCapacity}-person siege capacity — the excess stays unassigned.`
                    : "Members of this guild not currently in a siege party."
                }
              >
                {unassignedCount} unassigned
                {overflow > 0 ? ` · ${overflow} over capacity` : ""}
              </span>
              {missingByParty.size > 0 && (
                <span className="rounded bg-amber-500/20 px-2 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-400/40">
                  ⚠ {missingByParty.size}{" "}
                  {missingByParty.size === 1 ? "party" : "parties"} missing
                  required classes
                </span>
              )}
            </div>

            {notice && (
              <div className="mx-6 mt-3 rounded-md border border-amber-400/40 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
                {notice}
              </div>
            )}

            <div className="mx-auto flex max-w-[1500px] flex-col gap-6 p-6">
              {raids.map((raid, i) => (
                <RaidSection
                  key={raid.raidId}
                  raid={raid}
                  first={i === 0}
                  parties={partiesByRaid.get(raid.raidId) ?? []}
                  membersById={membersById}
                  partySize={settings.partySize}
                  missingByParty={missingByParty}
                  unavailableIds={unavailableIds}
                  onRenameRaid={handleRenameRaid}
                  onSetLeader={handleSetLeader}
                  onRenameParty={handleRenameParty}
                  onToggleLock={handleToggleLock}
                  onRemoveMember={removeFromParty}
                  persistenceEnabled={persistenceEnabled}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <DragOverlay>
        {activeMember ? (
          <MemberChip
            member={activeMember}
            instanceId="overlay"
            from="overlay"
            overlay
            unavailable={unavailableIds.has(activeMember.userId)}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// One siege raid: a renameable header with headcount + leader select, then its
// 8 parties in two rows of 4 (SIEGE_CARDS_PER_ROW).
function RaidSection({
  raid,
  first,
  parties,
  membersById,
  partySize,
  missingByParty,
  unavailableIds,
  onRenameRaid,
  onSetLeader,
  onRenameParty,
  onToggleLock,
  onRemoveMember,
  persistenceEnabled,
}: {
  raid: SiegeRaid;
  first: boolean;
  parties: SiegeParty[];
  membersById: Map<string, Member>;
  partySize: number;
  missingByParty: Map<string, string[]>;
  unavailableIds: Set<string>;
  onRenameRaid: (raidId: string, name: string) => void;
  onSetLeader: (raidId: string, userId: string | null) => void;
  onRenameParty: (partyId: string, name: string) => void;
  onToggleLock: (partyId: string, index: number) => void;
  onRemoveMember: (partyId: string, memberId: string) => void;
  persistenceEnabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(raid.name);

  // Delta expects 6 parties; the other three expect all 8. Both numbers are
  // shown when they differ — the expectation is information, not a limit.
  const expectedParties = SIEGE_EXPECTED_PARTY_COUNT[raid.raidKey];
  const hasFlex = expectedParties < parties.length;
  const capacity = siegeRaidCapacity(partySize);
  const expectedCapacity = siegeExpectedCapacity(raid.raidKey, partySize);
  const headcount = parties.reduce((s, p) => s + p.memberIds.length, 0);

  // Eligible leaders = the deduped union of this raid's parties' members, in
  // party order then slot order (deterministic). Matches exactly what
  // setSiegeRaidLeader validates against on the server.
  const eligible: Member[] = [];
  const seen = new Set<string>();
  for (const p of parties) {
    for (const id of p.memberIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = membersById.get(id);
      if (m) eligible.push(m);
    }
  }
  // Defensive: a stale leaderId renders as unset rather than a stale name.
  const leaderIsValid =
    typeof raid.leaderId === "string" && seen.has(raid.leaderId);
  const currentLeaderId = leaderIsValid ? (raid.leaderId as string) : "";

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== raid.name) onRenameRaid(raid.raidId, next);
    else setDraft(raid.name);
  }

  return (
    <section>
      {!first && (
        <div className="mb-6 h-px w-full bg-gradient-to-r from-transparent via-fuchsia-400/40 to-transparent" />
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={
            hasFlex
              ? "h-3 w-3 rounded-full bg-emerald-400"
              : "h-3 w-3 rounded-full bg-sky-400"
          }
          aria-hidden
        />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(raid.name);
                setEditing(false);
              }
            }}
            disabled={!persistenceEnabled}
            className="rounded border border-indigo-400/40 bg-[#0c0c1c] px-2 py-1 text-lg font-bold text-slate-100"
          />
        ) : (
          <button
            type="button"
            onClick={() => persistenceEnabled && setEditing(true)}
            title={persistenceEnabled ? "Rename raid" : "Needs MONGODB_URI"}
            className="text-lg font-bold tracking-wide text-slate-100 hover:text-indigo-200"
          >
            {raid.name}
          </button>
        )}
        {hasFlex && (
          <span
            className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200 uppercase ring-1 ring-emerald-400/40"
            title={`Normally runs ${expectedParties} parties. Parties ${expectedParties + 1}-${parties.length} are flex overflow — dimmed, but fully usable and nothing stops you filling them.`}
          >
            flex
          </span>
        )}
        <span className="text-xs font-normal text-slate-400">
          {parties.length} parties · {headcount}/{capacity}
          {hasFlex ? ` · ${expectedParties} expected (${expectedCapacity})` : ""}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="shrink-0 text-[11px] font-semibold tracking-wide text-amber-300/90 uppercase"
            title="The raid leader — one per raid, must be a member of one of this raid's parties."
          >
            Leader
          </span>
          <select
            value={currentLeaderId}
            onChange={(e) => onSetLeader(raid.raidId, e.target.value || null)}
            disabled={!persistenceEnabled || eligible.length === 0}
            title={
              !persistenceEnabled
                ? "Needs MONGODB_URI"
                : eligible.length === 0
                  ? "Assign members to this raid first"
                  : "Choose a raid leader"
            }
            className="w-48 truncate rounded border border-amber-400/30 bg-[#0c0c1c] px-1.5 py-1 text-xs text-slate-100 disabled:opacity-40"
          >
            <option value="">No leader</option>
            {eligible.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(${SIEGE_CARDS_PER_ROW}, minmax(0, 1fr))`,
        }}
      >
        {parties.map((p) => {
          const flex = isFlexParty(p.raidKey, p.position);
          // The flex treatment is a WRAPPER, not a variant of PartyCard: the
          // card is shared with two live features and adding a Siege-only prop
          // to it buys nothing. Dimmed until hovered, dashed outline, corner
          // tag — the card underneath behaves identically to every other.
          return (
            <div
              key={p.partyId}
              className={
                flex
                  ? "relative rounded-xl transition-opacity duration-150 opacity-55 hover:opacity-100 focus-within:opacity-100"
                  : "relative"
              }
              // Inline so the dashed ring is unambiguous regardless of which
              // outline utilities the Tailwind build emits.
              style={
                flex
                  ? {
                      outline: "1px dashed rgba(148, 163, 184, 0.45)",
                      outlineOffset: "3px",
                    }
                  : undefined
              }
            >
              {flex && (
                <span
                  className="pointer-events-none absolute -top-2 right-2 z-10 rounded bg-[#0c0c1c] px-1.5 py-px text-[9px] font-semibold tracking-wider text-slate-300 uppercase ring-1 ring-slate-400/40"
                  title="Flex party — overflow beyond this raid's expected size. Fully usable."
                >
                  flex
                </span>
              )}
              <PartyCard
                party={p}
                membersById={membersById}
                partySize={partySize}
                onRename={onRenameParty}
                onToggleLock={onToggleLock}
                onRemoveMember={onRemoveMember}
                persistenceEnabled={persistenceEnabled}
                missing={missingByParty.get(p.partyId) ?? []}
                unavailableIds={unavailableIds}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
