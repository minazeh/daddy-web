import { getMembers, getParties, getRaidGroups } from "@/lib/data";
import { isMongoConfigured } from "@/lib/mongo";
import { RaidShell } from "@/components/RaidShell";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Raid Groups page (the layer ABOVE parties). Same per-guild pattern as the
// builder: exactly ONE guild at a time via the `?guild=` search param. On
// toggle the URL changes, this server component re-runs and re-fetches only the
// selected guild's parties + raid groups — never both guilds together.
//
// We pass the guild's PARTIES (read-only here; their members live on the
// builder page) so the raid pool can show each party's summary, and the guild's
// RAID GROUPS. The interactive shell (drag parties → raid groups) is a client
// component; this server boundary only fetches data.

export default async function RaidsPage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  const [members, parties, raidGroups] = await Promise.all([
    getMembers(guild),
    getParties(guild),
    getRaidGroups(guild),
  ]);

  return (
    // `key={guild}` forces a fresh shell per guild so no client state leaks
    // across the Daddy/Mummy boundary.
    <RaidShell
      key={guild}
      guild={guild}
      members={members}
      parties={parties}
      raidGroups={raidGroups}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
