"use client";

import { useMemo, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  FIELDS,
  FIELD_LABEL,
  partyHasPriest,
  type Field,
  type Guild,
  type Member,
  type Party,
  type RaidGroup,
} from "@/lib/types";
import {
  assignPartyToRaid,
  createRaidGroup,
  deleteRaidGroup,
  removePartyFromRaid,
  renameRaidGroup,
  setRaidLeader,
} from "@/lib/actions";
import { PartyChip, type PartyDragData } from "./PartyChip";
import { RaidGroupCard } from "./RaidGroupCard";
import { TopNav } from "./TopNav";

// The Raid Groups builder for ONE guild: drag PARTIES into raid groups. Scoped
// per guild AND per field (Main raid groups hold Main parties, Sub holds Sub —
// never cross). A party is in AT MOST ONE raid group within its field. Plain
// vertical scroll (no zoom/pan), one DndContext with a STABLE id, deterministic
// ordering, optimistic UI with immediate auto-save. The parent re-mounts this
// (key={guild}) on toggle, so no state crosses the Daddy/Mummy boundary.

const POOL_PREFIX = "raidpool";

export function RaidShell({
  guild,
  members,
  parties,
  raidGroups: initialRaids,
  persistenceEnabled,
}: {
  guild: Guild;
  members: Member[];
  parties: Party[];
  raidGroups: RaidGroup[];
  persistenceEnabled: boolean;
}) {
  const [raids, setRaids] = useState<RaidGroup[]>(initialRaids);
  const [activeParty, setActiveParty] = useState<Party | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const membersById = useMemo(() => {
    const m = new Map<string, Member>();
    for (const x of members) m.set(x.userId, x);
    return m;
  }, [members]);

  const partiesById = useMemo(() => {
    const m = new Map<string, Party>();
    for (const p of parties) m.set(p.partyId, p);
    return m;
  }, [parties]);

  // Raid groups split by field, deterministically ordered.
  const raidsByField = useMemo(() => {
    const groups: Record<Field, RaidGroup[]> = { main: [], sub: [] };
    for (const r of raids) groups[r.field].push(r);
    for (const f of FIELDS) {
      groups[f].sort((a, b) =>
        a.position !== b.position
          ? a.position - b.position
          : a.raidGroupId.localeCompare(b.raidGroupId),
      );
    }
    return groups;
  }, [raids]);

  // Set of party ids assigned to ANY raid group (used to compute the pools).
  const assignedPartyIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of raids) for (const id of r.partyIds) s.add(id);
    return s;
  }, [raids]);

  // Unassigned parties per field = field's parties not in any raid group.
  const poolByField = useMemo(() => {
    const groups: Record<Field, Party[]> = { main: [], sub: [] };
    for (const p of parties) {
      if (!assignedPartyIds.has(p.partyId)) groups[p.field].push(p);
    }
    for (const f of FIELDS) groups[f].sort((a, b) => a.position - b.position);
    return groups;
  }, [parties, assignedPartyIds]);

  function refresh(res: { ok: boolean; raidGroups?: RaidGroup[] }) {
    if (res.ok && res.raidGroups) setRaids(res.raidGroups);
  }

  // ---- drag lifecycle ----
  function handleDragStart(e: DragStartEvent) {
    const d = e.active.data.current as PartyDragData | undefined;
    if (d?.kind === "party") setActiveParty(partiesById.get(d.partyId) ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    const d = e.active.data.current as PartyDragData | undefined;
    setActiveParty(null);
    if (!d || !e.over) return;

    const over = e.over.data.current as
      | { kind?: string; raidGroupId?: string; field?: Field }
      | undefined;

    // Dropped onto a pool → remove from its raid group (back to unassigned).
    if (over?.kind === "pool" || String(e.over.id).startsWith(POOL_PREFIX)) {
      // Only meaningful if it came from a raid group, and same field.
      if (d.from === "pool" || String(d.from).startsWith("pool")) return;
      if (over?.field && over.field !== d.field) return; // never cross fields
      removeFromRaid(d.partyId);
      return;
    }

    // Dropped onto a raid group → assign/move (same field only).
    if (over?.kind === "raid" && over.raidGroupId) {
      if (over.field && over.field !== d.field) return; // never cross fields
      const target = raids.find((r) => r.raidGroupId === over.raidGroupId);
      if (!target || target.field !== d.field) return;
      if (target.partyIds.includes(d.partyId)) return; // already there
      assignToRaid(d.partyId, over.raidGroupId, d.field);
    }
  }

  // ---- mutations (optimistic local update + server persist) ----
  function assignToRaid(partyId: string, raidGroupId: string, field: Field) {
    // Optimistic: remove from any same-field raid, add to target.
    setRaids((prev) =>
      prev.map((r) => {
        if (r.field !== field) return r;
        if (r.raidGroupId === raidGroupId) {
          return r.partyIds.includes(partyId)
            ? r
            : { ...r, partyIds: [...r.partyIds, partyId] };
        }
        return r.partyIds.includes(partyId)
          ? { ...r, partyIds: r.partyIds.filter((id) => id !== partyId) }
          : r;
      }),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        refresh(await assignPartyToRaid(guild, partyId, raidGroupId));
      });
    }
  }

  function removeFromRaid(partyId: string) {
    setRaids((prev) =>
      prev.map((r) =>
        r.partyIds.includes(partyId)
          ? { ...r, partyIds: r.partyIds.filter((id) => id !== partyId) }
          : r,
      ),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        refresh(await removePartyFromRaid(guild, partyId));
      });
    }
  }

  async function handleAdd(field: Field) {
    if (busy) return;
    setBusy(true);
    try {
      refresh(await createRaidGroup(guild, field));
    } finally {
      setBusy(false);
    }
  }

  function handleRename(raidGroupId: string, name: string) {
    setRaids((prev) =>
      prev.map((r) => (r.raidGroupId === raidGroupId ? { ...r, name } : r)),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        refresh(await renameRaidGroup(guild, raidGroupId, name));
      });
    }
  }

  // Set/clear a raid group's leader (optimistic local update + persist), wired
  // exactly like handleRename. `userId === null` clears the leader.
  function handleSetLeader(raidGroupId: string, userId: string | null) {
    setRaids((prev) =>
      prev.map((r) =>
        r.raidGroupId === raidGroupId ? { ...r, leaderId: userId } : r,
      ),
    );
    if (persistenceEnabled) {
      startTransition(async () => {
        refresh(await setRaidLeader(guild, raidGroupId, userId));
      });
    }
  }

  async function handleDelete(raidGroupId: string) {
    if (
      !window.confirm(
        "Delete this raid group? Its parties return to the unassigned pool (parties and members are not deleted).",
      )
    )
      return;
    // Optimistic remove (its parties reappear in the pool automatically).
    setRaids((prev) => prev.filter((r) => r.raidGroupId !== raidGroupId));
    if (persistenceEnabled) {
      startTransition(async () => {
        refresh(await deleteRaidGroup(guild, raidGroupId));
      });
    }
  }

  return (
    <DndContext
      // Stable id so dnd-kit's aria ids are deterministic SSR↔client (mirrors
      // the builder's id="builder-dnd" fix). Only one RaidShell renders at once.
      id="raid-dnd"
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <TopNav guild={guild} active="raid" />

        {!persistenceEnabled && (
          <div className="border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200">
            <strong>Not configured.</strong> Mock data (in-memory) — set{" "}
            <code>MONGODB_URI</code> in <code>.env.local</code> to persist.
          </div>
        )}

        {/* Scrollable board: two field sections stacked. */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden canvas-grid">
          <div className="mx-auto flex max-w-[1500px] flex-col gap-8 p-6">
            {FIELDS.map((field, fi) => (
              <FieldSection
                key={field}
                field={field}
                first={fi === 0}
                pool={poolByField[field]}
                raids={raidsByField[field]}
                partiesById={partiesById}
                membersById={membersById}
                onAdd={() => handleAdd(field)}
                onRename={handleRename}
                onDelete={handleDelete}
                onSetLeader={handleSetLeader}
                persistenceEnabled={persistenceEnabled}
                busy={busy}
              />
            ))}
          </div>
        </div>
      </div>

      <DragOverlay>
        {activeParty ? (
          <PartyChip
            party={activeParty}
            instanceId="overlay"
            from="overlay"
            overlay
            noPriest={
              activeParty.memberIds.length > 0 &&
              !partyHasPriest(activeParty, membersById)
            }
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// One field section: its unassigned-party pool (a droppable) + its raid groups
// + an "Add Raid Group" button. Main above, Sub below, with a divider.
function FieldSection({
  field,
  first,
  pool,
  raids,
  partiesById,
  membersById,
  onAdd,
  onRename,
  onDelete,
  onSetLeader,
  persistenceEnabled,
  busy,
}: {
  field: Field;
  first: boolean;
  pool: Party[];
  raids: RaidGroup[];
  partiesById: Map<string, Party>;
  membersById: Map<string, Member>;
  onAdd: () => void;
  onRename: (raidGroupId: string, name: string) => void;
  onDelete: (raidGroupId: string) => void;
  onSetLeader: (raidGroupId: string, userId: string | null) => void;
  persistenceEnabled: boolean;
  busy: boolean;
}) {
  // Pool droppable; the field is carried in its data so drops never cross
  // fields (handleDragEnd checks over.field === drag.field).
  const { setNodeRef, isOver } = useDroppable({
    id: `${POOL_PREFIX}:${field}`,
    data: { kind: "pool", field },
  });

  return (
    <section>
      {!first && (
        <div className="mb-8 h-px w-full bg-gradient-to-r from-transparent via-fuchsia-400/40 to-transparent" />
      )}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold tracking-wide text-slate-100">
          <span
            className={
              field === "main"
                ? "h-3 w-3 rounded-full bg-sky-400"
                : "h-3 w-3 rounded-full bg-fuchsia-400"
            }
            aria-hidden
          />
          {FIELD_LABEL[field]}
        </h2>
        <button
          type="button"
          onClick={onAdd}
          disabled={!persistenceEnabled || busy}
          className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-3 py-1.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
        >
          + Add Raid Group
        </button>
      </div>

      {/* Unassigned-party pool (droppable: drop here to remove from a raid). */}
      <div
        ref={setNodeRef}
        className={[
          "mb-4 flex min-h-[56px] flex-wrap gap-2 rounded-lg border p-3 transition-colors",
          isOver
            ? "border-fuchsia-400/70 bg-fuchsia-500/10"
            : "border-indigo-400/20 bg-indigo-950/20",
        ].join(" ")}
      >
        <span className="mr-1 self-center text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
          Unassigned ({pool.length})
        </span>
        {pool.length === 0 ? (
          <span className="self-center text-xs text-slate-500">
            All {field} parties are in a raid group.
          </span>
        ) : (
          pool.map((p) => (
            <PartyChip
              key={p.partyId}
              party={p}
              instanceId={`pool:${p.partyId}`}
              from="pool"
              noPriest={
                p.memberIds.length > 0 && !partyHasPriest(p, membersById)
              }
            />
          ))
        )}
      </div>

      {/* Raid groups for this field. */}
      {raids.length === 0 ? (
        <p className="rounded-lg border border-dashed border-indigo-400/30 px-4 py-5 text-center text-sm text-slate-400">
          No raid groups yet. Click “+ Add Raid Group”.
        </p>
      ) : (
        <div className="flex flex-wrap gap-4">
          {raids.map((r) => (
            <RaidGroupCard
              key={r.raidGroupId}
              raid={r}
              partiesById={partiesById}
              membersById={membersById}
              onRename={onRename}
              onDelete={onDelete}
              onSetLeader={onSetLeader}
              persistenceEnabled={persistenceEnabled}
            />
          ))}
        </div>
      )}
    </section>
  );
}
