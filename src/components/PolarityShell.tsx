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
  HEALER_CLASS,
  missingRequiredClasses,
  type Guild,
  type Member,
  type Settings,
} from "@/lib/types";
import {
  POLARITY_CARDS_PER_ROW,
  POLARITY_PARTY_COUNT,
  POLARITY_RAID_COUNT,
  polarityTotalCapacity,
  type PolarityParty,
  type PolarityRaid,
} from "@/lib/polarity";
import type { PolarityBoard } from "@/lib/polarity-data";
import {
  generatePolarity,
  renamePolarityParty,
  renamePolarityRaid,
  resetLockPolarity,
  resetPolarity,
  setPolarityPartyLocks,
  setPolarityRaidLeader,
  updatePolarityParty,
} from "@/lib/polarity-actions";
import { MemberPool, POOL_ID } from "./MemberPool";
import { RankingImportModal } from "./RankingImportModal";
import { PartyCard } from "./PartyCard";
import { MemberChip, type DragData } from "./MemberChip";
import { TopNav } from "./TopNav";

// The Polarity Raids builder for ONE guild. A SECOND, independent raid layout
// that sits alongside the GvG main/sub board and shares none of its data:
//   2 main raids   x 5 parties  — ranked by the IMPORTED DPS ranking
//   4 normal raids x 5 parties  — everyone else by POWER, split evenly
// Six raids of 25 seats each = 150 per guild. EVERY party on the board — main
// and normal alike — is guaranteed a Priest: no party gets a second while any
// party still lacks a first. Once every party has one and the other classes run
// out, a surplus Priest may take an EMPTY seat rather than sit in the pool
// while the board shows a hole (Conrad, 2026-09-20).
//
// "Import DPS ranking" opens the paste-in importer for the game's ranking
// board. It writes to the web-owned `polarityDps` collection only — never to
// `memberMeta.power`, so the leaderboard, the GvG builder and Siege are
// untouched by it. A member with no imported row cannot enter a main raid.
//
// Interaction mirrors the GvG builder exactly: one DndContext, drag members
// between the pool and any slot, swap on an occupied slot, per-slot locking,
// party rename — every change auto-saves immediately via a server action. The
// parent re-mounts this (key={guild}) on toggle, so no state crosses the
// Daddy/Mummy boundary.

// The 10 main parties (2 raids x 5) the DPS pass seeds one priest into each of.
const MAIN_PARTY_TOTAL =
  POLARITY_RAID_COUNT.main * POLARITY_PARTY_COUNT.main;

// The 20 normal parties (4 raids x 5) the power pass seeds a priest into.
const NORMAL_PARTY_TOTAL =
  POLARITY_RAID_COUNT.normal * POLARITY_PARTY_COUNT.normal;

// Every party on the board — 30 at the current shape.
const BOARD_PARTY_TOTAL = MAIN_PARTY_TOTAL + NORMAL_PARTY_TOTAL;

// The priest rule the POLARITY generator hardwires. It is deliberately NOT
// read from `settings.requiredClasses` — that setting is empty in production
// and shared with the GvG builder — so the live badge has to state it here too
// or the board would silently disagree with what Generate just did.
//
// `min: 1` is a FLOOR, not a quota, and that is still the truth after the
// spare-seat relaxation: the badge fires when a party has NO Priest, and stays
// quiet when a party has two because the rule was never "exactly one", it was
// "at least one". Nothing here needed changing — it was checked, not assumed.
const POLARITY_REQUIRED_CLASSES = [{ className: HEALER_CLASS, min: 1 }];

