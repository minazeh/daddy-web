import "server-only";
import { revalidatePath } from "next/cache";
import { ObjectId } from "mongodb";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import { getDb, isMongoConfigured } from "./mongo";
import {
  MOCK_MEMBERS,
  MOCK_MEMBER_META,
  MOCK_PARTIES,
  MOCK_RAID_GROUPS,
  MOCK_SETTINGS,
} from "./mock";
import {
  DEFAULT_SETTINGS,
  FIELDS,
  FIELD_LABEL,
  KNOWN_CLASSES,
  partyIdFor,
  type Field,
  type Guild,
  type ManagedMember,
  type Member,
  type MemberMeta,
  type Party,
  type RaidGroup,
  type Role,
  type Settings,
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

// ---- Settings: web-owned single GLOBAL config doc ----

const SETTINGS = "settings";
const SETTINGS_ID = "global";

interface SettingsDoc {
  _id?: string;
  requiredClasses?: { className: string; min: number }[];
  classRoles?: Record<string, Role>;
  partySize?: number;
  mainPartyCount?: number;
  subPartyCount?: number;
  updatedAt?: Date | string;
}

function serializeSettings(d: SettingsDoc | null): Settings {
  if (!d) return { ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() };
  // Normalize defensively (fill any missing class role, coerce numbers).
  const classRoles: Record<string, Role> = {};
  for (const cls of KNOWN_CLASSES) {
    const r = d.classRoles?.[cls];
    classRoles[cls] = r === "tank" || r === "healer" || r === "dps" ? r : "dps";
  }
  const requiredClasses = Array.isArray(d.requiredClasses)
    ? d.requiredClasses
        .filter(
          (rc) =>
            rc &&
            (KNOWN_CLASSES as readonly string[]).includes(rc.className) &&
            Number.isFinite(rc.min) &&
            rc.min >= 1,
        )
        .map((rc) => ({ className: rc.className, min: Math.round(rc.min) }))
    : DEFAULT_SETTINGS.requiredClasses;
  return {
    requiredClasses,
    classRoles,
    partySize:
      typeof d.partySize === "number" && d.partySize >= 1
        ? Math.round(d.partySize)
        : DEFAULT_SETTINGS.partySize,
    mainPartyCount:
      typeof d.mainPartyCount === "number" && d.mainPartyCount >= 0
        ? Math.round(d.mainPartyCount)
        : DEFAULT_SETTINGS.mainPartyCount,
    subPartyCount:
      typeof d.subPartyCount === "number" && d.subPartyCount >= 0
        ? Math.round(d.subPartyCount)
        : DEFAULT_SETTINGS.subPartyCount,
    updatedAt: toIso(d.updatedAt),
  };
}

// Read the global settings, seeding DEFAULT_SETTINGS on first access (idempotent
// upsert via $setOnInsert — re-running never overwrites edited values). Mock
// mode reads the in-memory store.
export async function getSettings(): Promise<Settings> {
  if (!isMongoConfigured) return { ...MOCK_SETTINGS.value };

  const db = await getDb();
  const col = db.collection<SettingsDoc>(SETTINGS);
  await col.updateOne(
    { _id: SETTINGS_ID },
    {
      $setOnInsert: {
        requiredClasses: DEFAULT_SETTINGS.requiredClasses,
        classRoles: DEFAULT_SETTINGS.classRoles,
        partySize: DEFAULT_SETTINGS.partySize,
        mainPartyCount: DEFAULT_SETTINGS.mainPartyCount,
        subPartyCount: DEFAULT_SETTINGS.subPartyCount,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  const doc = await col.findOne({ _id: SETTINGS_ID });
  return serializeSettings(doc);
}

// Party count for a field from settings.
export function fieldCount(s: Settings, field: Field): number {
  return field === "main" ? s.mainPartyCount : s.subPartyCount;
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

// Idempotently guarantee the field structure for ONE guild: exactly
// settings.mainPartyCount Main + settings.subPartyCount Sub blank parties,
// keyed by `${type}-${field}-${position}`. Returns the canonical set (sorted).
//
// SAFE RESEED on settings change (counts / party size):
//   - Counts SHRINK   → out-of-range parties are deleted; their members simply
//     return to the pool (members live in `members`, never deleted); raid-group
//     references to deleted parties are cleaned up.
//   - Counts GROW     → missing blank parties are inserted ($setOnInsert keeps
//     existing assignments untouched).
//   - partySize SHRINKS → reconcile caps each party's memberIds + lockedSlots to
//     partySize, freeing overflow members to the pool.
// Idempotent + race-safe (unique partyId index + upsert/$setOnInsert).
export async function ensureGuildParties(guild: Guild): Promise<Party[]> {
  const settings = await getSettings();
  const counts: Record<Field, number> = {
    main: settings.mainPartyCount,
    sub: settings.subPartyCount,
  };

  if (!isMongoConfigured) {
    // Mock mode: synthesize the canonical structure in memory (no DB writes).
    const out: Party[] = [];
    for (const field of FIELDS) {
      for (let i = 0; i < counts[field]; i++) {
        out.push(blankParty(guild, field, i));
      }
    }
    const valid = new Set(
      MOCK_MEMBERS.filter((m) => (guild === "daddy" ? m.isMain : m.isSub)).map(
        (m) => m.userId,
      ),
    );
    for (const m of MOCK_PARTIES) {
      const hit = out.find((p) => p.partyId === m.partyId);
      if (hit) {
        hit.memberIds = m.memberIds
          .filter((id) => valid.has(id))
          .slice(0, settings.partySize);
      }
    }
    return out.sort(comparePartiesByOrder);
  }

  const db = await getDb();
  const col = db.collection<PartyDoc>(PARTIES);

  // Unique index on partyId makes the upsert seed race-safe.
  await col.createIndex({ partyId: 1 }, { unique: true });

  // Canonical id set for this guild (from settings counts).
  const canonical = new Set<string>();
  for (const field of FIELDS) {
    for (let i = 0; i < counts[field]; i++) {
      canonical.add(partyIdFor(guild, field, i));
    }
  }

  // Find non-canonical (out-of-range / stray) parties for this guild BEFORE
  // deleting, so we can clean raid-group references to them.
  const strayDocs = await col
    .find({ type: guild, partyId: { $nin: Array.from(canonical) } })
    .project<{ partyId: string }>({ partyId: 1, _id: 0 })
    .toArray();
  const strayIds = strayDocs.map((d) => d.partyId);
  if (strayIds.length > 0) {
    await col.deleteMany({ type: guild, partyId: { $in: strayIds } });
    // Clean raid-group references to the removed parties (they just leave their
    // raid group; raid groups + members are untouched).
    await db.collection<RaidGroupDoc>(RAID_GROUPS).updateMany(
      { type: guild, partyIds: { $in: strayIds } },
      {
        $pull: { partyIds: { $in: strayIds } },
        $set: { updatedAt: new Date() },
      } as never,
    );
  }

  // Upsert each canonical blank ($setOnInsert preserves existing assignments).
  const ops = [];
  for (const field of FIELDS) {
    for (let i = 0; i < counts[field]; i++) {
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
  if (ops.length > 0) await col.bulkWrite(ops, { ordered: false });

  // Read back the canonical set, correcting field/position from the id for any
  // legacy canonical-id doc that predated the `field` column.
  const docs = await col.find({ type: guild }).toArray();
  const parties = docs
    .filter((d) => canonical.has(d.partyId))
    .map(serializeParty)
    .map((p) => normalizeFieldFromId(p))
    .sort(comparePartiesByOrder);

  // Reconcile against the live roster: prune userIds that are no longer in this
  // guild's `members`, AND cap each party to settings.partySize (a shrunk party
  // size frees overflow members to the pool). Idempotent: writes only changed
  // parties.
  const validIds = new Set((await getMembers(guild)).map((m) => m.userId));
  return reconcileParties(col, parties, validIds, settings.partySize);
}

// Remove any memberId not in `validIds` from each party's memberIds; cap to
// `partySize` (overflow members return to the pool); and if a removed member
// sat in a LOCKED slot, drop that index from lockedSlots too (locks reference
// slot indexes into the compacting memberIds). Persists ONLY changed parties.
// Race-safe: each write is an idempotent $set keyed on the unique partyId.
async function reconcileParties(
  col: Collection<PartyDoc>,
  parties: Party[],
  validIds: Set<string>,
  partySize: number,
): Promise<Party[]> {
  const writes: AnyBulkWriteOperation<PartyDoc>[] = [];

  const reconciled = parties.map((p) => {
    let changed = false;
    const lockedSet = new Set(p.lockedSlots);
    const keptLockedUids = new Set<string>();
    const nextMemberIds: string[] = [];
    for (let i = 0; i < p.memberIds.length; i++) {
      const uid = p.memberIds[i];
      // Prune departed members AND any overflow beyond partySize.
      if (validIds.has(uid) && nextMemberIds.length < partySize) {
        if (lockedSet.has(i)) keptLockedUids.add(uid);
        nextMemberIds.push(uid);
      } else {
        changed = true; // pruned: departed OR over the (possibly shrunk) cap
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

// ---- Guild Event "can't make it" intent (bot-owned; read-only here) ----
//
// The Discord bot writes `gvg_attendance_intent` (spec §3): one doc per member
// per event occurrence, with the member's yes/no RSVP. This app READS it to grey
// out + deprioritize the members who said "no" to the SOONEST upcoming event for
// the shown guild, in the party builder.

const INTENT = "gvg_attendance_intent";
const GVG_SCHEDULES = "gvg_schedules";

type ScheduleGuild = "daddy" | "mummy" | "both";

// One `gvg_attendance_intent` doc as written by the bot (loose — this app never
// writes it). `scheduleId` is stored as the STRING of the source
// `gvg_schedules._id` ObjectId; `guild` is the responder's COLLAPSED affiliation
// (a "both"-member is stored once as "daddy") and is deliberately NOT used here.
interface IntentDoc {
  occurrenceKey: string;
  scheduleId: string;
  userId: string;
  response: "yes" | "no";
  eventAt: Date | string;
}

// A `gvg_schedules` doc (bot-owned). Only `_id` + `guild` are needed to resolve
// an occurrence's TRUE guild scope.
interface GvgScheduleDoc {
  _id: ObjectId;
  guild?: ScheduleGuild;
}

function normalizeScheduleGuild(v: unknown): ScheduleGuild {
  return v === "daddy" || v === "mummy" || v === "both" ? v : "both";
}

// Resolve the set of userIds who responded "no" to the SOONEST upcoming Guild
// Event occurrence relevant to `guild`, per spec §8 (the "both"-member fix):
//   a. Read intent docs with response:"no" and eventAt >= now.
//   b. Group by occurrenceKey; resolve each occurrence's TRUE guild from its
//      SCHEDULE (scheduleId -> gvg_schedules.guild), NOT the intent's collapsed
//      `guild` field — so a "both"-member (stored once as "daddy") is not missed
//      by a naive guild filter.
//   c. Keep occurrences whose schedule guild is in { guild, 'both' }; pick the
//      soonest eventAt (ties broken by occurrenceKey for determinism).
//   d. Return the Set of userIds with response:"no" for that occurrence.
// Graceful-degrade to an EMPTY set when Mongo is unconfigured or on ANY error —
// never throws into the page render.
export async function getUnavailableIds(guild: Guild): Promise<Set<string>> {
  const empty = new Set<string>();
  if (!isMongoConfigured) return empty;

  try {
    const db = await getDb();
    const now = new Date();

    // (a) "no" RSVPs for events that haven't started yet.
    const docs = await db
      .collection<IntentDoc>(INTENT)
      .find({ response: "no", eventAt: { $gte: now } })
      .toArray();
    if (docs.length === 0) return empty;

    // (b) Resolve each distinct scheduleId to its schedule's guild. intent
    // stores scheduleId as the ObjectId hex string; gvg_schedules._id is an
    // ObjectId, so cast for the $in lookup (skip any malformed id).
    const scheduleOids: ObjectId[] = [];
    const seenScheduleIds = new Set<string>();
    for (const d of docs) {
      const sid = d.scheduleId ? String(d.scheduleId) : "";
      if (!sid || seenScheduleIds.has(sid)) continue;
      seenScheduleIds.add(sid);
      try {
        scheduleOids.push(new ObjectId(sid));
      } catch {
        // malformed scheduleId — its occurrences can't be resolved; skipped.
      }
    }
    if (scheduleOids.length === 0) return empty;

    const schedules = await db
      .collection<GvgScheduleDoc>(GVG_SCHEDULES)
      .find({ _id: { $in: scheduleOids } })
      .toArray();
    const guildBySchedule = new Map<string, ScheduleGuild>();
    for (const s of schedules) {
      guildBySchedule.set(String(s._id), normalizeScheduleGuild(s.guild));
    }

    // (b/c) Group "no" docs by occurrence, keeping only occurrences whose
    // SCHEDULE guild covers the shown guild (its own guild or "both").
    interface Occurrence {
      eventAt: number;
      userIds: Set<string>;
    }
    const byOccurrence = new Map<string, Occurrence>();
    for (const d of docs) {
      const sGuild = guildBySchedule.get(String(d.scheduleId));
      if (!sGuild) continue; // schedule missing/deleted — can't resolve; skip.
      if (sGuild !== guild && sGuild !== "both") continue; // other guild only.
      const t = new Date(d.eventAt).getTime();
      if (!Number.isFinite(t)) continue;
      let occ = byOccurrence.get(d.occurrenceKey);
      if (!occ) {
        occ = { eventAt: t, userIds: new Set<string>() };
        byOccurrence.set(d.occurrenceKey, occ);
      }
      occ.userIds.add(d.userId);
      if (t < occ.eventAt) occ.eventAt = t; // defensive: min across the group.
    }
    if (byOccurrence.size === 0) return empty;

    // (c) Pick the SOONEST occurrence (deterministic tie-break on occurrenceKey).
    let bestKey = "";
    let best: Occurrence | null = null;
    for (const [key, occ] of byOccurrence) {
      if (
        !best ||
        occ.eventAt < best.eventAt ||
        (occ.eventAt === best.eventAt && key < bestKey)
      ) {
        best = occ;
        bestKey = key;
      }
    }

    // (d) The "no" userIds for that occurrence.
    return best ? best.userIds : empty;
  } catch {
    // Any failure (DB down, bad data) degrades to "nobody greyed" — the builder
    // must never throw over an optional overlay of RSVP state.
    return empty;
  }
}
