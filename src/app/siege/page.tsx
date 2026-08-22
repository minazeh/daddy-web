import { getMembers, getPowerMap, getSettings, getUnavailableIds } from "@/lib/data";
import { getSiegeBoard } from "@/lib/siege-data";
import { isMongoConfigured } from "@/lib/mongo";
import { SiegeShell } from "@/components/SiegeShell";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Siege server component. A THIRD, independent layout alongside the GvG
// main/sub board and the Polarity board — its own `siegeRaids` / `siegeParties`
// collections, nothing shared with `parties` / `raidGroups` /
// `polarityParties` / `polarityRaids`. A member may sit in all three at once;
// that is intended and nothing here checks for it.
//
// Daddy and Mummy are SEPARATE guilds and therefore two SEPARATE sieges; the
// page renders exactly ONE of them, selected by the `?guild=` search param
// (same convention as `/`, `/raids` and `/polarity-raids`). On toggle the URL
// changes, this server component re-runs, and it re-fetches only the selected
// guild's roster + siege board.
//
// `searchParams` is a Promise in this version of Next and must be awaited (it
// also opts the route into dynamic rendering, which is what we want — the board
// is live DB state). This boundary only FETCHES; every mutation lives in
// siege-actions.ts, so nothing here ever calls revalidatePath during render and
// rendering this route performs ZERO database writes.

export default async function SiegePage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  const [rawMembers, board, powerMap, settings, unavailableIds] =
    await Promise.all([
      getMembers(guild),
      getSiegeBoard(guild),
      getPowerMap(guild),
      getSettings(),
      getUnavailableIds(guild),
    ]);
  // Power lives in the web-owned memberMeta, not the bot's `members` — join it
  // in so the pool chips show ⚡ and can sort by the value the generator ranks on.
  const members = rawMembers.map((m) => ({
    ...m,
    power: powerMap.get(m.userId) ?? 0,
  }));

  return (
    // `key={guild}` forces a fresh shell per guild so no client state ever
    // leaks across the Daddy/Mummy boundary.
    <SiegeShell
      key={guild}
      guild={guild}
      members={members}
      board={board}
      settings={settings}
      unavailableIds={unavailableIds}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
