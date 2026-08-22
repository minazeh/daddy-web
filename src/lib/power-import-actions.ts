"use server";

import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { MOCK_MEMBERS, MOCK_MEMBER_META } from "./mock";
import {
  buildPreview,
  planApply,
  MAX_CSV_CHARS,
  type ApplyReport,
  type ImportDecision,
  type ImportPreview,
  type RosterMember,
} from "./power-import";
import { GUILD_LABEL, isGuild, type Guild } from "./types";

// Server actions for the CSV power-rating importer (/members → "Import CSV").
//
// TWO STEPS, ALWAYS. `previewPowerImport` parses + matches and writes NOTHING;
// `applyPowerImport` takes back the rows the user actually confirmed and is the
// only function here that touches the database. Power ratings are hand-
// maintained, so a blind write is never acceptable — the preview is not a
// convenience, it is the safety mechanism.
//
// WRITE SCOPE: `memberMeta.power` (+ updatedAt) and nothing else. The bot-owned
// `members` collection is never written. Mirrors setMemberPower in actions.ts:
// updateOne WITHOUT upsert, so a member with no meta row (impossible in
// practice — rows are created by the on-load sync) is reported, not invented.
//
// GUILD SCOPE is enforced HERE, not in the UI: the roster is re-read server-side
// for the guild being imported and every decision is checked against it. A
// userId that is not on that roster is rejected with a reason, even if the
// client asked for it. Daddy and Mummy are separate guilds; an import touches
// exactly one.

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
 * READ-ONLY roster for ONE guild: the ACTIVE members (present in the bot's
 * `members` collection) joined with their current power.
 *
 * Deliberately does NOT call getMembersForManagement / syncMemberMeta — those
 * upsert memberMeta as a side effect, and the preview step must not write
 * anything at all. Departed members are excluded: an import targets the live
 * roster.
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

/**
 * STEP 1 — parse the CSV, match it against the guild's live roster and return
 * what an import WOULD do. Pure read: nothing is persisted.
 */
export async function previewPowerImport(
  guild: Guild,
  csvText: string,
): Promise<ImportPreview> {
  const emptyCounts = {
    total: 0,
    exact: 0,
    suggested: 0,
    unmatched: 0,
    error: 0,
    crossGuild: 0,
  };
  if (!isGuild(guild)) {
    return {
      ok: false,
      message: "Unknown guild.",
      guild: "daddy",
      rows: [],
      roster: [],
      counts: emptyCounts,
    };
  }
  if (typeof csvText !== "string" || csvText.length > MAX_CSV_CHARS) {
    return {
      ok: false,
      message: `CSV is missing or too large (limit ${MAX_CSV_CHARS} characters).`,
      guild,
      rows: [],
      roster: [],
      counts: emptyCounts,
    };
  }

  const otherGuild: Guild = guild === "daddy" ? "mummy" : "daddy";
  // The other guild's roster is read for REPORTING only — so a row that is
  // really the other guild's member says so instead of "not found".
  const [roster, otherRoster] = await Promise.all([
    readGuildRoster(guild),
    readGuildRoster(otherGuild),
  ]);

  if (roster.length === 0) {
    return {
      ok: false,
      message: `No active ${GUILD_LABEL[guild]} members found.`,
      guild,
      rows: [],
      roster: [],
      counts: emptyCounts,
    };
  }

  return buildPreview(guild, csvText, roster, otherRoster);
}

/**
 * STEP 2 — apply the CONFIRMED decisions. Re-validates every one against a
 * freshly read roster (the client is not trusted), then writes power to
 * `memberMeta` only. Members with no confirmed decision are not touched:
 * absence from the CSV never zeroes anyone.
 */
export async function applyPowerImport(
  guild: Guild,
  decisions: ImportDecision[],
): Promise<ApplyReport> {
  const fail = (message: string): ApplyReport => ({
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

  const otherGuild: Guild = guild === "daddy" ? "mummy" : "daddy";
  const [roster, otherRoster] = await Promise.all([
    readGuildRoster(guild),
    readGuildRoster(otherGuild),
  ]);
  if (roster.length === 0) {
    return fail(`No active ${GUILD_LABEL[guild]} members found.`);
  }

  const otherGuildIds = new Set(otherRoster.map((m) => m.userId));
  const { writes, unchanged, skipped } = planApply(
    guild,
    decisions,
    roster,
    otherGuildIds,
  );

  const changes = writes.map((w) => ({
    userId: w.userId,
    displayName: w.displayName,
    from: w.from,
    to: w.power,
  }));

  if (writes.length > 0) {
    if (!isMongoConfigured) {
      for (const w of writes) {
        const existing = MOCK_MEMBER_META.get(w.userId);
        if (existing) {
          existing.power = w.power;
          existing.updatedAt = new Date().toISOString();
        }
      }
    } else {
      const db = await getDb();
      const result = await db.collection(MEMBER_META).bulkWrite(
        writes.map((w) => ({
          updateOne: {
            // No upsert: a CSV import must not conjure rows for userIds that
            // are not on the roster, so a miss is reported as `no-meta-row`
            // below rather than silently inserted. (setMemberPower, which is
            // always driven from a real member card, does upsert.)
            filter: { userId: w.userId },
            update: { $set: { power: w.power, updatedAt: new Date() } },
          },
        })),
        { ordered: false },
      );
      // A row that matched nothing had no meta doc — report it rather than
      // silently claiming success.
      if (result.matchedCount < writes.length) {
        const missing = await findMissingMeta(writes.map((w) => w.userId));
        for (const userId of missing) {
          const w = writes.find((x) => x.userId === userId);
          skipped.push({
            rowNumber: 0,
            userId,
            displayName: w?.displayName ?? null,
            reason: "no-meta-row",
            detail:
              "No memberMeta row — run Sync roster on /members to create it.",
          });
        }
        for (let i = changes.length - 1; i >= 0; i--) {
          if (missing.has(changes[i].userId)) changes.splice(i, 1);
        }
      }
    }
  }

  const covered = new Set<string>([
    ...changes.map((c) => c.userId),
    ...unchanged.map((c) => c.userId),
  ]);

  // Power feeds Generate (/) and Polarity, and is shown on /members.
  revalidatePath("/members");
  revalidatePath("/");
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

/** userIds among `ids` that have no memberMeta row. */
async function findMissingMeta(ids: string[]): Promise<Set<string>> {
  const db = await getDb();
  const found = await db
    .collection<MetaPowerRow>(MEMBER_META)
    .find({ userId: { $in: ids } })
    .project<{ userId: string }>({ _id: 0, userId: 1 })
    .toArray();
  const have = new Set(found.map((d) => d.userId));
  return new Set(ids.filter((id) => !have.has(id)));
}
