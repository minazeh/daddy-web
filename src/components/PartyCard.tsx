"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { type Member, type Party } from "@/lib/types";
import { MemberChip } from "./MemberChip";

// A party card in the fixed field grid (no free repositioning).
// - The HEADER shows the (renameable) party name + member count.
// - Each filled SLOT holds a draggable member chip plus lock + remove controls.
// - Each EMPTY slot is a droppable target with a "drop here" placeholder.
// A locked slot can't be overwritten by a drop (enforced in BuilderShell).

function Slot({
  partyId,
  index,
  member,
  locked,
  onToggleLock,
  onRemove,
}: {
  partyId: string;
  index: number;
  member: Member | null;
  locked: boolean;
  onToggleLock: (index: number) => void;
  onRemove: (memberId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot:${partyId}:${index}`,
    data: { kind: "slot", partyId, slotIndex: index },
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        "rounded-lg border p-1.5 transition-colors",
        member
          ? "border-indigo-400/30 bg-indigo-950/40"
          : "border-dashed border-indigo-400/25 bg-indigo-950/20",
        isOver && !locked ? "border-fuchsia-400/80 bg-fuchsia-500/15" : "",
        isOver && locked ? "border-red-400/70 bg-red-500/10" : "",
      ].join(" ")}
    >
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="text-[9px] font-semibold tracking-wider text-indigo-300/70 uppercase">
          Slot {index + 1}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onToggleLock(index)}
            title={locked ? "Unlock slot" : "Lock slot"}
            className={[
              "rounded px-1 text-[11px] leading-none",
              locked
                ? "text-amber-300"
                : "text-slate-500 hover:text-slate-300",
            ].join(" ")}
          >
            {locked ? "🔒" : "🔓"}
          </button>
          {member && (
            <button
              type="button"
              onClick={() => onRemove(member.userId)}
              title="Remove from slot"
              className="rounded px-1 text-[11px] leading-none text-slate-500 hover:text-red-400"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {member ? (
        <MemberChip
          member={member}
          instanceId={`${partyId}:${member.userId}`}
          from={partyId}
          compact
          locked={locked}
        />
      ) : (
        <div className="flex items-center justify-center px-2 py-2 text-[11px] text-indigo-300/40">
          {locked ? "locked" : "drop here"}
        </div>
      )}
    </div>
  );
}

export function PartyCard({
  party,
  membersById,
  partySize,
  onRename,
  onToggleLock,
  onRemoveMember,
  persistenceEnabled,
  missing = [],
}: {
  party: Party;
  membersById: Map<string, Member>;
  partySize: number;
  onRename: (partyId: string, name: string) => void;
  onToggleLock: (partyId: string, index: number) => void;
  onRemoveMember: (partyId: string, memberId: string) => void;
  persistenceEnabled: boolean;
  // Required classNames this party is currently MISSING (empty = meets all).
  missing?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(party.name);

  const lockedSet = new Set(party.lockedSlots);
  // Defensive lookup: if a memberId has no record in the current roster (a
  // departed member not yet pruned by the server-side reconcile), render the
  // slot as empty rather than a broken chip. The prune (data.ts) is the primary
  // mechanism that removes such ids; this guard just avoids any crash window.
  const slots: (Member | null)[] = Array.from({ length: partySize }, (_, i) => {
    const id = party.memberIds[i];
    return id ? membersById.get(id) ?? null : null;
  });

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== party.name) onRename(party.partyId, next);
    else setDraft(party.name);
  }

  const hasMissing = missing.length > 0;

  return (
    <div
      className={[
        "neon-edge w-full rounded-xl border p-2.5",
        hasMissing
          ? "bg-gradient-to-b from-rose-950 to-red-950 border-red-500/70"
          : "bg-gradient-to-b from-[#161634] to-[#10101f] border-indigo-400/30",
      ].join(" ")}
    >
      {hasMissing && (
        <div
          className="mb-2 flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-400/40"
          title={`Missing required class(es): ${missing.join(", ")}`}
        >
          ⚠ missing: {missing.join(", ")}
        </div>
      )}
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-indigo-500/10 px-2 py-1.5">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(party.name);
                setEditing(false);
              }
            }}
            disabled={!persistenceEnabled}
            className="w-full rounded border border-indigo-400/40 bg-[#0c0c1c] px-1.5 py-0.5 text-sm text-slate-100"
          />
        ) : (
          <button
            type="button"
            onClick={() => persistenceEnabled && setEditing(true)}
            title={persistenceEnabled ? "Rename party" : "Renaming needs MONGODB_URI"}
            className="truncate text-sm font-bold text-slate-100 hover:text-indigo-200"
          >
            {party.name}
          </button>
        )}
        <span className="rounded bg-indigo-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-200">
          {party.memberIds.length}/{partySize}
        </span>
      </div>

      <div className="space-y-1.5">
        {slots.map((m, i) => (
          <Slot
            key={i}
            partyId={party.partyId}
            index={i}
            member={m}
            locked={lockedSet.has(i)}
            onToggleLock={(idx) => onToggleLock(party.partyId, idx)}
            onRemove={(memberId) => onRemoveMember(party.partyId, memberId)}
          />
        ))}
      </div>
    </div>
  );
}
