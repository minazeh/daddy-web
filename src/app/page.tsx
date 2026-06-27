import { getMembers, getParties } from "@/lib/data";
import { isMongoConfigured } from "@/lib/mongo";
import { BuilderShell } from "@/components/BuilderShell";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Dashboard server component. Daddy and Mummy are SEPARATE guilds; the page
// renders exactly ONE of them, selected by the `?guild=` search param. On
// toggle the URL changes, this server component re-runs, and it re-fetches only
// the selected guild's members + parties — so each guild's slate is read fresh
// from the DB and the two are never shown together.
//
// Layout is full-width (no centered max-width container): a left member panel +
// a right zoom/pan canvas, both filling the viewport. The interactive shell is
// a client component (drag-and-drop + zoom/pan); this server boundary only
// fetches data and passes it down.

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  // Scoped to the selected guild only — never both.
  const [members, parties] = await Promise.all([
    getMembers(guild),
    getParties(guild),
  ]);

  return (
    // `key={guild}` forces a fresh shell per guild so no client state ever
    // leaks across the Daddy/Mummy boundary.
    <BuilderShell
      key={guild}
      guild={guild}
      members={members}
      parties={parties}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
