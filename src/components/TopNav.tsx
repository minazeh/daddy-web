import Link from "next/link";
import type { Guild } from "@/lib/types";
import { GuildToggle } from "./GuildToggle";

// Shared top navigation across all three pages. `active` is passed by each page
// shell (deterministic — no client hooks), so it's SSR-safe / hydration-clean.
// Every link carries `?guild=${guild}` so switching pages keeps the same guild.
// The Daddy⇄Mummy toggle lives here too, right-aligned, so it's consistent
// everywhere. Sits in the `shrink-0` header area of each page's flex-col layout.

export type NavKey = "party" | "raid" | "members" | "settings";

const ITEMS: { key: NavKey; label: string; path: string }[] = [
  { key: "party", label: "Party Setup", path: "/" },
  { key: "raid", label: "Raid Setup", path: "/raids" },
  { key: "members", label: "Member Dashboard", path: "/members" },
  { key: "settings", label: "Settings", path: "/settings" },
];

const BASE_PATH: Record<NavKey, string> = {
  party: "/",
  raid: "/raids",
  members: "/members",
  settings: "/settings",
};

export function TopNav({ guild, active }: { guild: Guild; active: NavKey }) {
  // Settings are GLOBAL — the guild toggle is irrelevant there, so hide it.
  const showToggle = active !== "settings";
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-indigo-500/20 bg-[#0c0c1c]/95 px-4 py-2">
      <span className="mr-2 text-sm font-bold tracking-tight text-slate-100">
        Daddy Poring
      </span>
      <nav className="flex items-center gap-1" aria-label="Primary">
        {ITEMS.map((item) => {
          const isActive = item.key === active;
          // Settings is global; its link carries no guild param.
          const href =
            item.key === "settings" ? item.path : `${item.path}?guild=${guild}`;
          return (
            <Link
              key={item.key}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={[
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white shadow-sm"
                  : "border border-indigo-400/30 bg-indigo-950/50 text-indigo-100 hover:bg-indigo-900/60",
              ].join(" ")}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {showToggle && (
        <div className="ml-auto">
          {/* Toggle keeps you on the CURRENT page (basePath from active). */}
          <GuildToggle active={guild} basePath={BASE_PATH[active]} />
        </div>
      )}
    </header>
  );
}
