"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { Member, Party, RaidGroup } from "@/lib/types";
import { partyHasPriest } from "@/lib/types";
import { PartyChip } from "./PartyChip";

// A raid group: a droppable container you drag PARTY chips into. Editable name +
// delete button (delete frees its parties back to the pool — handled in
// RaidShell). No cap on parties per group.

export function RaidGroupCard({
  raid,
  partiesById,
  membersById,
  onRename,
  onDelete,
  persistenceEnabled,
}: {
  raid: RaidGroup;
  partiesById: Map<string, Party>;
  membersById: Map<string, Member>;
  onRename: (raidGroupId: string, name: string) => void;
  onDelete: (raidGroupId: string) => void;
  persistenceEnabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(raid.name);

  const { setNodeRef, isOver } = useDroppable({
    id: `raid:${raid.raidGroupId}`,
    data: { kind: "raid", raidGroupId: raid.raidGroupId, field: raid.field },
  });

  // Resolve party ids → parties (skip any stale id defensively).
  const parties = raid.partyIds
    .map((id) => partiesById.get(id))
    .filter((p): p is Party => p !== undefined);

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== raid.name) onRename(raid.raidGroupId, next);
    else setDraft(raid.name);
  }

  return (
    <div
      ref={setNodeRef}
      className={[
        "flex w-72 shrink-0 flex-col rounded-xl border bg-gradient-to-b from-[#161634] to-[#10101f] p-3",
        isOver
          ? "border-fuchsia-400/80 neon-edge"
          : "border-indigo-400/30",
      ].join(" ")}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
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
            className="w-full rounded border border-indigo-400/40 bg-[#0c0c1c] px-1.5 py-0.5 text-sm text-slate-100"
          />
        ) : (
          <button
            type="button"
            onClick={() => persistenceEnabled && setEditing(true)}
            title={persistenceEnabled ? "Rename raid group" : "Needs MONGODB_URI"}
            className="truncate text-sm font-bold text-slate-100 hover:text-indigo-200"
          >
            {raid.name}
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-indigo-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-200">
            {parties.length}
          </span>
          <button
            type="button"
            onClick={() => onDelete(raid.raidGroupId)}
            disabled={!persistenceEnabled}
            title={persistenceEnabled ? "Delete raid group" : "Needs MONGODB_URI"}
            className="rounded px-1 text-xs text-slate-400 hover:text-red-400 disabled:opacity-40"
          >
            🗑
          </button>
        </div>
      </div>

      <div className="flex min-h-[48px] flex-col gap-1.5 rounded-lg border border-dashed border-indigo-400/20 p-1.5">
        {parties.length === 0 ? (
          <span className="px-1 py-2 text-center text-[11px] text-indigo-300/40">
            drop parties here
          </span>
        ) : (
          parties.map((p) => (
            <PartyChip
              key={p.partyId}
              party={p}
              instanceId={`raid:${raid.raidGroupId}:${p.partyId}`}
              from={raid.raidGroupId}
              noPriest={p.memberIds.length > 0 && !partyHasPriest(p, membersById)}
            />
          ))
        )}
      </div>
    </div>
  );
}
