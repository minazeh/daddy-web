import { getMembers, getPowerMap, getSettings, getUnavailableIds } from "@/lib/data";
import { getPolarityBoard } from "@/lib/polarity-data";
import { isMongoConfigured } from "@/lib/mongo";
import { PolarityShell } from "@/components/PolarityShell";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Polarity Raids server component. A SECOND, independent raid layout alongside
// the GvG main/sub board — its own `polarityRaids` / `polarityParties`
// collections, nothing shared with `parties` / `raidGroups`.
//
// Daddy and Mummy are SEPARATE guilds; the page renders exactly ONE of them,
// selected by the `?guild=` search param (same convention as `/` and `/raids`).
// On toggle the URL changes, this server component re-runs, and it re-fetches
// only the selected guild's roster + polarity board.
//
// `searchParams` is a Promise in this version of Next and must be awaited (it
// also opts the route into dynamic rendering, which is what we want — the board
// is live DB state). This boundary only FETCHES; every mutation lives in
// polarity-actions.ts, so nothing here ever calls revalidatePath during render.

export default async function PolarityRaidsPage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  const [rawMembers, board, powerMap, settings, unavailableIds] =
    await Promise.all([
      getMembers(guild),
      getPolarityBoard(guild),
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
    <PolarityShell
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
