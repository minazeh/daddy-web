import "server-only";
import { revalidatePath } from "next/cache";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import { getDb, isMongoConfigured } from "./mongo";
import {
  MOCK_MEMBERS,
  MOCK_MEMBER_META,
  MOCK_PARTIES,
  MOCK_RAID_GROUPS,
} from "./mock";
import {
  FIELDS,
  FIELD_LABEL,
  FIELD_SIZE,
  partyIdFor,
  type Field,
  type Guild,
  type ManagedMember,
  type Member,
  type MemberMeta,
  type Party,
  type RaidGroup,
} from "./types";

// Server-side data access layer.
// READS the `members` collection (owned by the Discord bot) and READS/WRITES
// the `parties` collection (owned by this app). Pure server-side; never import
// from client components.
//
// Daddy and Mummy are SEPARATE guilds. Every read is scoped to ONE guild and
// the two are never merged:
//   Daddy -> members where isMain, parties where type === 'daddy'
//   Mummy -> members where isSub,  parties where type === 'mummy'

const MEMBERS = "members";
const PARTIES = "parties";

interface MemberDoc {
  userId: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string | null;
  isMain?: boolean;
  isSub?: boolean;
  className?: string | null;
  classRoleId?: string | null;
  updatedAt?: Date | string;
}

interface PartyDoc {
  partyId: string;
  type: Guild;
  field?: Field;
  name: string;
  memberIds?: string[];
  position?: number;
  x?: number;
  y?: number;
  lockedSlots?: number[];
  updatedAt?: Date | string;
}

function toIso(v: Date | string | undefined): string {
  if (!v) return new Date(0).toISOString();
  return typeof v === "string" ? v : v.toISOString();
}

function serializeMember(d: MemberDoc): Member {
  return {
    userId: d.userId,
    username: d.username ?? "",
    displayName: d.displayName ?? d.username ?? d.userId,
    avatarUrl: d.avatarUrl ?? null,
    isMain: Boolean(d.isMain),
    isSub: Boolean(d.isSub),
    className: d.className ?? null,
    classRoleId: d.classRoleId ?? null,
    updatedAt: toIso(d.updatedAt),
  };
}

function serializeParty(d: PartyDoc): Party {
  const position = typeof d.position === "number" ? d.position : 0;
  return {
    partyId: d.partyId,
    type: d.type,
    field: d.field === "sub" ? "sub" : "main",
    name: d.name,
    memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
    position,
    x: typeof d.x === "number" ? d.x : 0,
    y: typeof d.y === "number" ? d.y : 0,
    lockedSlots: Array.isArray(d.lockedSlots) ? d.lockedSlots : [],
    updatedAt: toIso(d.updatedAt),
  };
}

// Total-order comparator for members: by displayName, then userId as a unique
// tiebreaker. `displayName` alone is NOT a total order — ties leave the order
// unspecified, and the dynamic route renders the server component more than
// once (SSR HTML + RSC payload), so two executions of a tie-prone sort could
// return different member orders → the pool lined up a different member at the
// same DOM slot → React hydration mismatch at the avatar initial. Sorting by a
// unique key (userId) last makes the order fully deterministic and reproducible.
function compareMembers(a: Member, b: Member): number {
  const byName = a.displayName.localeCompare(b.displayName);
  return byName !== 0 ? byName : a.userId.localeCompare(b.userId);
}

// Read members for ONE guild only. Daddy => isMain, Mummy => isSub. The two
// guilds' rosters are never combined.
export async function getMembers(guild: Guild): Promise<Member[]> {
  const filterField = guild === "daddy" ? "isMain" : "isSub";

  if (!isMongoConfigured) {
    return MOCK_MEMBERS.filter((m) =>
      guild === "daddy" ? m.isMain : m.isSub,
    ).sort(compareMembers);
  }
  const db = await getDb();
  const docs = await db
    .collection<MemberDoc>(MEMBERS)
    .find({ [filterField]: true })
    // Deterministic total order: displayName, then unique userId tiebreaker.
    .sort({ displayName: 1, userId: 1 })
    .toArray();
  return docs.map(serializeMember).sort(compareMembers);
}

// ---- memberMeta: web-owned power ratings + historical roster ----

const MEMBER_META = "memberMeta";

interface MemberMetaDoc {
  userId: string;
  power?: number;
  displayName?: string;
  username?: string;
  className?: string | null;
  classRoleId?: string | null;
  isMain?: boolean;
  isSub?: boolean;
  avatarUrl?: string | null;
  lastSeenAt?: Date | string;
  updatedAt?: Date | string;
}

