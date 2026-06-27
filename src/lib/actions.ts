"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { getMembers, getParties, getPowerMap, getRaidGroups } from "./data";
import { MOCK_MEMBER_META, MOCK_RAID_GROUPS } from "./mock";
import {
  MAX_PARTY_SLOTS,
  isHealer,
  normalizePower,
  roleForClass,
  type Field,
  type Guild,
  type Member,
  type Party,
  type RaidGroup,
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
  field: Field; // "main" (elite tier) | "sub" — Main is staffed first
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
    return { partyId: p.partyId, field: p.field, slots, locked, hasPriest };
  });
}

// Core generation — POWER-AWARE, TWO-TIER (Main = elite, Sub = the rest).
// Mutates plans' slots. Returns the set of partyIds left WITHOUT a healer.
//
// Rules (after locks; locked members + locked Priests are fixed and count
// toward their party from the start):
//   1. PRIEST hard rule, power-based + Main-first: priestless parties get a
//      Priest, sorted by power DESC, MAIN parties first then SUB — so the
//      strongest non-locked Priests anchor Main. A LOCKED Priest counts as
//      present and is not reassigned. Parties left without one are flagged.
//   2. TIER PARTITION: rank the remaining available members by power DESC and
//      give the top ones to MAIN (up to Main's remaining free-slot capacity);
//      the rest go to SUB. Net: Main's pool outpowers Sub's.
//   3. PER-FIELD BALANCE: within Main's parties (and separately within Sub's),
//      do a ~1-tank pass then a largest-into-smallest-bin balance fill from that
//      field's tier pool — so each tier is internally even, NOT stacked into
//      party 1. Main is never balanced against Sub (Main is intentionally
//      stronger).
// Randomness applies ONLY to ties (equal-power members shuffle); the
// power-priority ordering is otherwise deterministic, so reruns are similar by
// design (Main consistently gets the best).
function generatePlans(
  plans: PartyPlan[],
  pool: Member[],
  powerOf: (uid: string) => number,
): Set<string> {
  // Sort by power DESC; equal-power runs shuffled (ties only).
  const byPowerDesc = (list: Member[]) =>
    shuffle(list.slice()).sort((a, b) => powerOf(b.userId) - powerOf(a.userId));

  const used = new Set<string>();
  const freeSlots = (plan: PartyPlan): number[] => {
    const out: number[] = [];
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
      if (!plan.locked.has(i) && plan.slots[i] === null) out.push(i);
    }
    return out;
  };
  const place = (plan: PartyPlan, uid: string) => {
    const free = freeSlots(plan);
    if (free.length === 0) return false;
    plan.slots[free[0]] = uid;
    return true;
  };

  // Running power per party (seeded with locked/existing members).
  const power = new Map<string, number>();
  for (const plan of plans) {
    let sum = 0;
    for (const uid of plan.slots) if (uid) sum += powerOf(uid);
    power.set(plan.partyId, sum);
  }
  const addPower = (plan: PartyPlan, uid: string) =>
    power.set(plan.partyId, (power.get(plan.partyId) ?? 0) + powerOf(uid));

  // Lowest-power open party AMONG a given subset (a single field's plans).
  // Ties broken by partyId for determinism.
  const lowestOpenIn = (
    subset: PartyPlan[],
    pred?: (p: PartyPlan) => boolean,
  ): PartyPlan | null => {
    let best: PartyPlan | null = null;
    for (const plan of subset) {
      if (freeSlots(plan).length === 0) continue;
      if (pred && !pred(plan)) continue;
      const pp = power.get(plan.partyId) ?? 0;
      const bp = best ? (power.get(best.partyId) ?? 0) : 0;
      if (
        best === null ||
        pp < bp ||
        (pp === bp && plan.partyId.localeCompare(best.partyId) < 0)
      ) {
        best = plan;
      }
    }
    return best;
  };
  const takeNext = (list: Member[]): Member | null => {
    while (list.length) {
      const m = list.shift()!;
      if (!used.has(m.userId)) {
        used.add(m.userId);
        return m;
      }
    }
    return null;
  };

  const mainPlans = plans.filter((p) => p.field === "main");
  const subPlans = plans.filter((p) => p.field === "sub");
  const noHealer = new Set<string>();

  // ---- STEP 1: PRIEST hard rule, power DESC, MAIN parties first then SUB. ----
  const healers = byPowerDesc(pool.filter((m) => isHealer(m.className)));
  const assignPriests = (subset: PartyPlan[]) => {
    const need = subset.filter((p) => !p.hasPriest).length;
    for (let k = 0; k < need; k++) {
      const target = lowestOpenIn(
        subset,
        (p) => !p.hasPriest && freeSlots(p).length > 0,
      );
      if (!target) break;
      const h = takeNext(healers); // strongest remaining Priest
      if (!h) break;
      place(target, h.userId);
      addPower(target, h.userId);
      target.hasPriest = true;
    }
  };
  assignPriests(mainPlans); // Main anchored first by the strongest Priests
  assignPriests(subPlans);
  for (const plan of plans) if (!plan.hasPriest) noHealer.add(plan.partyId);

  // ---- STEP 2: TIER PARTITION of the remaining (non-priest-assigned) pool. ----
  // Highest-power remainder fills MAIN up to its free capacity; rest → SUB.
  const remaining = byPowerDesc(pool.filter((m) => !used.has(m.userId)));
  const mainCapacity = mainPlans.reduce((s, p) => s + freeSlots(p).length, 0);
  const mainPool = remaining.slice(0, mainCapacity);
  const subPool = remaining.slice(mainCapacity);

  // ---- STEP 3: per-field fill — ~1 tank pass, then balance fill. ----
  const fillField = (subset: PartyPlan[], fieldPool: Member[]) => {
    const localUsed = new Set<string>();
    const take = (pred: (m: Member) => boolean): Member | null => {
      for (let i = 0; i < fieldPool.length; i++) {
        const m = fieldPool[i];
        if (localUsed.has(m.userId) || used.has(m.userId)) continue;
        if (!pred(m)) continue;
        localUsed.add(m.userId);
        used.add(m.userId);
        return m;
      }
      return null;
    };

    // Tank spread: ~1 tank into each lowest-power open party (within field).
    for (let k = 0; k < subset.length; k++) {
      const target = lowestOpenIn(subset);
      if (!target) break;
      const t = take((m) => roleForClass(m.className) === "tank");
      if (!t) break;
      place(target, t.userId);
      addPower(target, t.userId);
    }

    // Balance fill: strongest remaining (this field's pool) → lowest-power open
    // party in this field. Largest-into-smallest-bin keeps the tier even.
    for (const m of fieldPool) {
      if (localUsed.has(m.userId) || used.has(m.userId)) continue;
      const target = lowestOpenIn(subset);
      if (!target) break; // no free slots left in this field
      localUsed.add(m.userId);
      used.add(m.userId);
      place(target, m.userId);
      addPower(target, m.userId);
    }
  };
  fillField(mainPlans, mainPool);
  fillField(subPlans, subPool);

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

  const [members, parties, powerMap] = await Promise.all([
    getMembers(guild), // ACTIVE members only (present in `members`)
    getParties(guild),
    getPowerMap(guild),
  ]);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const powerOf = (uid: string) => powerMap.get(uid) ?? 0;

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

  const noHealer = generatePlans(plans, pool, powerOf);

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

