"use server";

import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { ensureSchema } from "./bootstrap";
import { getMembers, getPowerMap, getSettings } from "./data";
import {
  getSiegeBoard,
  SIEGE_PARTIES,
  SIEGE_RAIDS,
  type SiegeBoard,
} from "./siege-data";
import {
  buildPlans,
  generateCohorts,
  slotsToMemberIds,
  type PartyPlan,
} from "./generate";
import { siegeQuotas } from "./siege";
import type { Guild } from "./types";

// ============================================================================
// SIEGE — server actions.
//
// Mutates ONLY the `siegeParties` / `siegeRaids` collections. The GvG
// (`parties` / `raidGroups`) and Polarity (`polarityParties` / `polarityRaids`)
// collections are never written here, and `members` is never written anywhere.
//
// Every write revalidates "/siege" — AND ONLY FROM AN ACTION. revalidatePath
// during a render throws; that is what caused the cold-load 500 documented in
// data.ts / polarity-data.ts / siege-data.ts. There is deliberately no
// revalidation anywhere in siege-data.ts.
//
// Every write path awaits ensureSchema() first, so the unique indexes that make
// the seeding upserts race-safe are guaranteed to exist before we write.
//
// When MONGODB_URI is unset these are no-ops returning a clear notice, exactly
// like the GvG and Polarity actions.
// ============================================================================

export interface SiegeActionResult {
  ok: boolean;
  message?: string;
}

export interface SiegeBoardResult extends SiegeActionResult {
  board?: SiegeBoard;
}

export interface SiegeGenerateResult extends SiegeBoardResult {
  // partyId → required classNames the party is still missing (for flagging).
  partiesMissing?: Record<string, string[]>;
  // Members of this guild who did not fit anywhere (roster > total capacity).
  unassignedCount?: number;
}

const NOT_CONFIGURED: SiegeActionResult = {
  ok: false,
  message: "MONGODB_URI is not set — changes are not persisted.",
};

const SIEGE_PATH = "/siege";

function revalidateSiege() {
  revalidatePath(SIEGE_PATH);
}

// Persist a siege party's slot assignments (auto-saved on every drag).
export async function updateSiegeParty(
  partyId: string,
  memberIds: string[],
): Promise<SiegeActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const { partySize } = await getSettings();
  const deduped = Array.from(new Set(memberIds)).slice(0, partySize);
  const db = await getDb();
  await db
    .collection(SIEGE_PARTIES)
    .updateOne(
      { partyId },
      { $set: { memberIds: deduped, updatedAt: new Date() } },
    );
  revalidateSiege();
  return { ok: true };
}

// Persist the set of locked slot indexes for a siege party.
export async function setSiegePartyLocks(
  partyId: string,
  lockedSlots: number[],
): Promise<SiegeActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const { partySize } = await getSettings();
  const cleaned = Array.from(new Set(lockedSlots)).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < partySize,
  );
  const db = await getDb();
  await db
    .collection(SIEGE_PARTIES)
    .updateOne(
      { partyId },
      { $set: { lockedSlots: cleaned, updatedAt: new Date() } },
    );
  revalidateSiege();
  return { ok: true };
}

// Rename a siege party.
export async function renameSiegeParty(
  partyId: string,
  name: string,
): Promise<SiegeActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };
  const db = await getDb();
  await db
    .collection(SIEGE_PARTIES)
    .updateOne({ partyId }, { $set: { name: trimmed, updatedAt: new Date() } });
  revalidateSiege();
  return { ok: true };
}

// Rename a siege raid. Only the NAME is editable — a raid's `raidKey` and
// position come from the canonical structure and are re-derived on every read,
// so renaming "Delta Flex" to anything else does not move it or change which
// of its parties are flex.
export async function renameSiegeRaid(
  guild: Guild,
  raidId: string,
  name: string,
): Promise<SiegeBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };
  const db = await getDb();
  await db
    .collection(SIEGE_RAIDS)
    .updateOne(
      { raidId, type: guild },
      { $set: { name: trimmed, updatedAt: new Date() } },
    );
  revalidateSiege();
  return { ok: true, board: await getSiegeBoard(guild) };
}

// SET / CLEAR a siege raid's leader. `userId === null` (or "") clears it.
// ONE leader per raid, four per guild — there are no party-level leaders.
// Server-side validation (the UI select is not trusted): a non-null leader MUST
// currently sit in one of THIS raid's parties.
export async function setSiegeRaidLeader(
  guild: Guild,
  raidId: string,
  userId: string | null,
): Promise<SiegeBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const clearing = userId === null || userId === "";
  if (!clearing) {
    const board = await getSiegeBoard(guild);
    const raid = board.raids.find((r) => r.raidId === raidId);
    if (!raid) return { ok: false, message: "Raid not found." };
    const eligible = new Set<string>();
    for (const p of board.parties) {
      if (p.raidId !== raidId) continue;
      for (const id of p.memberIds) eligible.add(id);
    }
    if (!eligible.has(userId)) {
      return { ok: false, message: "Leader must be a member of this raid." };
    }
  }

  const db = await getDb();
  await db
    .collection(SIEGE_RAIDS)
    .updateOne(
      { raidId, type: guild },
      { $set: { leaderId: clearing ? null : userId, updatedAt: new Date() } },
    );
  revalidateSiege();
  return { ok: true, board: await getSiegeBoard(guild) };
}

