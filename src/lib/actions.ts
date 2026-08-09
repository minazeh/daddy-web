"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import {
  getMembers,
  getParties,
  getPowerMap,
  getRaidGroups,
  getSettings,
} from "./data";
import { MOCK_MEMBER_META, MOCK_RAID_GROUPS, MOCK_SETTINGS } from "./mock";
import {
  buildPlans,
  generateCohorts,
  slotsToMemberIds,
  type PartyPlan,
} from "./generate";
import {
  normalizePower,
  raidGroupMemberIds,
  validateSettings,
  type Field,
  type Guild,
  type Party,
  type RaidGroup,
  type Settings,
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

// Persist a party's slot assignments (auto-saved on every drag). The slot cap
// is now settings.partySize (was a hardcoded 5).
export async function updateParty(
  partyId: string,
  memberIds: string[],
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const { partySize } = await getSettings();
  const deduped = Array.from(new Set(memberIds)).slice(0, partySize);
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

  const { partySize } = await getSettings();
  const cleaned = Array.from(new Set(lockedSlots)).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < partySize,
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
// across BOTH its Main + Sub fields).
//
// The composition engine itself now lives in ./generate.ts (extracted verbatim
// so Polarity Raids can reuse it instead of forking a second generator). This
// file supplies the GvG-specific wiring: two cohorts — Main field first, then
// Sub field — with the legacy ordering (required classes across all cohorts,
// THEN the power split) and the legacy random tie-break. Randomness lives
// server-side, so there is no hydration concern.
// ============================================================================

export interface BulkResult extends ActionResult {
  parties?: Party[];
}

export interface GenerateResult extends BulkResult {
  // partyId → required classNames the party is still missing (for flagging).
  partiesMissing?: Record<string, string[]>;
}

// GENERATE: auto-assign unlocked slots for the current guild's parties (both
// fields). Preserves locked slots; no member appears in two parties; respects
// settings.partySize. Persists all assignments. Hard rule + role-spread come
// from settings (requiredClasses / classRoles).
export async function generateGuild(guild: Guild): Promise<GenerateResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const [members, parties, powerMap, settings] = await Promise.all([
    getMembers(guild), // ACTIVE members only (present in `members`)
    getParties(guild),
    getPowerMap(guild),
    getSettings(),
  ]);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const powerOf = (uid: string) => powerMap.get(uid) ?? 0;
  const classOf = (uid: string) => memberById.get(uid)?.className ?? null;

  const plans = buildPlans(parties, memberById, settings.partySize);

  // Two cohorts, in priority order: the Main field (elite tier) then the Sub
  // field. `buildPlans` preserves the input order, so a partyId lookup keeps
  // each plan paired with the party it came from.
  const planById = new Map(plans.map((p) => [p.partyId, p]));
  const cohortFor = (field: Field): PartyPlan[] =>
    parties
      .filter((p) => p.field === field)
      .map((p) => planById.get(p.partyId))
      .filter((p): p is PartyPlan => p !== undefined);
  const cohorts = [cohortFor("main"), cohortFor("sub")];

  // Available pool = guild members NOT pinned in any locked slot.
  const pinned = new Set<string>();
  for (const plan of plans) {
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) pinned.add(uid);
    }
  }
  const pool = members.filter((m) => !pinned.has(m.userId));

  // Legacy GvG semantics: required classes first across BOTH cohorts (Main
  // gets first pick), then the power split (Main absorbs its free capacity,
  // Sub takes the rest), random tie-break. These are generateCohorts' defaults.
  const missing = generateCohorts(cohorts, pool, powerOf, classOf, settings);

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
    partiesMissing: Object.fromEntries(missing),
  };
}