export function PolarityShell({
  guild,
  members,
  board: initialBoard,
  settings,
  unavailableIds,
  persistenceEnabled,
}: {
  guild: Guild;
  members: Member[];
  board: PolarityBoard;
  settings: Settings;
  unavailableIds: Set<string>;
  persistenceEnabled: boolean;
}) {
  const [parties, setParties] = useState<PolarityParty[]>(initialBoard.parties);
  const [raids, setRaids] = useState<PolarityRaid[]>(initialBoard.raids);
  const [activeMember, setActiveMember] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
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
  // manual drag clears the badge immediately. Same helper the GvG board uses.
  //
  // The requirement list is the UNION of whatever Settings asks for and the
  // Priest the polarity generator hardwires, so dragging the only Priest out of
  // a party flags it straight away even though `settings.requiredClasses` is
  // empty.
  const required = useMemo(() => {
    const out = [...settings.requiredClasses];
    if (!out.some((rc) => rc.className === HEALER_CLASS)) {
      out.push(...POLARITY_REQUIRED_CLASSES);
    }
    return out;
  }, [settings.requiredClasses]);

  const missingByParty = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of parties) {
      if (p.memberIds.length === 0) continue;
      const miss = missingRequiredClasses(p, membersById, required);
      if (miss.length > 0) m.set(p.partyId, miss);
    }
    return m;
  }, [parties, membersById, required]);

  // Parties grouped by raid, in each raid's party order.
  const partiesByRaid = useMemo(() => {
    const groups = new Map<string, PolarityParty[]>();
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

  const totalCapacity = polarityTotalCapacity(settings.partySize);
  const unassignedCount = members.filter(
    (m) => !assignedIds.has(m.userId),
  ).length;
  const overflow = Math.max(0, members.length - totalCapacity);

  // ---- persistence helpers (each fires immediately; no save button) ----
  function persistMembers(partyId: string, memberIds: string[]) {
    if (!persistenceEnabled) return;
    startTransition(async () => {
      await updatePolarityParty(partyId, memberIds);
    });
  }
  function persistLocks(partyId: string, lockedSlots: number[]) {
    if (!persistenceEnabled) return;
    startTransition(async () => {
      await setPolarityPartyLocks(partyId, lockedSlots);
    });
  }

  // ---- drag lifecycle (identical contract to the GvG builder) ----
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
        await renamePolarityParty(partyId, name);
      });
    }
  }

  function handleRenameRaid(raidId: string, name: string) {
    setRaids((prev) =>
      prev.map((r) => (r.raidId === raidId ? { ...r, name } : r)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        await renamePolarityRaid(guild, raidId, name);
      });
    }
  }

  function handleSetLeader(raidId: string, userId: string | null) {
    setRaids((prev) =>
      prev.map((r) => (r.raidId === raidId ? { ...r, leaderId: userId } : r)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        const res = await setPolarityRaidLeader(guild, raidId, userId);
        if (res.ok && res.board) setRaids(res.board.raids);
      });
    }
  }

  function applyBoard(board: PolarityBoard | undefined) {
    if (!board) return;
    setParties(board.parties);
    setRaids(board.raids);
  }

  async function handleGenerate() {
    if (!persistenceEnabled || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await generatePolarity(guild);
      if (res.ok) {
        applyBoard(res.board);
        // Say out loud what the DPS pass did and did not do. Silence here would
        // hide the two things most likely to surprise: members barred from the
        // main raids for having no imported row at all, and main parties left
        // without a priest because the ranking had fewer than ten.
        const lines: string[] = [];
        const missingPriest = res.mainPartiesMissingPriest ?? [];
        if ((res.dpsEligibleCount ?? 0) === 0) {
          lines.push(
            "No imported DPS rows for this guild — the two main raids could not be filled. Use “Import DPS ranking” first.",
          );
        }
        if (res.noDpsCount && res.noDpsCount > 0) {
          lines.push(
            `${res.noDpsCount} member${res.noDpsCount === 1 ? " has" : "s have"} no imported DPS row, so ${res.noDpsCount === 1 ? "they were" : "they were"} not eligible for a main raid and went to the normal raids instead.`,
          );
        }
        if (missingPriest.length > 0) {
          lines.push(
            `${missingPriest.length} main part${missingPriest.length === 1 ? "y has" : "ies have"} no Priest — the ranking had ${res.mainPriestsSeeded ?? 0} priest${(res.mainPriestsSeeded ?? 0) === 1 ? "" : "s"} for ${MAIN_PARTY_TOTAL} main parties.`,
          );
        }
        const normalMissingPriest = res.normalPartiesMissingPriest ?? [];
        if (normalMissingPriest.length > 0) {
          lines.push(
            `${normalMissingPriest.length} normal part${normalMissingPriest.length === 1 ? "y has" : "ies have"} no Priest — the roster ran out. They are filled with other classes and flagged, not left empty.`,
          );
        }
        // A surplus priest taking a SECOND seat in a party is the one thing on
        // this board that contradicts the headline rule, so it is said out
        // loud rather than left for Conrad to spot in the cards.
        const spare = res.sparePriestsSeated ?? 0;
        if (spare > 0) {
          lines.push(
            `${spare} surplus Priest${spare === 1 ? "" : "s"} took an empty seat as a party's second Priest — every one of the ${BOARD_PARTY_TOTAL} parties already had its first, and the other classes ran out before the seats did.`,
          );
        }
        // What is left after that really is unplaceable: every party has a
        // priest AND the board is full. Members sitting unassigned while seats
        // are open is no longer possible, so the wording no longer claims it.
        const surplus = res.surplusPriestCount ?? 0;
        if (surplus > 0) {
          lines.push(
            `${surplus} Priest${surplus === 1 ? "" : "s"} stayed in the pool — all ${BOARD_PARTY_TOTAL} parties have one and there was no empty seat left. Swap ${surplus === 1 ? "them" : "them"} in by hand if you want ${surplus === 1 ? "them" : "them"} on the board.`,
          );
        }
        if (res.unassignedCount && res.unassignedCount > 0) {
          const other = res.unassignedCount - surplus;
          if (other > 0) {
            lines.push(
              `${other} other member${other === 1 ? "" : "s"} could not be placed against the ${totalCapacity}-person capacity. They are left UNASSIGNED in the pool, not dropped.`,
            );
          }
        }
        setNotice(lines.length > 0 ? lines.join(" ") : null);
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
        "Reset will clear all UNLOCKED polarity slots for this guild (locked members stay). Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      applyBoard((await resetPolarity(guild)).board);
    } finally {
      setBusy(false);
    }
  }

  async function handleResetLock() {
    if (!persistenceEnabled || busy) return;
    if (
      !window.confirm(
        "Reset Lock will clear EVERYTHING on this guild's polarity board — all assignments, all locks and all raid leaders — leaving a blank board. This cannot be undone. Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      applyBoard((await resetLockPolarity(guild)).board);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DndContext
      // Stable explicit id so dnd-kit's aria ids are deterministic SSR↔client
      // (mirrors id="builder-dnd" / "raid-dnd"). Only one shell renders at once.
      id="polarity-dnd"
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <TopNav guild={guild} active="polarity" />
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
                {GUILD_LABEL[guild]} polarity
              </span>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!persistenceEnabled || busy}
                title={
                  persistenceEnabled
                    ? "Auto-fill unlocked slots — the imported DPS ranking fills the 2 main raids, the rest split evenly across the 4 normal raids by power. Every party gets a Priest first; only then may a surplus Priest take a seat that would otherwise stay empty."
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
              <button
                type="button"
                onClick={() => setImporting(true)}
                disabled={!persistenceEnabled || busy}
                title={
                  persistenceEnabled
                    ? "Paste the game's DPS ranking board — it drives the two main raids. Preview first; nothing is saved until you apply."
                    : "Needs MONGODB_URI"
                }
                className="rounded-md border border-fuchsia-400/40 bg-fuchsia-950/40 px-3 py-1.5 text-sm font-medium text-fuchsia-100 hover:bg-fuchsia-900/50 disabled:opacity-40"
              >
                Import DPS ranking
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
                    ? `The roster (${members.length}) exceeds the ${totalCapacity}-person polarity capacity — the excess stays unassigned.`
                    : "Members of this guild not currently in a polarity party."
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

      {importing && (
        <RankingImportModal
          guild={guild}
          onClose={() => setImporting(false)}
          onApplied={(updated) =>
            setNotice(
              `Imported ${updated} DPS row${updated === 1 ? "" : "s"}. Press Generate to rebuild the two main raids from the new ranking.`,
            )
          }
        />
      )}

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

// One raid group: a renameable header with its kind badge, headcount, leader
// select, then its parties in a 5-per-row grid of the shared PartyCard.
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
  raid: PolarityRaid;
  first: boolean;
  parties: PolarityParty[];
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

  const isMain = raid.kind === "main";
  const capacity = POLARITY_PARTY_COUNT[raid.kind] * partySize;
  const headcount = parties.reduce((s, p) => s + p.memberIds.length, 0);

  // Eligible leaders = the deduped union of this raid's parties' members, in
  // party order then slot order (deterministic).
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
            isMain
              ? "h-3 w-3 rounded-full bg-amber-400"
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
        <span
          className={[
            "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1",
            isMain
              ? "bg-amber-500/15 text-amber-200 ring-amber-400/40"
              : "bg-sky-500/15 text-sky-200 ring-sky-400/40",
          ].join(" ")}
          title={
            isMain
              ? "DPS ranking cohort — the two main raids take the highest imported DPS, a Priest in every party. A member with no imported row cannot be here."
              : "Normal raid — the remaining members are split evenly across the four, ranked by power, a Priest in every party. A surplus Priest fills an empty seat only after the other classes run out."
          }
        >
          {isMain ? "top DPS" : "normal"}
        </span>
        <span className="text-xs font-normal text-slate-400">
          {parties.length} parties · {headcount}/{capacity}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="shrink-0 text-[11px] font-semibold tracking-wide text-amber-300/90 uppercase"
            title="The raid leader — must be a member of one of this raid's parties."
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
          gridTemplateColumns: `repeat(${POLARITY_CARDS_PER_ROW}, minmax(0, 1fr))`,
        }}
      >
        {parties.map((p) => (
          <PartyCard
            key={p.partyId}
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
        ))}
      </div>
    </section>
  );
}
