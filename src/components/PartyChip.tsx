"use client";

import { useDraggable } from "@dnd-kit/core";
import { MAX_PARTY_SLOTS, type Party } from "@/lib/types";

// A draggable chip representing a PARTY (the unit dragged into raid groups).
// Shows the party name + member count, and a ⚠ if it has members but no Priest.
// `instanceId` keeps the same party uniquely identifiable across the pool and
// any raid group it sits in, so dnd-kit never sees duplicate draggable ids.

export interface PartyDragData {
  kind: "party";
  partyId: string;
  field: Party["field"];
  from: string; // "pool:<field>" | raidGroupId
}

export function PartyChip({
  party,
  instanceId,
  from,
  noPriest,
  overlay = false,
}: {
  party: Party;
  instanceId: string;
  from: string;
  noPriest: boolean;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: instanceId,
    data: {
      kind: "party",
      partyId: party.partyId,
      field: party.field,
      from,
    } satisfies PartyDragData,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={[
        "flex cursor-grab touch-none items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm select-none active:cursor-grabbing",
        noPriest
          ? "border-amber-400/50 bg-amber-950/20"
          : "border-indigo-400/30 bg-indigo-950/60",
        "text-slate-100 backdrop-blur-sm",
        isDragging && !overlay ? "opacity-30" : "",
        overlay ? "neon-edge-strong scale-105" : "hover:border-indigo-300/60",
      ].join(" ")}
    >
      <span className="font-medium">{party.name}</span>
      <span className="rounded bg-indigo-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-200">
        {party.memberIds.length}/{MAX_PARTY_SLOTS}
      </span>
      {noPriest && (
        <span
          className="text-[11px] text-amber-300"
          title="Has members but no Priest"
        >
          ⚠
        </span>
      )}
    </div>
  );
}
