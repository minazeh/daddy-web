import Link from "next/link";
import { GUILDS, GUILD_LABEL, type Guild } from "@/lib/types";

// Daddy <-> Mummy switcher. Each option is a link to `/?guild=<g>`, so clicking
// it changes the URL and re-runs the server component, which re-fetches that
// guild's data. This keeps the two guilds' slates fully independent and lets a
// reload (or shared URL) land on the same guild. Server component — no client
// JS needed for the toggle itself.

export function GuildToggle({
  active,
  basePath = "/",
}: {
  active: Guild;
  basePath?: string; // "/" for the builder, "/raids" for the raids page
}) {
  return (
    <div
      role="tablist"
      aria-label="Select guild"
      className="inline-flex rounded-lg border border-neutral-300 bg-neutral-100 p-1 dark:border-neutral-700 dark:bg-neutral-800"
    >
      {GUILDS.map((g) => {
        const selected = g === active;
        return (
          <Link
            key={g}
            href={`${basePath}?guild=${g}`}
            role="tab"
            aria-selected={selected}
            scroll={false}
            className={[
              "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
              selected
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-white"
                : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200",
            ].join(" ")}
          >
            {GUILD_LABEL[g]}
          </Link>
        );
      })}
    </div>
  );
}
