"use server";

import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { getMembers, getPowerMap, getSettings } from "./data";
import {
  getPolarityBoard,
  POLARITY_PARTIES,
  POLARITY_RAIDS,
  type PolarityBoard,
} from "./polarity-data";
import {
  buildPlans,
  generateCohorts,
  slotsToMemberIds,
  type PartyPlan,
} from "./generate";
import { polarityQuotas } from "./polarity";
import type { Guild } from "./types";

// ============================================================================
// POLARITY RAIDS — server actions.
//
// Mutates ONLY the `polarityParties` / `polarityRaids` collections. The GvG
// `parties` / `raidGroups` collections are never written here. Every write
// revalidates "/polarity-raids" (and only from an action — never from a data
// fetch, which is what makes the GvG cold-load 500 at data.ts:576).
//
// When MONGODB_URI is unset these are no-ops returning a clear notice, exactly
// like the GvG party actions.
// ============================================================================

export interface PolarityActionResult {
  ok: boolean;
  message?: string;
}

export interface PolarityBoardResult extends PolarityActionResult {
  board?: PolarityBoard;
}

export interface PolarityGenerateResult extends PolarityBoardResult {
  // partyId → required classNames the party is still missing (for flagging).
  partiesMissing?: Record<string, string[]>;
  // Members of this guild who did not fit anywhere (roster > total capacity).
  unassignedCount?: number;
}

const NOT_CONFIGURED: PolarityActionResult = {
  ok: false,
  message: "MONGODB_URI is not set — changes are not persisted.",
};

const POLARITY_PATH = "/polarity-raids";

function revalidatePolarity() {
  revalidatePath(POLARITY_PATH);
}

// Persist a polarity party's slot assignments (auto-saved on every drag).
export async function updatePolarityParty(
  partyId: string,
  memberIds: string[],
): Promise<PolarityActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const { partySize } = await getSettings();
  const deduped = Array.from(new Set(memberIds)).slice(0, partySize);
  const db = await getDb();
  await db
    .collection(POLARITY_PARTIES)
    .updateOne(
      { partyId },
      { $set: { memberIds: deduped, updatedAt: new Date() } },
    );
  revalidatePolarity();
  return { ok: true };
}

// Persist the set of locked slot indexes for a polarity party.
export async function setPolarityPartyLocks(
  partyId: string,
  lockedSlots: number[],
): Promise<PolarityActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const { partySize } = await getSettings();
  const cleaned = Array.from(new Set(lockedSlots)).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < partySize,
  );
  const db = await getDb();
  await db
    .collection(POLARITY_PARTIES)
    .updateOne(
      { partyId },
      { $set: { lockedSlots: cleaned, updatedAt: new Date() } },
    );
  revalidatePolarity();
  return { ok: true };
}

// Rename a polarity party.
export async function renamePolarityParty(
  partyId: string,
  name: string,
): Promise<PolarityActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };
  const db = await getDb();
  await db
    .collection(POLARITY_PARTIES)
    .updateOne({ partyId }, { $set: { name: trimmed, updatedAt: new Date() } });
  revalidatePolarity();
  return { ok: true };
}

// Rename a polarity raid group.
export async function renamePolarityRaid(
  guild: Guild,
  raidId: string,
  name: string,
): Promise<PolarityBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };
  const db = await getDb();
  await db
    .collection(POLARITY_RAIDS)
    .updateOne(
      { raidId, type: guild },
      { $set: { name: trimmed, updatedAt: new Date() } },
    );
  revalidatePolarity();
  return { ok: true, board: await getPolarityBoard(guild) };
}

// SET / CLEAR a polarity raid's leader. `userId === null` (or "") clears it.
// Server-side validation (the UI select is not trusted): a non-null leader MUST
// currently sit in one of this raid's parties.
export async function setPolarityRaidLeader(
  guild: Guild,
  raidId: string,
  userId: string | null,
): Promise<PolarityBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const clearing = userId === null || userId === "";
  if (!clearing) {
    const board = await getPolarityBoard(guild);
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
  await db.collection(POLARITY_RAIDS).updateOne(
    { raidId, type: guild },
    { $set: { leaderId: clearing ? null : userId, updatedAt: new Date() } },
  );
  revalidatePolarity();
  return { ok: true, board: await getPolarityBoard(guild) };
}

// GENERATE: auto-assign every unlocked slot across this guild's 6 polarity
// raids. Reuses the shared cohort generator (generate.ts) — the same engine the
// GvG builder runs — with Polarity's two differences:
//   partitionFirst — cohort membership is decided by POWER RANK first, so the
//     top (2 x 5 x partySize) members land in the two main raids exactly.
//   tieBreak "userId" — equal power resolves by userId, so regeneration on
//     unchanged data reproduces the same board instead of reshuffling. (Most of
//     the roster sits at power 0, so nearly every comparison is a tie.)
// Locks survive: pinned members are excluded from the pool and keep their slot.
export async function generatePolarity(
  guild: Guild,
): Promise<PolarityGenerateResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const [members, board, powerMap, settings] = await Promise.all([
    getMembers(guild), // ACTIVE members only (present in `members`)
    getPolarityBoard(guild),
    getPowerMap(guild),
    getSettings(),
  ]);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const powerOf = (uid: string) => powerMap.get(uid) ?? 0;
  const classOf = (uid: string) => memberById.get(uid)?.className ?? null;

  const plans = buildPlans(board.parties, memberById, settings.partySize);
  const planById = new Map(plans.map((p) => [p.partyId, p]));

  // One cohort per raid, in structural order (2 main raids, then 4 normal).
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
    quotas: polarityQuotas,
  });

  // Persist: compact each plan's slots and re-key its locks to the compacted
  // indexes so a pinned member keeps its lock.
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
    await db.collection(POLARITY_PARTIES).bulkWrite(ops, { ordered: false });
  }

  revalidatePolarity();
  return {
    ok: true,
    board: await getPolarityBoard(guild),
    partiesMissing: Object.fromEntries(missing),
    // Overflow beyond capacity is left UNASSIGNED, never dropped.
    unassignedCount: members.filter((m) => !assigned.has(m.userId)).length,
  };
}

// RESET: clear all UNLOCKED slots across this guild's polarity board (members
// return to the pool). LOCKED members stay put; locks unchanged.
export async function resetPolarity(
  guild: Guild,
): Promise<PolarityBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const [board, settings] = await Promise.all([
    getPolarityBoard(guild),
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
    await db.collection(POLARITY_PARTIES).bulkWrite(ops, { ordered: false });
  }
  revalidatePolarity();
  return { ok: true, board: await getPolarityBoard(guild) };
}

// RESET LOCK: clear EVERYTHING for this guild's polarity board — assignments
// AND locks AND raid leaders → a blank board.
export async function resetLockPolarity(
  guild: Guild,
): Promise<PolarityBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const db = await getDb();
  await db
    .collection(POLARITY_PARTIES)
    .updateMany(
      { type: guild },
      { $set: { memberIds: [], lockedSlots: [], updatedAt: new Date() } },
    );
  await db
    .collection(POLARITY_RAIDS)
    .updateMany(
      { type: guild },
      { $set: { leaderId: null, updatedAt: new Date() } },
    );
  revalidatePolarity();
  return { ok: true, board: await getPolarityBoard(guild) };
}