// ============================================================================
// RAID GROUPS — the layer ABOVE parties (Members → Parties → Raid Groups).
// Scoped per guild AND per field; a party belongs to AT MOST ONE raid group
// within its (type, field). Manual create/delete. All ops auto-save and return
// the fresh raid-group list for the guild (optimistic UI). Mock mode mutates an
// in-memory store.
// ============================================================================

const RAID_GROUPS = "raidGroups";

export interface RaidResult extends ActionResult {
  raidGroups?: RaidGroup[];
}

function revalidateRaids() {
  revalidatePath("/raids");
  revalidatePath("/");
}

// mock-mode helper: return this guild's raid groups, deterministically ordered.
function mockReturn(guild: Guild): RaidResult {
  const list = MOCK_RAID_GROUPS.filter((r) => r.type === guild)
    .map((r) => ({ ...r, partyIds: [...r.partyIds] }))
    .sort((a, b) =>
      a.position !== b.position
        ? a.position - b.position
        : a.raidGroupId.localeCompare(b.raidGroupId),
    );
  return { ok: true, raidGroups: list };
}

export async function createRaidGroup(
  guild: Guild,
  field: Field,
): Promise<RaidResult> {
  if (!isMongoConfigured) {
    const count = MOCK_RAID_GROUPS.filter(
      (r) => r.type === guild && r.field === field,
    ).length;
    MOCK_RAID_GROUPS.push({
      raidGroupId: randomUUID(),
      type: guild,
      field,
      name: `${field === "main" ? "Main" : "Sub"} Raid ${count + 1}`,
      partyIds: [],
      position: count,
      updatedAt: new Date().toISOString(),
    });
    return mockReturn(guild);
  }

  const db = await getDb();
  const col = db.collection<RaidGroup>(RAID_GROUPS);
  const count = await col.countDocuments({ type: guild, field });
  await col.insertOne({
    raidGroupId: randomUUID(),
    type: guild,
    field,
    name: `${field === "main" ? "Main" : "Sub"} Raid ${count + 1}`,
    partyIds: [],
    position: count,
    updatedAt: new Date().toISOString(),
  });
  revalidateRaids();
  return { ok: true, raidGroups: await getRaidGroups(guild) };
}

export async function renameRaidGroup(
  guild: Guild,
  raidGroupId: string,
  name: string,
): Promise<RaidResult> {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };

  if (!isMongoConfigured) {
    const r = MOCK_RAID_GROUPS.find((g) => g.raidGroupId === raidGroupId);
    if (r) r.name = trimmed;
    return mockReturn(guild);
  }
  const db = await getDb();
  await db.collection<RaidGroup>(RAID_GROUPS).updateOne(
    { raidGroupId },
    { $set: { name: trimmed, updatedAt: new Date().toISOString() } },
  );
  revalidateRaids();
  return { ok: true, raidGroups: await getRaidGroups(guild) };
}

