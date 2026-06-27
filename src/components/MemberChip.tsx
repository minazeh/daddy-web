"use client";

import { useDraggable } from "@dnd-kit/core";
import type { Member } from "@/lib/types";

// A draggable member card. Used in the left pool, inside filled party slots,
// and (overlay-only) as the drag preview. `instanceId` makes the same member
// uniquely identifiable across the pool and any slot, so dnd-kit never sees
// duplicate draggable ids.

export interface DragData {
  kind: "member";
  memberId: string;
  from: string; // "pool" | partyId
}

export function GuildBadge({ member }: { member: Member }) {
  // We only have isMain (Daddy) / isSub (Mummy) — no role/power data.
  const label = member.isMain ? "MAIN" : member.isSub ? "SUB" : "—";
  const tone = member.isMain
    ? "bg-sky-500/20 text-sky-300 ring-sky-400/40"
    : "bg-fuchsia-500/20 text-fuchsia-300 ring-fuchsia-400/40";
  return (
    <span
      className={`rounded px-1 py-px text-[9px] font-bold tracking-wide ring-1 ${tone}`}
    >
      {label}
    </span>
  );
}

export function MemberChip({
  member,
  instanceId,
  from,
  overlay = false,
  compact = false,
}: {
  member: Member;
  instanceId: string;
  from: string;
  overlay?: boolean;
  compact?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: instanceId,
    data: { kind: "member", memberId: member.userId, from } satisfies DragData,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={[
        "flex cursor-grab touch-none items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm select-none active:cursor-grabbing",
        "border-indigo-400/30 bg-indigo-950/60 text-slate-100 backdrop-blur-sm",
        compact ? "" : "shadow-sm",
        isDragging && !overlay ? "opacity-30" : "",
        overlay ? "neon-edge-strong scale-105" : "hover:border-indigo-300/60",
      ].join(" ")}
    >
      <span
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-600 text-xs font-bold text-white"
        aria-hidden
      >
        {/* Code-point-aware first char. `.slice(0,1)` splits an astral char
            (e.g. an emoji starting the name) into a lone UTF-16 surrogate; the
            server's HTML serializer replaces that orphan with U+FFFD while the
            client keeps the raw surrogate → a hydration text mismatch. Array.from
            iterates by code point, so the full emoji/letter survives intact and
            renders identically on server and client. */}
        {(Array.from(member.displayName)[0] ?? "").toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-medium">{member.displayName}</span>
        <span className="flex items-center gap-1">
          {member.className && (
            <span className="rounded bg-indigo-500/20 px-1.5 py-px text-[10px] font-medium text-indigo-200">
              {member.className}
            </span>
          )}
          <GuildBadge member={member} />
        </span>
      </span>
    </div>
  );
}