// RESET: clear all UNLOCKED slot assignments for the current guild (members
// back to pool). LOCKED members stay put; locks unchanged. Persists.
export async function resetGuild(guild: Guild): Promise<BulkResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const [parties, settings] = await Promise.all([
    getParties(guild),
    getSettings(),
  ]);
  const db = await getDb();
  const ops = parties.map((p) => {
    const locked = new Set(p.lockedSlots);
    // Keep only members sitting in a locked slot; compact + remap locks.
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
      leaderId: null,
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
    leaderId: null,
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

// SET / CLEAR a raid group's leader. `userId === null` (or "") clears it.
// Server-side validation (the UI select is not trusted): a non-null leader MUST
// be a member of one of this raid group's parties (the union — raidGroupMemberIds).
// Any other id is rejected. Scoped to the guild; auto-saves + returns the fresh
// list for optimistic UI, exactly like the other raid-group mutations.
export async function setRaidLeader(
  guild: Guild,
  raidGroupId: string,
  userId: string | null,
): Promise<RaidResult> {
  const clearing = userId === null || userId === "";

  if (!clearing) {
    // Resolve this guild's parties + raid groups (works in both mock + real
    // mode) to validate the candidate against the raid's eligible member set.
    const [parties, raidGroups] = await Promise.all([
      getParties(guild),
      getRaidGroups(guild),
    ]);
    const raid = raidGroups.find((r) => r.raidGroupId === raidGroupId);
    if (!raid) return { ok: false, message: "Raid group not found." };
    const partiesById = new Map<string, Party>(
      parties.map((p) => [p.partyId, p]),
    );
    const eligible = new Set(raidGroupMemberIds(raid, partiesById));
    if (!eligible.has(userId as string)) {
      return { ok: false, message: "Leader must be a member of this raid." };
    }
  }

  const nextLeaderId = clearing ? null : userId;

  if (!isMongoConfigured) {
    const r = MOCK_RAID_GROUPS.find(
      (g) => g.raidGroupId === raidGroupId && g.type === guild,
    );
    if (r) r.leaderId = nextLeaderId;
    return mockReturn(guild);
  }

  const db = await getDb();
  await db.collection<RaidGroup>(RAID_GROUPS).updateOne(
    { raidGroupId },
    { $set: { leaderId: nextLeaderId, updatedAt: new Date().toISOString() } },
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

// ============================================================================
// SETTINGS — edit the global composition config. Validates (incl. sum-of-mins
// <= partySize), persists, and — when counts/party-size change — reseeds both
// guilds' boards (data.ensureGuildParties does the safe reseed: shrink frees
// members to the pool + cleans raid refs; grow adds blanks; smaller partySize
// caps overflow). Revalidates every page that reads settings.
// ============================================================================

const SETTINGS = "settings";
const SETTINGS_ID = "global";

// Doc shape for the settings collection (string `_id`, not ObjectId).
interface SettingsDoc {
  _id: string;
  requiredClasses?: Settings["requiredClasses"];
  classRoles?: Settings["classRoles"];
  partySize?: number;
  mainPartyCount?: number;
  subPartyCount?: number;
  updatedAt?: Date;
}

export interface SettingsResult extends ActionResult {
  settings?: Settings;
}

export async function updateSettings(next: Settings): Promise<SettingsResult> {
  const v = validateSettings(next);
  if (!v.ok) return { ok: false, message: v.error };
  const s = v.settings;

  const prev = await getSettings();
  const structuralChange =
    prev.partySize !== s.partySize ||
    prev.mainPartyCount !== s.mainPartyCount ||
    prev.subPartyCount !== s.subPartyCount;

  if (!isMongoConfigured) {
    MOCK_SETTINGS.value = s;
  } else {
    const db = await getDb();
    await db.collection<SettingsDoc>(SETTINGS).updateOne(
      { _id: SETTINGS_ID },
      {
        $set: {
          requiredClasses: s.requiredClasses,
          classRoles: s.classRoles,
          partySize: s.partySize,
          mainPartyCount: s.mainPartyCount,
          subPartyCount: s.subPartyCount,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  // A structural change reseeds both guilds (safe + idempotent). Counts/size are
  // global, so reseed daddy AND mummy.
  if (structuralChange) {
    await Promise.all([getParties("daddy"), getParties("mummy")]);
  }

  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath("/members");
  revalidatePath("/raids");
  return { ok: true, settings: s };
}
