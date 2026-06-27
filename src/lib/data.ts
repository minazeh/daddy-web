import "server-only";
import { getDb, isMongoConfigured } from "./mongo";
import { MOCK_MEMBERS, MOCK_PARTIES } from "./mock";
import {
  FIELDS,
  FIELD_LABEL,
  FIELD_SIZE,
  partyIdFor,
  type Field,
  type Guild,
  type Member,
  type Party,
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
    // Fold any mock member assignments onto matching canonical ids.
    for (const m of MOCK_PARTIES) {
      const hit = out.find((p) => p.partyId === m.partyId);
      if (hit) hit.memberIds = m.memberIds;
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

  // Return the canonical set, correcting field/position from the id for any
  // legacy canonical-id doc that predated the `field` column.
  const docs = await col.find({ type: guild }).toArray();
  return docs
    .filter((d) => canonical.has(d.partyId))
    .map(serializeParty)
    .map((p) => normalizeFieldFromId(p))
    .sort(comparePartiesByOrder);
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
