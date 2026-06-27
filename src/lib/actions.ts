"use server";

import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { getMembers, getParties } from "./data";
import {
  MAX_PARTY_SLOTS,
  isHealer,
  roleForClass,
  type Guild,
  type Member,
  type Party,
} from "./types";

// Server actions that mutate the `parties` collection (db `discordbot`).
// The field structure is FIXED and pre-seeded (12 Main + 18 Sub per guild) by
// data.ts/ensureGuildParties — there is no create/delete/reposition; parties
// are only ever updated in place (member assignments + locks). All writes
// revalidate "/" so the dashboard reflects the new state. When MONGODB_URI is
// unset these are no-ops that return a clear notice (mock mode).

const PARTIES = "parties";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

const NOT_CONFIGURED: ActionResult = {
  ok: false,
  message: "MONGODB_URI is not set — changes are not persisted.",
};

// Persist a party's slot assignments (auto-saved on every drag).
export async function updateParty(
  partyId: string,
  memberIds: string[],
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  // Enforce slot cap + dedupe defensively on the server.
  const deduped = Array.from(new Set(memberIds)).slice(0, MAX_PARTY_SLOTS);
  const db = await getDb();
  await db.collection(PARTIES).updateOne(
    { partyId },
    { $set: { memberIds: deduped, updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true };
}

// Persist the set of locked slot indexes for a party.
export async function setPartyLocks(
  partyId: string,
  lockedSlots: number[],
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const cleaned = Array.from(new Set(lockedSlots)).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < MAX_PARTY_SLOTS,
  );
  const db = await getDb();
  await db.collection(PARTIES).updateOne(
    { partyId },
    { $set: { lockedSlots: cleaned, updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true };
}

// Persist a party rename (cards are still individually renameable).
export async function renameParty(
  partyId: string,
  name: string,
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };
  const db = await getDb();
  await db.collection(PARTIES).updateOne(
    { partyId },
    { $set: { name: trimmed, updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true };
}

// ============================================================================
// Roster auto-fill — Generate / Reset / Reset Lock (all scoped to ONE guild,
// across BOTH its Main + Sub fields). Randomness lives here (server-side), so
// there is no hydration concern.
// ============================================================================

// In-place Fisher–Yates shuffle (server-side randomness only).
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The slot layout for a party during generation: a fixed-length (5) array where
// LOCKED indexes keep their existing member (or stay empty), and UNLOCKED
// indexes are the ones we (re)fill.
interface PartyPlan {
  partyId: string;
  slots: (string | null)[]; // length MAX_PARTY_SLOTS; userId or null
  locked: Set<number>;
  // True if the party already contains a Priest among its RETAINED members
  // (after unlocked slots are cleared, that means a locked Priest). This is the
  // SAME live class-based check the badge/toolbar use; a party that already has
  // a Priest is not given another and is not flagged.
  hasPriest: boolean;
}

// Persist every party's slots (compacted to memberIds, preserving order so a
// locked slot keeps its index). We store memberIds as the slot array with nulls
// removed BUT keeping positional meaning: a locked slot at index i must keep its
// member at index i, so we write a length-5 array with empties trimmed only
// from the tail — to keep lock indexes valid we store the full positional array
// with nulls collapsed to a compact list while locks reference indexes. To keep
// the existing (flat memberIds[i] == slot i) contract intact, we write the
// positional array directly, replacing null with a removed entry only when no
// later slot is filled. Simpler + correct: store the positional array verbatim
// using a sentinel-free compaction that preserves indexes (we keep nulls as
// gaps by writing the array up to the last filled/locked slot).
function slotsToMemberIds(slots: (string | null)[]): string[] {
  // Keep positional meaning up to the last occupied OR locked slot is handled
  // by the caller; here we simply drop nulls, because the UI renders by
  // sequential index and locks are re-derived per render. To preserve lock
  // alignment we instead keep nulls as placeholders is NOT representable in a
  // string[]. So generation writes a DENSE array and we re-align locks below.
  return slots.filter((s): s is string => s !== null);
}

// Build the per-party plan from current parties: which slots are locked, which
// (locked) members are pinned, and whether the party already contains a Priest
// among its retained (locked) members.
function buildPlans(parties: Party[], memberById: Map<string, Member>): PartyPlan[] {
  return parties.map((p) => {
    const locked = new Set(p.lockedSlots);
    const slots: (string | null)[] = Array.from(
      { length: MAX_PARTY_SLOTS },
      (_, i) => p.memberIds[i] ?? null,
    );
    // Unlocked slots start empty (their members return to the pool).
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
      if (!locked.has(i)) slots[i] = null;
    }
    // Live class-based Priest check over the RETAINED (non-null) members.
    const hasPriest = slots.some(
      (uid) => uid !== null && isHealer(memberById.get(uid)?.className ?? null),
    );
    return { partyId: p.partyId, slots, locked, hasPriest };
  });
}

// Core generation over a set of parties + the available member pool.
// Mutates plans' slots. Returns the set of partyIds left WITHOUT a healer.
function generatePlans(plans: PartyPlan[], pool: Member[]): Set<string> {
  // Pools by role from the AVAILABLE members (not pinned in a locked slot).
  const healers = shuffle(pool.filter((m) => isHealer(m.className)));
  const tanks = shuffle(
    pool.filter((m) => roleForClass(m.className) === "tank"),
  );
  const dps = shuffle(
    pool.filter(
      (m) => !isHealer(m.className) && roleForClass(m.className) !== "tank",
    ),
  );
  // "tank" role == Knight; healer == Priest; everything else == dps/flex.

  const used = new Set<string>();
  function take(list: Member[]): string | null {
    while (list.length) {
      const m = list.pop()!;
      if (!used.has(m.userId)) {
        used.add(m.userId);
        return m.userId;
      }
    }
    return null;
  }

  const freeSlots = (plan: PartyPlan): number[] => {
    const out: number[] = [];
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
      if (!plan.locked.has(i) && plan.slots[i] === null) out.push(i);
    }
    return out;
  };
  const place = (plan: PartyPlan, uid: string): boolean => {
    const free = freeSlots(plan);
    if (free.length === 0) return false;
    plan.slots[free[0]] = uid;
    return true;
  };

  const noHealer = new Set<string>();

  // PASS 1 — HARD RULE: a Priest in every party that doesn't already have one.
  // A party that already contains a Priest (locked) is skipped — not given a
  // second one, not flagged.
  for (const plan of plans) {
    if (plan.hasPriest) continue;
    if (freeSlots(plan).length === 0) {
      noHealer.add(plan.partyId); // full of locks, no room for a healer
      continue;
    }
    const h = take(healers);
    if (h) place(plan, h);
    else noHealer.add(plan.partyId); // healer pool exhausted
  }

  // PASS 2 — BALANCED: aim for ~1 Tank then fill the rest with DPS (then any
  // leftover healers as flex) per party, randomized, until pools run dry.
  // One tank per party first.
  for (const plan of plans) {
    if (freeSlots(plan).length === 0) continue;
    const t = take(tanks);
    if (t) place(plan, t);
  }
  // Fill remaining free slots with DPS, then leftover tanks, then leftover
  // healers — round-robin across parties so fills spread out rather than
  // packing the first parties.
  const fillers = shuffle([...dps, ...tanks, ...healers].filter((m) => !used.has(m.userId)));
  let progressed = true;
  while (fillers.length && progressed) {
    progressed = false;
    for (const plan of plans) {
      if (freeSlots(plan).length === 0) continue;
      // pull next unused filler
      let uid: string | null = null;
      while (fillers.length) {
        const m = fillers.pop()!;
        if (!used.has(m.userId)) {
          used.add(m.userId);
          uid = m.userId;
          break;
        }
      }
      if (uid) {
        place(plan, uid);
        progressed = true;
      }
      if (!fillers.length) break;
    }
  }

  return noHealer;
}

export interface BulkResult extends ActionResult {
  parties?: Party[];
}

export interface GenerateResult extends BulkResult {
  partiesWithoutHealer?: string[];
}

// GENERATE: auto-assign unlocked slots for the current guild's parties (both
// fields). Preserves locked slots; no member appears in two parties; respects
// the 5-slot cap. Persists all assignments.
export async function generateGuild(guild: Guild): Promise<GenerateResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const [members, parties] = await Promise.all([
    getMembers(guild),
    getParties(guild),
  ]);
  const memberById = new Map(members.map((m) => [m.userId, m]));

  const plans = buildPlans(parties, memberById);

  // Available pool = guild members NOT pinned in any locked slot.
  const pinned = new Set<string>();
  for (const plan of plans) {
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) pinned.add(uid);
    }
  }
  const pool = members.filter((m) => !pinned.has(m.userId));

  const noHealer = generatePlans(plans, pool);

  // Persist. Compact each plan's slots to a memberIds array. To preserve lock
  // index alignment, we write the slots array with trailing nulls trimmed but
  // internal gaps closed — since locks are stored as indexes, we re-key locks
  // to the compacted positions so a locked member keeps its lock.
  const db = await getDb();
  const ops = plans.map((plan) => {
    // Compact slots -> memberIds, and remap lockedSlots to the new indexes of
    // the members that were locked (so a pinned member stays locked even though
    // its index shifts after compaction).
    const lockedUids = new Set<string>();
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) lockedUids.add(uid);
    }
    const memberIds = slotsToMemberIds(plan.slots);
    const newLocked: number[] = [];
    memberIds.forEach((uid, idx) => {
      if (lockedUids.has(uid)) newLocked.push(idx);
    });
    return {
      updateOne: {
        filter: { partyId: plan.partyId },
        update: {
          $set: {
            memberIds,
            lockedSlots: newLocked,
            updatedAt: new Date(),
          },
        },
      },
    };
  });
  if (ops.length) await db.collection(PARTIES).bulkWrite(ops, { ordered: false });

  revalidatePath("/");
  const fresh = await getParties(guild);
  return {
    ok: true,
    parties: fresh,
    partiesWithoutHealer: Array.from(noHealer),
  };
}

// RESET: clear all UNLOCKED slot assignments for the current guild (members
// back to pool). LOCKED members stay put; locks unchanged. Persists.
export async function resetGuild(guild: Guild): Promise<BulkResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const parties = await getParties(guild);
  const db = await getDb();
  const ops = parties.map((p) => {
    const locked = new Set(p.lockedSlots);
    // Keep only members sitting in a locked slot; compact + remap locks.
    const kept: string[] = [];
    const keptLocked: number[] = [];
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
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
          $set: { memberIds: kept, lockedSlots: keptLocked, updatedAt: new Date() },
        },
      },
    };
  });
  if (ops.length) await db.collection(PARTIES).bulkWrite(ops, { ordered: false });

  revalidatePath("/");
  return { ok: true, parties: await getParties(guild) };
}

// RESET LOCK: clear EVERYTHING for the current guild — all slot assignments AND
// all locks removed → blank board. Persists.
export async function resetLockGuild(guild: Guild): Promise<BulkResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const db = await getDb();
  await db.collection(PARTIES).updateMany(
    { type: guild },
    { $set: { memberIds: [], lockedSlots: [], updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true, parties: await getParties(guild) };
}