// GENERATE: auto-assign every unlocked slot across this guild's 4 siege raids.
// Reuses the shared cohort generator (generate.ts) — the same engine the GvG and
// Polarity builders run — with one cohort per raid and an EVEN 4-WAY SPLIT
// quota (siegeQuotas).
//
//   partitionFirst — cohort membership is decided by power rank first, then the
//     required-class pass runs WITHIN each raid, so a raid short of Priests
//     flags its parties instead of stealing from another raid.
//   tieBreak "userId" — equal power resolves by userId, so re-running Generate
//     on unchanged data reproduces the same board instead of reshuffling. (Most
//     of the roster sits at power 0, so nearly every comparison is a tie.)
//
// Locks survive: pinned members are excluded from the pool and keep their slot.
//
// Delta Flex is generated EXACTLY like the other three — the even split is what
// Conrad chose, and it will typically fill Delta past its "expected" 6 parties.
// The flex parties are dimmed, never withheld.
export async function generateSiege(
  guild: Guild,
): Promise<SiegeGenerateResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const [members, board, powerMap, settings] = await Promise.all([
    getMembers(guild), // ACTIVE members only (present in `members`)
    getSiegeBoard(guild),
    getPowerMap(guild),
    getSettings(),
  ]);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const powerOf = (uid: string) => powerMap.get(uid) ?? 0;
  const classOf = (uid: string) => memberById.get(uid)?.className ?? null;

  const plans = buildPlans(board.parties, memberById, settings.partySize);
  const planById = new Map(plans.map((p) => [p.partyId, p]));

  // One cohort per raid, in structural order (Alpha, Bravo, Charlie, Delta).
  const cohorts = board.raids.map((r) =>
    board.parties
      .filter((p) => p.raidId === r.raidId)
      .sort((a, b) => a.position - b.position)
      .map((p) => planById.get(p.partyId))
      .filter((p): p is PartyPlan => p !== undefined),
  );

  // Available pool = guild members NOT pinned in any locked slot.
  const pinned = new Set<string>();
  for (const plan of plans) {
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) pinned.add(uid);
    }
  }
  const pool = members.filter((m) => !pinned.has(m.userId));

  const missing = generateCohorts(cohorts, pool, powerOf, classOf, settings, {
    tieBreak: "userId",
    partitionFirst: true,
    quotas: siegeQuotas,
  });

  // Persist: compact each plan's slots and RE-KEY its locks to the compacted
  // indexes so a pinned member keeps its lock even though its index moved.
  const assigned = new Set<string>();
  const db = await getDb();
  const ops = plans.map((plan) => {
    const lockedUids = new Set<string>();
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) lockedUids.add(uid);
    }
    const memberIds = slotsToMemberIds(plan.slots);
    for (const uid of memberIds) assigned.add(uid);
    const newLocked: number[] = [];
    memberIds.forEach((uid, idx) => {
      if (lockedUids.has(uid)) newLocked.push(idx);
    });
    return {
      updateOne: {
        filter: { partyId: plan.partyId },
        update: {
          $set: { memberIds, lockedSlots: newLocked, updatedAt: new Date() },
        },
      },
    };
  });
  if (ops.length) {
    await db.collection(SIEGE_PARTIES).bulkWrite(ops, { ordered: false });
  }

  revalidateSiege();
  return {
    ok: true,
    board: await getSiegeBoard(guild),
    partiesMissing: Object.fromEntries(missing),
    // Overflow beyond capacity is left UNASSIGNED, never dropped.
    unassignedCount: members.filter((m) => !assigned.has(m.userId)).length,
  };
}

// RESET: clear all UNLOCKED slots across this guild's siege board (members
// return to the pool). LOCKED members stay put; locks re-key onto the compacted
// indexes.
export async function resetSiege(guild: Guild): Promise<SiegeBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const [board, settings] = await Promise.all([
    getSiegeBoard(guild),
    getSettings(),
  ]);
  const db = await getDb();
  const ops = board.parties.map((p) => {
    const locked = new Set(p.lockedSlots);
    const kept: string[] = [];
    const keptLocked: number[] = [];
    for (let i = 0; i < settings.partySize; i++) {
      const uid = p.memberIds[i];
      if (uid && locked.has(i)) {
        keptLocked.push(kept.length);
        kept.push(uid);
      }
    }
    return {
      updateOne: {
        filter: { partyId: p.partyId },
        update: {
          $set: {
            memberIds: kept,
            lockedSlots: keptLocked,
            updatedAt: new Date(),
          },
        },
      },
    };
  });
  if (ops.length) {
    await db.collection(SIEGE_PARTIES).bulkWrite(ops, { ordered: false });
  }
  revalidateSiege();
  return { ok: true, board: await getSiegeBoard(guild) };
}

// RESET LOCK: clear EVERYTHING for this guild's siege board — assignments AND
// locks AND raid leaders → a blank board. The OTHER guild's siege is untouched
// (every filter is scoped by `type`), as are GvG and Polarity.
export async function resetLockSiege(guild: Guild): Promise<SiegeBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;
  await ensureSchema();

  const db = await getDb();
  await db
    .collection(SIEGE_PARTIES)
    .updateMany(
      { type: guild },
      { $set: { memberIds: [], lockedSlots: [], updatedAt: new Date() } },
    );
  await db
    .collection(SIEGE_RAIDS)
    .updateMany(
      { type: guild },
      { $set: { leaderId: null, updatedAt: new Date() } },
    );
  revalidateSiege();
  return { ok: true, board: await getSiegeBoard(guild) };
}