// DELETE: remove ONLY the raid group. Its parties are NOT deleted — they simply
// stop being in any raid group, so they return to the field's unassigned pool.
// (Parties + their members are untouched.)
export async function deleteRaidGroup(
  guild: Guild,
  raidGroupId: string,
): Promise<RaidResult> {
  if (!isMongoConfigured) {
    const i = MOCK_RAID_GROUPS.findIndex((g) => g.raidGroupId === raidGroupId);
    if (i >= 0) MOCK_RAID_GROUPS.splice(i, 1);
    return mockReturn(guild);
  }
  const db = await getDb();
  await db.collection<RaidGroup>(RAID_GROUPS).deleteOne({ raidGroupId });
  revalidateRaids();
  return { ok: true, raidGroups: await getRaidGroups(guild) };
}

// ASSIGN / MOVE a party into a raid group. Enforces the one-raid-per-party
// invariant SERVER-SIDE: the party is first pulled from EVERY other raid group
// in the same (type, field), then appended to the target. moveParty is the same
// operation (assigning to a different group implicitly moves it).
async function assignPartyImpl(
  guild: Guild,
  partyId: string,
  toRaidGroupId: string,
): Promise<RaidResult> {
  if (!isMongoConfigured) {
    const target = MOCK_RAID_GROUPS.find(
      (g) => g.raidGroupId === toRaidGroupId && g.type === guild,
    );
    if (!target) return { ok: false, message: "Raid group not found." };
    for (const g of MOCK_RAID_GROUPS) {
      if (g.type === guild && g.field === target.field) {
        g.partyIds = g.partyIds.filter((id) => id !== partyId);
      }
    }
    if (!target.partyIds.includes(partyId)) target.partyIds.push(partyId);
    return mockReturn(guild);
  }

  const db = await getDb();
  const col = db.collection<RaidGroup>(RAID_GROUPS);
  const target = await col.findOne({ raidGroupId: toRaidGroupId, type: guild });
  if (!target) return { ok: false, message: "Raid group not found." };

  // Pull the party from every raid group of the same (type, field)...
  await col.updateMany(
    { type: guild, field: target.field },
    {
      $pull: { partyIds: partyId },
      $set: { updatedAt: new Date().toISOString() },
    },
  );
  // ...then add it to the target (addToSet = no dupes).
  await col.updateOne(
    { raidGroupId: toRaidGroupId },
    {
      $addToSet: { partyIds: partyId },
      $set: { updatedAt: new Date().toISOString() },
    },
  );
  revalidateRaids();
  return { ok: true, raidGroups: await getRaidGroups(guild) };
}

export async function assignPartyToRaid(
  guild: Guild,
  partyId: string,
  raidGroupId: string,
): Promise<RaidResult> {
  return assignPartyImpl(guild, partyId, raidGroupId);
}

export async function moveParty(
  guild: Guild,
  partyId: string,
  toRaidGroupId: string,
): Promise<RaidResult> {
  return assignPartyImpl(guild, partyId, toRaidGroupId);
}

// REMOVE a party from its raid group → back to the field's unassigned pool.
// (Pulled from ALL of the guild's raid groups defensively.)
export async function removePartyFromRaid(
  guild: Guild,
  partyId: string,
): Promise<RaidResult> {
  if (!isMongoConfigured) {
    for (const g of MOCK_RAID_GROUPS) {
      if (g.type === guild) {
        g.partyIds = g.partyIds.filter((id) => id !== partyId);
      }
    }
    return mockReturn(guild);
  }
  const db = await getDb();
  await db.collection<RaidGroup>(RAID_GROUPS).updateMany(
    { type: guild },
    {
      $pull: { partyIds: partyId },
      $set: { updatedAt: new Date().toISOString() },
    },
  );
  revalidateRaids();
  return { ok: true, raidGroups: await getRaidGroups(guild) };
}

// ============================================================================
// MEMBER POWER — manual rating stored in the web-owned `memberMeta` collection
// (never in `members`, so the bot's sync can't wipe it). Validates a
// non-negative integer; persists; revalidates the pages that use power.
// ============================================================================

const MEMBER_META = "memberMeta";

export interface PowerResult extends ActionResult {
  userId?: string;
  power?: number;
}

export async function setMemberPower(
  userId: string,
  power: number,
): Promise<PowerResult> {
  const value = normalizePower(power);

  if (!isMongoConfigured) {
    const existing = MOCK_MEMBER_META.get(userId);
    if (existing) {
      existing.power = value;
      existing.updatedAt = new Date().toISOString();
    }
    // Power feeds Generate (/) and is shown on /members.
    revalidatePath("/members");
    revalidatePath("/");
    return { ok: true, userId, power: value };
  }

  const db = await getDb();
  // Only update an EXISTING meta row's power (rows are created by the on-load
  // sync). $set power + updatedAt; never touches cached roster fields here.
  await db.collection(MEMBER_META).updateOne(
    { userId },
    { $set: { power: value, updatedAt: new Date() } },
  );
  revalidatePath("/members");
  revalidatePath("/");
  return { ok: true, userId, power: value };
}
