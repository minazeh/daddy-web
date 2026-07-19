"use client";

import { useMemo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { GUILD_LABEL, type Guild, type Member } from "@/lib/types";
import { MemberChip } from "./MemberChip";
import { GuildToggle } from "./GuildToggle";

// Left sidebar: the selected guild's member pool as compact draggable cards.
// It is a drop target so a member dragged out of a slot returns to the pool.
// Members currently assigned to a party in this guild are hidden from the pool.
// The Daddy/Mummy toggle lives at the top — it still drives which guild's
// members + parties load (via the URL search param).
//
// The sort control defaults to "Name A→Z" — a deterministic order applied
// identically on the server render and first client render; picking another
// option re-sorts client-only.

export const POOL_ID = "member-pool";

type SortMode = "name-asc" | "name-desc" | "power-desc" | "power-asc" | "class-asc";

function byNameThenId(a: Member, b: Member): number {
  const n = a.displayName.localeCompare(b.displayName);
  return n !== 0 ? n : a.userId.localeCompare(b.userId);
}

// The active sort comparator (name/power/class). A total order in every mode:
// each branch falls back to byNameThenId (unique userId last), so two runs of
// the sort never disagree → no SSR/hydration order drift.
function compareBySort(a: Member, b: Member, sortMode: SortMode): number {
  switch (sortMode) {
    case "name-asc":
      return byNameThenId(a, b);
    case "name-desc":
      return -byNameThenId(a, b);
    case "power-desc": {
      const pa = a.power ?? 0;
      const pb = b.power ?? 0;
      return pb !== pa ? pb - pa : byNameThenId(a, b);
    }
    case "power-asc": {
      const pa = a.power ?? 0;
      const pb = b.power ?? 0;
      return pa !== pb ? pa - pb : byNameThenId(a, b);
    }
    case "class-asc": {
      const noA = !a.className;
      const noB = !b.className;
      if (noA && noB) return byNameThenId(a, b); // no class sorts last
      if (noA) return 1;
      if (noB) return -1;
      const c = a.className!.localeCompare(b.className!);
      return c !== 0 ? c : byNameThenId(a, b);
    }
  }
}

export function MemberPool({
  guild,
  members,
  assignedIds,
  unavailableIds,
}: {
  guild: Guild;
  members: Member[];
  assignedIds: Set<string>;
  // "Can't make it" userIds for the soonest upcoming Guild Event. They sink to
  // the BOTTOM of the pool (below the active sort) and render dimmed, but stay
  // draggable — de-prioritization, not a block.
  unavailableIds: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: POOL_ID,
    data: { kind: "pool" },
  });

  const [sortMode, setSortMode] = useState<SortMode>("name-asc");

  const available = useMemo(() => {
    const filtered = members.filter((m) => !assignedIds.has(m.userId));
    filtered.sort((a, b) => {
      // PRIMARY key: unavailable ("can't make it") always sinks last, in EVERY
      // sort mode. Within each group (available / unavailable) the active sort
      // comparator applies — so the deterministic total order is preserved.
      const ua = unavailableIds.has(a.userId);
      const ub = unavailableIds.has(b.userId);
      if (ua !== ub) return ua ? 1 : -1;
      return compareBySort(a, b, sortMode);
    });
    return filtered;
  }, [members, assignedIds, sortMode, unavailableIds]);

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

      <div className="space-y-2 border-b border-indigo-500/20 px-3 py-2">
        <div className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
          Member pool · {available.length} available
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
            Sort
          </label>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="flex-1 rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-xs text-slate-100"
          >
            <option value="name-asc">Name: A → Z</option>
            <option value="name-desc">Name: Z → A</option>
            <option value="power-desc">Power: high → low</option>
            <option value="power-asc">Power: low → high</option>
            <option value="class-asc">Class: A → Z</option>
          </select>
        </div>
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
              unavailable={unavailableIds.has(m.userId)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
