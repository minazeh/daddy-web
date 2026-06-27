"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { MAX_PARTY_SLOTS, type Member, type Party } from "@/lib/types";
import { MemberChip, GuildBadge } from "./MemberChip";

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
  onRename,
  onToggleLock,
  onRemoveMember,
  persistenceEnabled,
  noHealer = false,
}: {
  party: Party;
  membersById: Map<string, Member>;
  onRename: (partyId: string, name: string) => void;
  onToggleLock: (partyId: string, index: number) => void;
  onRemoveMember: (partyId: string, memberId: string) => void;
  persistenceEnabled: boolean;
  noHealer?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(party.name);

  const lockedSet = new Set(party.lockedSlots);
  const slots: (Member | null)[] = Array.from(
    { length: MAX_PARTY_SLOTS },
    (_, i) => {
      const id = party.memberIds[i];
      return id ? membersById.get(id) ?? null : null;
    },
  );

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== party.name) onRename(party.partyId, next);
    else setDraft(party.name);
  }

  return (
    <div
      className={[
        "neon-edge w-full rounded-xl border bg-gradient-to-b from-[#161634] to-[#10101f] p-2.5",
        noHealer ? "border-amber-400/60" : "border-indigo-400/30",
      ].join(" ")}
    >
      {noHealer && (
        <div
          className="mb-2 flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-400/40"
          title="No Priest could be assigned — healer pool exhausted"
        >
          ⚠ No Priest
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
          {party.memberIds.length}/{MAX_PARTY_SLOTS}
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

// Re-export so BuilderShell's DragOverlay can show a member badge if needed.
export { GuildBadge };
