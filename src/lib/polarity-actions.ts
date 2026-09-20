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
import { polarityNormalQuotas, polarityPartyIds } from "./polarity";
import {
  fillMainRaidsByDps,
  fillNormalRaidPriests,
  seatSparePriests,
  type DpsRow,
} from "./polarity-generate";
import { getPolarityDpsMap } from "./polarity-dps-data";
import { HEALER_CLASS, type Guild } from "./types";

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
  // Covers BOTH halves of the board: the main parties left without a priest by
  // the DPS pass, and the normal parties the shared engine could not satisfy.
  partiesMissing?: Record<string, string[]>;
  // Members of this guild who did not fit anywhere (roster > total capacity).
  unassignedCount?: number;
  // ---- main-raid (DPS) reporting -----------------------------------------
  // Pool members carrying an imported DPS row — the only ones a main raid can
  // take.
  dpsEligibleCount?: number;
  // Pool members with NO imported DPS row. They cannot enter a main raid on
  // DPS and fell through to the normal-raid pool.
  noDpsCount?: number;
  // Priests seeded into main parties by the one-per-party pass (never two;
  // a SECOND priest can only arrive later, via the spare-seat pass).
  mainPriestsSeeded?: number;
  // Main parties that could not be given a priest, in board order.
  mainPartiesMissingPriest?: string[];
  // ---- normal-raid priest reporting --------------------------------------
  // Priests seeded into NORMAL parties by the one-per-party pass (never two;
  // a SECOND priest can only arrive later, via the spare-seat pass).
  normalPriestsSeeded?: number;
  // Normal parties that could not be given a priest, in board order.
  normalPartiesMissingPriest?: string[];
  // Priests still in the pool AFTER the spare-seat pass — i.e. every party
  // already had one AND there was no empty seat left for them. They are part of
  // `unassignedCount`. Zero whenever the board filled.
  surplusPriestCount?: number;
  // Surplus priests that took an EMPTY seat as a party's SECOND priest, once
  // the non-priests ran out. 0 on a roster with enough non-priests to fill the
  // board, which is the normal case for the main raids.
  sparePriestsSeated?: number;
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
// raids. TWO HALVES, deliberately, because the two kinds of raid now rank on
// different data:
//
//   MAIN raids (2 x 5 parties) — ranked by the IMPORTED DPS figure, not power.
//     Handled by fillMainRaidsByDps (polarity-generate.ts): one priest per
//     party from a DPS-ranked priest pool, then the remaining slots from the
//     non-priest DPS ranking. A member with NO imported DPS row cannot enter a
//     main raid at all — they fall through to the normal pool, and the count
//     comes back in the result so the UI can say so.
//
//   NORMAL raids (4 x 5 parties) — still ranked on `power` through the shared
//     cohort generator (generate.ts), with partitionFirst and tieBreak
//     "userId", and still the same even split across the four. TWO things
//     changed on 2026-09-20:
//       - the raids are 5 parties each, not 8 (POLARITY_NORMAL_PARTY_COUNT);
//       - fillNormalRaidPriests runs FIRST and seats one priest in
//         each normal party, so every party on the board is guaranteed a
//         Priest, not just the main ones. That rule is HARDWIRED, not read
//         from `settings.requiredClasses` — that setting is `[]` in
//         production and it is shared with the GvG builder, which stays
//         untouched. generate.ts itself is byte-identical.
//     Priests are then excluded WHOLESALE from the pool handed to
//     generateCohorts, so the engine can never be the thing that puts a second
//     priest in a party.
//
//   SPARE SEATS, LAST (added 2026-09-20) — seatSparePriests. Conrad reversed
//     the old "a party is never given a second priest" rule once he saw what it
//     cost: daddy 5 and mummy 7 priests sitting unassigned against exactly that
//     many EMPTY seats. A leftover priest may now take an empty seat, but ONLY
//     after both halves have had their one-per-party pass AND the non-priests
//     have been exhausted — which is why this runs third, over the whole board
//     at once, rather than inside either fill. Main raids are offered the spare
//     seats first and only to priests carrying an imported DPS row, because
//     main-raid eligibility still requires one.
//
// tieBreak "userId" — equal power resolves by userId, so regeneration on
// unchanged data reproduces the same board instead of reshuffling. (Most of
// the roster sits at power 0, so nearly every comparison is a tie.) The DPS
// pass is deterministic for the same reason: DPS desc, then userId.
//
// Locks survive: pinned members are excluded from the pool and keep their slot,
// and a locked priest already in a main party stops that party being given a
// second one.
//
// The GvG `parties` / `raidGroups` collections are never written here, and
// `memberMeta.power` is never written here either — this action only moves
// people between polarity parties.
export async function generatePolarity(
  guild: Guild,
): Promise<PolarityGenerateResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const [members, board, powerMap, settings, dpsMap] = await Promise.all([
    getMembers(guild), // ACTIVE members only (present in `members`)
    getPolarityBoard(guild),
    getPowerMap(guild),
    getSettings(),
    getPolarityDpsMap(guild),
  ]);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const powerOf = (uid: string) => powerMap.get(uid) ?? 0;
  const classOf = (uid: string) => memberById.get(uid)?.className ?? null;
  // ABSENT means "no imported row", never "DPS 0" — the generator uses that
  // distinction to decide main-raid eligibility.
  const dpsOf = (uid: string): DpsRow | null => {
    const row = dpsMap.get(uid);
    return row ? { dps: row.dps, className: row.className || null } : null;
  };

  const plans = buildPlans(board.parties, memberById, settings.partySize);
  const planById = new Map(plans.map((p) => [p.partyId, p]));

  // One cohort per raid, in structural order, split by kind. `board.raids` is
  // already ordered main-first, but the split is by `kind` rather than by index
  // so it cannot silently break if the structure ever changes.
  const cohortFor = (raidId: string): PartyPlan[] =>
    board.parties
      .filter((p) => p.raidId === raidId)
      .sort((a, b) => a.position - b.position)
      .map((p) => planById.get(p.partyId))
      .filter((p): p is PartyPlan => p !== undefined);

  const mainCohorts = board.raids
    .filter((r) => r.kind === "main")
    .map((r) => cohortFor(r.raidId));
  const normalCohorts = board.raids
    .filter((r) => r.kind !== "main")
    .map((r) => cohortFor(r.raidId));

  // Available pool = guild members NOT pinned in any locked slot.
  const pinned = new Set<string>();
  for (const plan of plans) {
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) pinned.add(uid);
    }
  }
  const pool = members.filter((m) => !pinned.has(m.userId));

  // ---- 1. MAIN raids, on imported DPS ------------------------------------
  const mainFill = fillMainRaidsByDps(
    mainCohorts,
    pool,
    dpsOf,
    classOf,
    HEALER_CLASS,
  );

  // ---- 2. NORMAL raids: one priest per party FIRST -----------------------
  // Everyone the main raids did not take, including every member with no
  // imported DPS row and every priest beyond the ten main seats.
  const normalPool = pool.filter((m) => !mainFill.placed.has(m.userId));
  // The SAME "is a priest" rule the main pass used: the imported Class column
  // when there is one, the stored className otherwise. In practice almost
  // nobody in the normal pool has an imported row, so className dominates.
  const isPriest = (uid: string) =>
    (dpsOf(uid)?.className ?? classOf(uid)) === HEALER_CLASS;
  const normalPriests = fillNormalRaidPriests(
    normalCohorts,
    normalPool,
    isPriest,
    powerOf,
    classOf,
    HEALER_CLASS,
  );

  // ---- 3. NORMAL raids, the rest on power — unchanged engine -------------
  // EVERY priest is withheld here, not just the seated ones: the engine must
  // never be able to drop a second priest into a party while another party is
  // still waiting for its first. A surplus priest gets its chance in step 4,
  // after the non-priests have been exhausted — not here.
  const normalFillPool = normalPool.filter((m) => !isPriest(m.userId));
  const normalMissing = generateCohorts(
    normalCohorts,
    normalFillPool,
    powerOf,
    classOf,
    settings,
    {
      tieBreak: "userId",
      partitionFirst: true,
      quotas: polarityNormalQuotas,
    },
  );

  // ---- 4. SPARE SEATS: leftover priests may now take an EMPTY one ---------
  // LAST, deliberately. Every party on the board — main and normal — has had
  // its one-per-party pass and the non-priests have had their turn, so nothing
  // seated here can cost a party its FIRST priest.
  //
  // The mains get first refusal, but only from leftovers that carry an imported
  // DPS row: main-raid eligibility is unchanged, and a member without one still
  // cannot enter a main raid. They are re-ranked on DPS because that is what
  // the main half balances on. In practice this seats nobody — 50 main seats
  // against ~147 members means the mains never run out of non-priests — but the
  // rule is applied to both halves rather than special-cased.
  const leftoverPriests = normalPriests.leftover;
  const mainSpare = seatSparePriests(
    mainCohorts.flat(),
    leftoverPriests
      .filter((m) => dpsOf(m.userId) !== null)
      .sort(
        (a, b) =>
          (dpsOf(b.userId)?.dps ?? 0) - (dpsOf(a.userId)?.dps ?? 0) ||
          a.userId.localeCompare(b.userId),
      ),
    isPriest,
    (uid) => dpsOf(uid)?.dps ?? 0,
    classOf,
  );
  // Whoever the mains did not take, in the power order they already carry.
  const normalSpare = seatSparePriests(
    normalCohorts.flat(),
    leftoverPriests.filter((m) => !mainSpare.placed.has(m.userId)),
    isPriest,
    powerOf,
    classOf,
  );
  const sparePriestsSeated = mainSpare.seated.length + normalSpare.seated.length;

  // Union rather than overwrite — a party can legitimately be flagged by more
  // than one source (the hardwired priest rule here, settings.requiredClasses
  // inside the engine) and neither flag may silently drop the other.
  const missing = new Map<string, string[]>();
  for (const src of [
    mainFill.missing,
    normalPriests.missing,
    normalMissing,
  ]) {
    for (const [partyId, classes] of src) {
      const list = missing.get(partyId);
      if (!list) {
        missing.set(partyId, [...classes]);
        continue;
      }
      for (const cls of classes) if (!list.includes(cls)) list.push(cls);
    }
  }

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
    dpsEligibleCount: mainFill.eligible,
    noDpsCount: mainFill.noDps,
    mainPriestsSeeded: mainFill.seededPriests,
    mainPartiesMissingPriest: mainFill.partiesMissingPriest,
    normalPriestsSeeded: normalPriests.seededPriests,
    normalPartiesMissingPriest: normalPriests.partiesMissingPriest,
    // AFTER the spare-seat pass: only the priests no empty seat could absorb.
    surplusPriestCount: normalPriests.priestsLeftOver - sparePriestsSeated,
    sparePriestsSeated,
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
//
// SCOPED BY PARTY ID, not by `{ type: guild }`. The collection still holds the
// surplus party documents from when a normal raid ran 8 parties (positions
// 5-7); those rows are hidden, and hidden means never written, not cleared. A
// `{ type: guild }` updateMany would wipe them.
export async function resetLockPolarity(
  guild: Guild,
): Promise<PolarityBoardResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const db = await getDb();
  await db
    .collection(POLARITY_PARTIES)
    .updateMany(
      { partyId: { $in: polarityPartyIds(guild) } },
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
