"use client";

import { useDroppable } from "@dnd-kit/core";
import { GUILD_LABEL, type Guild, type Member } from "@/lib/types";
import { MemberChip } from "./MemberChip";
import { GuildToggle } from "./GuildToggle";

// Left sidebar: the selected guild's member pool as compact draggable cards.
// It is a drop target so a member dragged out of a slot returns to the pool.
// Members currently assigned to a party in this guild are hidden from the pool.
// The Daddy/Mummy toggle lives at the top — it still drives which guild's
// members + parties load (via the URL search param).

export const POOL_ID = "member-pool";

export function MemberPool({
  guild,
  members,
  assignedIds,
}: {
  guild: Guild;
  members: Member[];
  assignedIds: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: POOL_ID,
    data: { kind: "pool" },
  });

  const available = members.filter((m) => !assignedIds.has(m.userId));

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-indigo-500/20 bg-[#0c0c1c]/95">
      <div className="border-b border-indigo-500/20 p-3">
        <h1 className="text-base font-bold tracking-tight text-slate-100">
          Daddy Poring — Party Builder
        </h1>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {GUILD_LABEL[guild]} guild roster · drag into a party
        </p>
        <div className="mt-3">
          <GuildToggle active={guild} />
        </div>
      </div>

      <div className="border-b border-indigo-500/20 px-3 py-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        Member pool · {available.length} available
      </div>

      <div
        ref={setNodeRef}
        className={[
          "flex-1 space-y-2 overflow-y-auto p-3 transition-colors",
          isOver ? "bg-indigo-500/10" : "",
        ].join(" ")}
      >
        {available.length === 0 ? (
          <p className="px-1 py-4 text-xs text-slate-500">
            No unassigned members in this guild&apos;s pool.
          </p>
        ) : (
          available.map((m) => (
            <MemberChip
              key={m.userId}
              member={m}
              instanceId={`pool:${m.userId}`}
              from="pool"
            />
          ))
        )}
      </div>
    </aside>
  );
}