function serializeMeta(d: MemberMetaDoc): MemberMeta {
  return {
    userId: d.userId,
    power: typeof d.power === "number" && d.power >= 0 ? Math.floor(d.power) : 0,
    displayName: d.displayName ?? d.username ?? d.userId,
    username: d.username ?? "",
    className: d.className ?? null,
    classRoleId: d.classRoleId ?? null,
    isMain: Boolean(d.isMain),
    isSub: Boolean(d.isSub),
    avatarUrl: d.avatarUrl ?? null,
    lastSeenAt: toIso(d.lastSeenAt),
    updatedAt: toIso(d.updatedAt),
  };
}

// Read ALL members currently in the live `members` collection (both guilds).
async function getAllMembers(): Promise<Member[]> {
  if (!isMongoConfigured) return MOCK_MEMBERS;
  const db = await getDb();
  const docs = await db.collection<MemberDoc>(MEMBERS).find({}).toArray();
  return docs.map(serializeMember);
}

// Upsert memberMeta for every CURRENT member: refresh cached fields + lastSeenAt
// and set power=0 for NEW members, but NEVER overwrite an existing member's
// power (that's the manual rating). Idempotent + race-safe ($set cached fields,
// $setOnInsert power). Returns a userId -> meta map for ALL meta rows.
export async function syncMemberMeta(): Promise<Map<string, MemberMeta>> {
  const current = await getAllMembers();
  const nowIso = new Date().toISOString();

  if (!isMongoConfigured) {
    for (const m of current) {
      const existing = MOCK_MEMBER_META.get(m.userId);
      MOCK_MEMBER_META.set(m.userId, {
        userId: m.userId,
        power: existing?.power ?? 0, // never overwrite existing power
        displayName: m.displayName,
        username: m.username,
        className: m.className,
        classRoleId: m.classRoleId,
        isMain: m.isMain,
        isSub: m.isSub,
        avatarUrl: m.avatarUrl,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
      });
    }
    return new Map(MOCK_MEMBER_META);
  }

  const db = await getDb();
  const col = db.collection<MemberMetaDoc>(MEMBER_META);
  await col.createIndex({ userId: 1 }, { unique: true });

  if (current.length > 0) {
    await col.bulkWrite(
      current.map((m) => ({
        updateOne: {
          filter: { userId: m.userId },
          update: {
            // Refresh cached roster fields + lastSeenAt every load...
            $set: {
              displayName: m.displayName,
              username: m.username,
              className: m.className,
              classRoleId: m.classRoleId,
              isMain: m.isMain,
              isSub: m.isSub,
              avatarUrl: m.avatarUrl,
              lastSeenAt: new Date(),
              updatedAt: new Date(),
            },
            // ...but power is set ONLY on first insert (never reset on re-sync).
            $setOnInsert: { power: 0 },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const docs = await col.find({}).toArray();
  const map = new Map<string, MemberMeta>();
  for (const d of docs) map.set(d.userId, serializeMeta(d));
  return map;
}

// Members for the /members management page, for ONE guild: ACTIVE members
// (present in `members`) joined with power + DEPARTED members (memberMeta rows
// no longer in `members`, matched to the guild via cached isMain/isSub). Each
// tagged `active`. Deterministically ordered (active first, then by power desc,
// then displayName, then userId).
export async function getMembersForManagement(
  guild: Guild,
): Promise<ManagedMember[]> {
  const meta = await syncMemberMeta();
  const current = await getAllMembers();
  const activeIds = new Set(current.map((m) => m.userId));
  const inGuild = (m: { isMain: boolean; isSub: boolean }) =>
    guild === "daddy" ? m.isMain : m.isSub;

  const out: ManagedMember[] = [];
  for (const m of meta.values()) {
    if (!inGuild(m)) continue;
    out.push({ ...m, active: activeIds.has(m.userId) });
  }
  out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.power !== b.power) return b.power - a.power;
    const byName = a.displayName.localeCompare(b.displayName);
    return byName !== 0 ? byName : a.userId.localeCompare(b.userId);
  });
  return out;
}

// Power lookup for the current guild's ACTIVE members (used by Generate). Keyed
// userId -> power, default 0.
export async function getPowerMap(guild: Guild): Promise<Map<string, number>> {
  const meta = await syncMemberMeta();
  const map = new Map<string, number>();
  for (const m of meta.values()) {
    if (guild === "daddy" ? m.isMain : m.isSub) map.set(m.userId, m.power);
  }
  return map;
}

// Total-order comparator for parties: by field (main before sub), then
// position, then unique partyId tiebreaker.
function comparePartiesByOrder(a: Party, b: Party): number {
  if (a.field !== b.field) return a.field === "main" ? -1 : 1;
  return a.position !== b.position
    ? a.position - b.position
    : a.partyId.localeCompare(b.partyId);
}

// Build a canonical blank party for (guild, field, position).
function blankParty(guild: Guild, field: Field, position: number): Party {
  return {
    partyId: partyIdFor(guild, field, position),
    type: guild,
    field,
    name: `${FIELD_LABEL[field].split(" ")[0]} ${position + 1}`, // "Main 1" / "Sub 1"
    memberIds: [],
    position,
    x: 0,
    y: 0,
    lockedSlots: [],
    updatedAt: new Date().toISOString(),
  };
}

// Idempotently guarantee the fixed field structure for ONE guild:
// EXACTLY 12 Main + 18 Sub blank parties, keyed by the deterministic id
// `${type}-${field}-${position}`. Returns the canonical set (sorted).
//
// Migration of pre-existing data: any party doc for this guild that is NOT one
// of the canonical (type, field, position) ids is removed — this folds the old
// ad-hoc field-less test parties into the canonical set cleanly with no strays
// or dupes. Member assignments on a canonical id are preserved across reloads
// (we only insert MISSING canonical ids; we never overwrite existing ones).
export async function ensureGuildParties(guild: Guild): Promise<Party[]> {
  if (!isMongoConfigured) {
    // Mock mode: synthesize the canonical structure in memory (no DB writes).
    const out: Party[] = [];
    for (const field of FIELDS) {
      for (let i = 0; i < FIELD_SIZE[field]; i++) {
        out.push(blankParty(guild, field, i));
      }
    }
    // Fold any mock member assignments onto matching canonical ids, pruning any
    // id not in the mock roster (mirrors the live reconcile).
    const valid = new Set(
      MOCK_MEMBERS.filter((m) => (guild === "daddy" ? m.isMain : m.isSub)).map(
        (m) => m.userId,
      ),
    );
    for (const m of MOCK_PARTIES) {
      const hit = out.find((p) => p.partyId === m.partyId);
      if (hit) hit.memberIds = m.memberIds.filter((id) => valid.has(id));
    }
    return out.sort(comparePartiesByOrder);
  }

  const db = await getDb();
  const col = db.collection<PartyDoc>(PARTIES);

  // Unique index on partyId makes the upsert seed race-safe: concurrent server
  // renders of the dynamic route (SSR + RSC passes) can't create duplicates.
  // Idempotent to create.
  await col.createIndex({ partyId: 1 }, { unique: true });

  // Canonical id set for this guild.
  const canonical = new Set<string>();
  for (const field of FIELDS) {
    for (let i = 0; i < FIELD_SIZE[field]; i++) {
      canonical.add(partyIdFor(guild, field, i));
    }
  }

  // Remove strays (any guild doc whose id isn't canonical — old test rows or
  // an earlier non-atomic seed's duplicate-keyed rows can't exist now, but a
  // pre-existing non-canonical row would; fold them out).
  await col.deleteMany({
    type: guild,
    partyId: { $nin: Array.from(canonical) },
  });

  // Upsert each canonical blank. `$setOnInsert` only writes on CREATE, so an
  // existing party's member assignments / locks are never overwritten. Two
  // concurrent upserts on the same unique partyId collapse to one row (the
  // second no-ops) — naturally idempotent and race-safe.
  const ops = [];
  for (const field of FIELDS) {
    for (let i = 0; i < FIELD_SIZE[field]; i++) {
      const p = blankParty(guild, field, i);
      ops.push({
        updateOne: {
          filter: { partyId: p.partyId },
          update: {
            $setOnInsert: {
              partyId: p.partyId,
              type: p.type,
              field: p.field,
              name: p.name,
              memberIds: p.memberIds,
              position: p.position,
              x: p.x,
              y: p.y,
              lockedSlots: p.lockedSlots,
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }
  }
  await col.bulkWrite(ops, { ordered: false });

  // Read back the canonical set, correcting field/position from the id for any
  // legacy canonical-id doc that predated the `field` column.
  const docs = await col.find({ type: guild }).toArray();
  const parties = docs
    .filter((d) => canonical.has(d.partyId))
    .map(serializeParty)
    .map((p) => normalizeFieldFromId(p))
    .sort(comparePartiesByOrder);

  // Reconcile against the live roster: prune userIds that are no longer in this
  // guild's `members` (departed / de-roled — the bot's removeStale dropped them
  // from the pool, but their id can linger in a party). Idempotent: writes back
  // only parties that actually changed.
  const validIds = new Set((await getMembers(guild)).map((m) => m.userId));
  return reconcileParties(col, parties, validIds);
}

// Remove any memberId not in `validIds` from each party's memberIds, and if a
// pruned member sat in a LOCKED slot, drop that index from lockedSlots too (the
// pinned member is gone → free + unlock the slot). Persists ONLY changed
// parties (no-op writes otherwise). Returns the pruned, in-memory party list so
// the caller doesn't need a re-read. Race-safe: each write is an idempotent
// $set keyed on the unique partyId; concurrent identical prunes converge.
async function reconcileParties(
  col: Collection<PartyDoc>,
  parties: Party[],
  validIds: Set<string>,
): Promise<Party[]> {
  const writes: AnyBulkWriteOperation<PartyDoc>[] = [];

  const reconciled = parties.map((p) => {
    let changed = false;
    // Track which surviving members were in a locked slot so we can rebuild
    // lockedSlots against the COMPACTED memberIds (a removed member shifts
    // indexes). Locks reference slot indexes into memberIds.
    const lockedSet = new Set(p.lockedSlots);
    const keptLockedUids = new Set<string>();
    const nextMemberIds: string[] = [];
    for (let i = 0; i < p.memberIds.length; i++) {
      const uid = p.memberIds[i];
      if (validIds.has(uid)) {
        if (lockedSet.has(i)) keptLockedUids.add(uid);
        nextMemberIds.push(uid);
      } else {
        changed = true; // an orphan was pruned (member gone OR its lock dropped)
      }
    }
    if (!changed) return p;

    const nextLocked: number[] = [];
    nextMemberIds.forEach((uid, idx) => {
      if (keptLockedUids.has(uid)) nextLocked.push(idx);
    });

    writes.push({
      updateOne: {
        filter: { partyId: p.partyId },
        update: {
          $set: {
            memberIds: nextMemberIds,
            lockedSlots: nextLocked,
            updatedAt: new Date(),
          },
        },
      },
    });
    return { ...p, memberIds: nextMemberIds, lockedSlots: nextLocked };
  });

  // Only write when something actually changed (idempotent: zero orphans → zero
  // writes). Revalidate so freed slots are immediately reusable.
  if (writes.length > 0) {
    await col.bulkWrite(writes, { ordered: false });
    revalidatePath("/");
  }

  return reconciled;
}

// Derive field/position from a canonical id `${type}-${field}-${position}` so a
// legacy doc with the right id but a missing/old `field` is corrected on read.
function normalizeFieldFromId(p: Party): Party {
  const parts = p.partyId.split("-");
  // id form: <guild>-<field>-<position>
  if (parts.length >= 3) {
    const field = parts[parts.length - 2];
    const pos = Number(parts[parts.length - 1]);
    if (field === "main" || field === "sub") {
      return {
        ...p,
        field,
        position: Number.isInteger(pos) ? pos : p.position,
      };
    }
  }
  return p;
}

// Read the canonical fixed-structure parties for ONE guild (seeds if needed).
export async function getParties(guild: Guild): Promise<Party[]> {
  return ensureGuildParties(guild);
}

// ---- Raid groups (the layer above parties) ----

const RAID_GROUPS = "raidGroups";

interface RaidGroupDoc {
  raidGroupId: string;
  type: Guild;
  field?: Field;
  name: string;
  partyIds?: string[];
  position?: number;
  updatedAt?: Date | string;
}

function serializeRaidGroup(d: RaidGroupDoc): RaidGroup {
  return {
    raidGroupId: d.raidGroupId,
    type: d.type,
    field: d.field === "sub" ? "sub" : "main",
    name: d.name,
    partyIds: Array.isArray(d.partyIds) ? d.partyIds : [],
    position: typeof d.position === "number" ? d.position : 0,
    updatedAt: toIso(d.updatedAt),
  };
}

// Deterministic total order for raid groups: by position, then unique id.
export function compareRaidGroups(a: RaidGroup, b: RaidGroup): number {
  return a.position !== b.position
    ? a.position - b.position
    : a.raidGroupId.localeCompare(b.raidGroupId);
}

// Read all raid groups for ONE guild (both fields), deterministically ordered.
// The client splits them by field. Read-only here; writes live in actions.ts.
export async function getRaidGroups(guild: Guild): Promise<RaidGroup[]> {
  if (!isMongoConfigured) {
    return MOCK_RAID_GROUPS.filter((r) => r.type === guild)
      .map((r) => ({ ...r, partyIds: [...r.partyIds] }))
      .sort(compareRaidGroups);
  }
  const db = await getDb();
  const docs = await db
    .collection<RaidGroupDoc>(RAID_GROUPS)
    .find({ type: guild })
    .sort({ position: 1, raidGroupId: 1 })
    .toArray();
  return docs.map(serializeRaidGroup).sort(compareRaidGroups);
}
