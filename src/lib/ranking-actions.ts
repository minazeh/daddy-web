"use server";

import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { ensureSchema } from "./bootstrap";
import { MOCK_MEMBERS, MOCK_MEMBER_META } from "./mock";
import { getPolarityDpsMap, writePolarityDps } from "./polarity-dps-data";
import {
  buildRankingPreview,
  planRankingApply,
  MAX_RANKING_CHARS,
  type RankingApplyReport,
  type RankingDecision,
  type RankingPreview,
} from "./ranking-import";
import type { RosterMember } from "./name-match";
import { GUILD_LABEL, isGuild, type Guild } from "./types";

// Server actions for the Polarity DPS ranking importer (/polarity-raids →
// "Import DPS ranking").
//
// TWO STEPS, ALWAYS — the same contract as the CSV power importer.
// `previewRankingImport` parses, dedupes and matches, and writes NOTHING;
// `applyRankingImport` takes back only the rows the user confirmed and is the
// only function here that touches the database.
//
// WRITE SCOPE: the web-owned `polarityDps` collection and nothing else.
//   - `memberMeta.power` is NOT touched. Power is hand-maintained data that
//     drives the /members leaderboard, the GvG builder and Siege; a ranking
//     paste must not move any of them.
//   - The bot-owned `members` collection is never written.
//   - The GvG `parties` / `raidGroups` collections are never written.
//
// GUILD SCOPE is enforced HERE, not in the UI: the roster is re-read
// server-side for the guild being imported and every decision is checked
// against it. Daddy and Mummy are separate guilds; an import touches exactly
// one.

const MEMBERS = "members";
const MEMBER_META = "memberMeta";

interface MemberRow {
  userId: string;
  username?: string;
  displayName?: string;
  isMain?: boolean;
  isSub?: boolean;
  className?: string | null;
}

interface MetaPowerRow {
  userId: string;
  power?: number;
}

/**
 * READ-ONLY roster for ONE guild: the ACTIVE members joined with their current
 * power (shown in the manual-pick dropdown only — this importer never writes
 * power).
 *
 * Deliberately does NOT call getMembersForManagement / syncMemberMeta — those
 * upsert memberMeta as a side effect, and the preview step must not write
 * anything at all.
 */
async function readGuildRoster(guild: Guild): Promise<RosterMember[]> {
  const inGuild = (m: { isMain?: boolean; isSub?: boolean }) =>
    guild === "daddy" ? Boolean(m.isMain) : Boolean(m.isSub);

  if (!isMongoConfigured) {
    return MOCK_MEMBERS.filter(inGuild).map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      username: m.username,
      className: m.className,
      power: MOCK_MEMBER_META.get(m.userId)?.power ?? 0,
    }));
  }

  const db = await getDb();
  const filterField = guild === "daddy" ? "isMain" : "isSub";
  const members = await db
    .collection<MemberRow>(MEMBERS)
    .find({ [filterField]: true })
    .project<MemberRow>({
      _id: 0,
      userId: 1,
      username: 1,
      displayName: 1,
      className: 1,
    })
    .toArray();
  if (members.length === 0) return [];

  const metas = await db
    .collection<MetaPowerRow>(MEMBER_META)
    .find({ userId: { $in: members.map((m) => m.userId) } })
    .project<MetaPowerRow>({ _id: 0, userId: 1, power: 1 })
    .toArray();
  const powerById = new Map<string, number>();
  for (const m of metas) {
    powerById.set(
      m.userId,
      typeof m.power === "number" && m.power >= 0 ? Math.floor(m.power) : 0,
    );
  }

  return members
    .map((m) => ({
      userId: m.userId,
      displayName: m.displayName ?? m.username ?? m.userId,
      username: m.username ?? "",
      className: m.className ?? null,
      power: powerById.get(m.userId) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) ||
        a.userId.localeCompare(b.userId),
    );
}

const EMPTY_COUNTS = {
  total: 0,
  exact: 0,
  suggested: 0,
  unmatched: 0,
  error: 0,
  crossGuild: 0,
  duplicatesCollapsed: 0,
};

/**
 * STEP 1 — parse the pasted ranking, dedupe it, match it against the guild's
 * live roster and return what an import WOULD do. Pure read: nothing is
 * persisted.
 */
