"use client";

import { useMemo, useState } from "react";
import type { LeaderboardRow } from "@/lib/attendance";
import { RateLeaderboard } from "./AttendanceCharts";

// Thin client wrapper around the (server-safe, pure-render) RateLeaderboard so
// the attendance page can offer a sort control without becoming a client
// component itself. Default sort ("rate-desc") is exactly the order
// `guildLeaderboard` already returns (rate desc, expected desc, name, userId)
// — so the default render needs no re-sort and SSR HTML === first client
// render. Only picking a different option re-sorts, client-only. Rank numbers
// in RateLeaderboard index the array we pass it, so they always follow the
// active sort.

type SortMode = "rate-desc" | "present-desc" | "sessions-desc" | "name-asc";

function byNameThenId(a: LeaderboardRow, b: LeaderboardRow): number {
  const n = a.displayName.localeCompare(b.displayName);
  return n !== 0 ? n : a.userId.localeCompare(b.userId);
}

export function LeaderboardPanel({ rows }: { rows: LeaderboardRow[] }) {
  const [sortMode, setSortMode] = useState<SortMode>("rate-desc");

  const sorted = useMemo(() => {
    if (sortMode === "rate-desc") return rows; // already this order (guildLeaderboard)
    const copy = [...rows];
    copy.sort((a, b) => {
      switch (sortMode) {
        case "present-desc":
          return b.presentCount !== a.presentCount
            ? b.presentCount - a.presentCount
            : byNameThenId(a, b);
        case "sessions-desc":
          return b.expectedCount !== a.expectedCount
            ? b.expectedCount - a.expectedCount
            : byNameThenId(a, b);
        case "name-asc":
          return byNameThenId(a, b);
      }
    });
    return copy;
  }, [rows, sortMode]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <label className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
          Sort
        </label>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="flex-1 rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-xs text-slate-100"
        >
          <option value="rate-desc">Rate: high → low</option>
          <option value="present-desc">Present count</option>
          <option value="sessions-desc">Sessions</option>
          <option value="name-asc">Name: A → Z</option>
        </select>
      </div>
      <div className="max-h-[420px] overflow-y-auto pr-1">
        <RateLeaderboard rows={sorted} />
      </div>
    </div>
  );
}