export async function previewRankingImport(
  guild: Guild,
  text: string,
): Promise<RankingPreview> {
  const fail = (message: string, g: Guild = "daddy"): RankingPreview => ({
    ok: false,
    message,
    guild: g,
    rows: [],
    roster: [],
    counts: EMPTY_COUNTS,
    skippedLines: 0,
  });

  if (!isGuild(guild)) return fail("Unknown guild.");
  if (typeof text !== "string" || text.length > MAX_RANKING_CHARS) {
    return fail(
      `The paste is missing or too large (limit ${MAX_RANKING_CHARS} characters).`,
      guild,
    );
  }

  const otherGuild: Guild = guild === "daddy" ? "mummy" : "daddy";
  // The other guild's roster is read for REPORTING only — so a row that is
  // really the other guild's member says so instead of "not found".
  const [roster, otherRoster, current] = await Promise.all([
    readGuildRoster(guild),
    readGuildRoster(otherGuild),
    getPolarityDpsMap(guild),
  ]);

  if (roster.length === 0) {
    return fail(`No active ${GUILD_LABEL[guild]} members found.`, guild);
  }

  // `now` is taken once, server-side, and is what the MM-DD year inference
  // resolves against.
  return buildRankingPreview(
    guild,
    text,
    roster,
    otherRoster,
    new Date(),
    current,
  );
}

/**
 * STEP 2 — apply the CONFIRMED decisions. Re-validates every one against a
 * freshly read roster (the client is not trusted), then writes to
 * `polarityDps` only. Members with no confirmed row are not touched: absence
 * from the paste never clears anyone's stored DPS.
 */
export async function applyRankingImport(
  guild: Guild,
  decisions: RankingDecision[],
): Promise<RankingApplyReport> {
  const fail = (message: string): RankingApplyReport => ({
    ok: false,
    message,
    guild: isGuild(guild) ? guild : "daddy",
    updated: 0,
    unchanged: 0,
    skipped: 0,
    untouched: 0,
    changes: [],
    skippedRows: [],
  });

  if (!isGuild(guild)) return fail("Unknown guild.");
  if (!Array.isArray(decisions)) return fail("No rows to apply.");
  if (decisions.length === 0) return fail("Nothing selected to apply.");
  if (decisions.length > 5_000) return fail("Too many rows to apply at once.");

  const otherGuild: Guild = guild === "daddy" ? "mummy" : "daddy";
  const [roster, otherRoster, current] = await Promise.all([
    readGuildRoster(guild),
    readGuildRoster(otherGuild),
    getPolarityDpsMap(guild),
  ]);
  if (roster.length === 0) {
    return fail(`No active ${GUILD_LABEL[guild]} members found.`);
  }

  const otherGuildIds = new Set(otherRoster.map((m) => m.userId));
  const { writes, unchanged, skipped } = planRankingApply(
    guild,
    decisions,
    roster,
    otherGuildIds,
    current,
  );

  if (writes.length > 0) {
    // The unique (guild, userId) index is what makes the upserts race-safe, so
    // the write path waits for the schema bootstrap — same rule the party
    // seeding follows.
    await ensureSchema();
    await writePolarityDps(
      guild,
      writes.map((w) => ({
        userId: w.userId,
        dps: w.dps,
        total: w.total,
        deadSeconds: w.deadSeconds,
        className: w.className,
        submittedAt: w.submittedAt,
      })),
      new Date(),
    );
  }

  const changes = writes.map((w) => ({
    userId: w.userId,
    displayName: w.displayName,
    fromDps: w.fromDps,
    toDps: w.dps,
    className: w.className,
    submittedAt: w.submittedAt,
  }));

  const covered = new Set<string>([
    ...changes.map((c) => c.userId),
    ...unchanged.map((c) => c.userId),
  ]);

  // The imported DPS drives Generate on /polarity-raids and nothing else, so
  // that is the only path revalidated. `/` and `/members` are deliberately NOT
  // revalidated: this import does not change power.
  revalidatePath("/polarity-raids");

  return {
    ok: true,
    guild,
    updated: changes.length,
    unchanged: unchanged.length,
    skipped: skipped.length,
    untouched: roster.filter((m) => !covered.has(m.userId)).length,
    changes,
    skippedRows: skipped,
  };
}
