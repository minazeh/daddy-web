import "server-only";
import type { AnyBulkWriteOperation } from "mongodb";
import { getDb, isMongoConfigured } from "./mongo";
import { ensureSchema } from "./bootstrap";
import { getMembers, getSettings } from "./data";
import type { Guild } from "./types";
import {
  siegePartyId,
  siegePartyName,
  siegeRaidName,
  siegeStructure,
  type SiegeParty,
  type SiegeRaid,
  type SiegeRaidKey,
} from "./siege";

// ============================================================================
// SIEGE — server-side data access.
//
// Two NEW web-owned collections, fully isolated from BOTH existing structures:
//   siegeRaids   — the 4 raids per guild (name + leader).
//   siegeParties — their parties, 8 per raid, uniformly.
// The `parties` / `raidGroups` / `polarityParties` / `polarityRaids`
// collections are never touched here, and nothing here ever writes `members`
// (the bot owns it and its sync would wipe anything we added).
//
// The structure is FIXED, so seeding is a pure idempotent upsert: canonical ids
// are computed from the structure and `$setOnInsert` never disturbs an existing
// assignment. NOTHING IS EVER DELETED — there are no strays to prune because
// the party counts do not come from settings. (If Siege party counts ever
// become configurable, this file inherits the whole stray-pruning path that
// data.ts carries for GvG. It does not have it today, on purpose.)
//
// ZERO WRITES ON THE RENDER PATH. This is an invariant of this codebase, not a
// preference — commit e714a6b removed every render-time write app-wide.
// Concretely, in this file:
//   * getSiegeBoard (the READ path) issues finds ONLY. It compares the
//     documents it had to read anyway against the canonical set and only falls
//     through to the write path on real drift.
//   * reconcile() is PURE — it returns the corrected parties AND the writes
//     that would persist them, and the CALLER decides. A render reconciles in
//     memory and discards the writes; the seed path applies them.
//   * createIndex lives in bootstrap.ts ensureSchema(), never here. Every write
//     path awaits it before writing so a seeding upsert can never run without
//     its unique index.
//
// AND NO REVALIDATION FROM A READ PATH. Next throws when revalidatePath runs
// during render; that caused a real cold-load 500 on `/`, `/raids` and
// `/members` (see data.ts and polarity-data.ts, which both carry this warning).
// Revalidation lives ONLY in siege-actions.ts.
// ============================================================================

const SIEGE_RAIDS = "siegeRaids";
const SIEGE_PARTIES = "siegeParties";

interface SiegeRaidDoc {
  raidId: string;
  type: Guild;
  raidKey?: SiegeRaidKey;
  name?: string;
  position?: number;
  leaderId?: string | null;
  updatedAt?: Date | string;
}

interface SiegePartyDoc {
  partyId: string;
  type: Guild;
  raidId?: string;
  raidKey?: SiegeRaidKey;
  name?: string;
  memberIds?: string[];
  position?: number;
  lockedSlots?: number[];
  updatedAt?: Date | string;
}

function toIso(v: Date | string | undefined): string {
  if (!v) return new Date(0).toISOString();
  return typeof v === "string" ? v : v.toISOString();
}

// A blank raid / party for the canonical structure.
function blankRaid(
  guild: Guild,
  raidKey: SiegeRaidKey,
  position: number,
  raidId: string,
): SiegeRaid {
  return {
    raidId,
    type: guild,
    raidKey,
    name: siegeRaidName(raidKey),
    position,
    leaderId: null,
    updatedAt: new Date().toISOString(),
  };
}

function blankParty(
  guild: Guild,
  raidId: string,
  raidKey: SiegeRaidKey,
  position: number,
): SiegeParty {
  return {
    partyId: siegePartyId(raidId, position),
    type: guild,
    raidId,
    raidKey,
    name: siegePartyName(position),
    memberIds: [],
    position,
    lockedSlots: [],
    updatedAt: new Date().toISOString(),
  };
}

// The canonical structure is the authority on raidKey, so a stored doc can
// never re-point a raid at a different key — only its NAME is user-editable.
function serializeRaid(d: SiegeRaidDoc, fallback: SiegeRaid): SiegeRaid {
  return {
    raidId: d.raidId,
    type: d.type,
    raidKey: fallback.raidKey,
    name: typeof d.name === "string" && d.name ? d.name : fallback.name,
    position: fallback.position,
    leaderId: typeof d.leaderId === "string" ? d.leaderId : null,
    updatedAt: toIso(d.updatedAt),
  };
}

function serializeParty(d: SiegePartyDoc, fallback: SiegeParty): SiegeParty {
  return {
    partyId: d.partyId,
    type: d.type,
    raidId: fallback.raidId,
    raidKey: fallback.raidKey,
    name: typeof d.name === "string" && d.name ? d.name : fallback.name,
    memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
    position: fallback.position,
    lockedSlots: Array.isArray(d.lockedSlots) ? d.lockedSlots : [],
    updatedAt: toIso(d.updatedAt),
  };
}

export interface SiegeBoard {
  raids: SiegeRaid[]; // always 4, in structural order
  parties: SiegeParty[]; // always 4 x 8 = 32, grouped by raid then position
}

// The canonical (all-blank) board for a guild — used as the mock-mode result
// and as the per-document fallback when a stored doc predates a field.
function canonicalBoard(guild: Guild): SiegeBoard {
  const raids: SiegeRaid[] = [];
  const parties: SiegeParty[] = [];
  for (const spec of siegeStructure(guild)) {
    raids.push(blankRaid(guild, spec.raidKey, spec.position, spec.raidId));
    for (let i = 0; i < spec.partyCount; i++) {
      parties.push(blankParty(guild, spec.raidId, spec.raidKey, i));
    }
  }
  return { raids, parties };
}

// SEED the 4-raid / 32-party structure for ONE guild — THE WRITE PATH. Never
// deletes: the structure is fixed, so there are no strays to prune, and
// `$setOnInsert` leaves every existing assignment untouched.
//
// Reached from the server actions and, self-healing, from getSiegeBoard when it
// finds a document missing (a fresh database). It is NOT on the steady-state
// render path: a page view that finds the full board performs NO writes at all.
export async function seedSiegeBoard(guild: Guild): Promise<SiegeBoard> {
  const canonical = canonicalBoard(guild);
  if (!isMongoConfigured) return canonical;

  // The unique indexes are what make the upserts below race-safe, so the write
  // path (and only the write path) waits for the schema bootstrap.
  await ensureSchema();

  const settings = await getSettings();
  const db = await getDb();
  const raidCol = db.collection<SiegeRaidDoc>(SIEGE_RAIDS);
  const partyCol = db.collection<SiegePartyDoc>(SIEGE_PARTIES);

  await raidCol.bulkWrite(
    canonical.raids.map((r) => ({
      updateOne: {
        filter: { raidId: r.raidId },
        update: {
          $setOnInsert: {
            raidId: r.raidId,
            type: r.type,
            raidKey: r.raidKey,
            name: r.name,
            position: r.position,
            leaderId: null,
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  await partyCol.bulkWrite(
    canonical.parties.map((p) => ({
      updateOne: {
        filter: { partyId: p.partyId },
        update: {
          $setOnInsert: {
            partyId: p.partyId,
            type: p.type,
            raidId: p.raidId,
            raidKey: p.raidKey,
            name: p.name,
            memberIds: [],
            position: p.position,
            lockedSlots: [],
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const [raidDocs, partyDocs] = await Promise.all([
    raidCol.find({ type: guild }).toArray(),
    partyCol.find({ type: guild }).toArray(),
  ]);
  const assembled = assembleBoard(canonical, raidDocs, partyDocs);

  // Reconcile against the live roster + the current party size and PERSIST the
  // corrections — this is the write path, so the DB is brought fully in line.
  const validIds = new Set((await getMembers(guild)).map((m) => m.userId));
  const { parties, writes } = reconcile(
    assembled.parties,
    validIds,
    settings.partySize,
  );
  if (writes.length > 0) await partyCol.bulkWrite(writes, { ordered: false });
  return { raids: dropOrphanLeaders(assembled.raids, parties), parties };
}

// Read back in CANONICAL order, so the board is deterministic regardless of
// Mongo's natural order and immune to any unexpected extra document.
function assembleBoard(
  canonical: SiegeBoard,
  raidDocs: SiegeRaidDoc[],
  partyDocs: SiegePartyDoc[],
): SiegeBoard {
  const raidById = new Map(raidDocs.map((d) => [d.raidId, d]));
  const partyById = new Map(partyDocs.map((d) => [d.partyId, d]));
  return {
    raids: canonical.raids.map((r) => {
      const doc = raidById.get(r.raidId);
      return doc ? serializeRaid(doc, r) : r;
    }),
    parties: canonical.parties.map((p) => {
      const doc = partyById.get(p.partyId);
      return doc ? serializeParty(doc, p) : p;
    }),
  };
}

// Drop a leader that is no longer in any of its raid's parties. Runs on EVERY
// read, so a leader who is removed from the board (or leaves the guild
// entirely) stops being crowned immediately, without a write.
function dropOrphanLeaders(
  raids: SiegeRaid[],
  parties: SiegeParty[],
): SiegeRaid[] {
  const membersByRaid = new Map<string, Set<string>>();
  for (const p of parties) {
    let set = membersByRaid.get(p.raidId);
    if (!set) {
      set = new Set<string>();
      membersByRaid.set(p.raidId, set);
    }
    for (const id of p.memberIds) set.add(id);
  }
  return raids.map((r) =>
    r.leaderId && !membersByRaid.get(r.raidId)?.has(r.leaderId)
      ? { ...r, leaderId: null }
      : r,
  );
}

// Remove any memberId no longer in this guild's roster, cap each party to
// `partySize` (a shrunk party size frees overflow members back to the pool),
// and RE-KEY lockedSlots onto the compacted indexes.
//
// The re-keying is the subtle part. `lockedSlots` holds indexes INTO THE DENSE
// `memberIds` ARRAY, so when the array compacts every index after a removal
// shifts. The lock must follow the MEMBER, not the slot number: record the
// userIds that sat in locked indexes while walking the OLD array, then recompute
// the locks as those userIds' NEW indexes. Getting this wrong only shows up
// after someone leaves the guild, which is why it is spelled out here.
//
// PURE — it computes, it does not persist. It returns the corrected parties PLUS
// the writes that would bring the DB in line; getSiegeBoard (a render) renders
// the corrected parties and DISCARDS the writes, seedSiegeBoard (the write path,
// reached from a server action) applies them. That is what keeps a page view
// read-only. NO revalidatePath here or in either caller — this is reachable
// during render.
function reconcile(
  parties: SiegeParty[],
  validIds: Set<string>,
  partySize: number,
): {
  parties: SiegeParty[];
  writes: AnyBulkWriteOperation<SiegePartyDoc>[];
} {
  const writes: AnyBulkWriteOperation<SiegePartyDoc>[] = [];

  const reconciled = parties.map((p) => {
    let changed = false;
    const lockedSet = new Set(p.lockedSlots);
    const keptLockedUids = new Set<string>();
    const nextMemberIds: string[] = [];
    for (let i = 0; i < p.memberIds.length; i++) {
      const uid = p.memberIds[i];
      if (validIds.has(uid) && nextMemberIds.length < partySize) {
        if (lockedSet.has(i)) keptLockedUids.add(uid);
        nextMemberIds.push(uid);
      } else {
        changed = true; // departed member OR over the (possibly shrunk) cap
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

  return { parties: reconciled, writes };
}

// Read the siege board for ONE guild. THE READ PATH — in the steady state it
// issues three finds (raids, parties, and the guild roster for the reconcile)
// plus the settings read, and NO WRITES.
//
// Self-healing: if any canonical raid or party document is missing — a fresh
// database, or a structure change — it falls through to seedSiegeBoard, which
// is the write path. The check is free: it runs over the documents this
// function had to read anyway.
export async function getSiegeBoard(guild: Guild): Promise<SiegeBoard> {
  const canonical = canonicalBoard(guild);
  if (!isMongoConfigured) return canonical;

  const settings = await getSettings();
  const db = await getDb();
  const raidCol = db.collection<SiegeRaidDoc>(SIEGE_RAIDS);
  const partyCol = db.collection<SiegePartyDoc>(SIEGE_PARTIES);

  const [raidDocs, partyDocs] = await Promise.all([
    raidCol.find({ type: guild }).toArray(),
    partyCol.find({ type: guild }).toArray(),
  ]);

  const haveRaids = new Set(raidDocs.map((d) => d.raidId));
  const haveParties = new Set(partyDocs.map((d) => d.partyId));
  const incomplete =
    canonical.raids.some((r) => !haveRaids.has(r.raidId)) ||
    canonical.parties.some((p) => !haveParties.has(p.partyId));
  if (incomplete) return seedSiegeBoard(guild);

  const assembled = assembleBoard(canonical, raidDocs, partyDocs);
  const validIds = new Set((await getMembers(guild)).map((m) => m.userId));
  const { parties } = reconcile(assembled.parties, validIds, settings.partySize);
  return { raids: dropOrphanLeaders(assembled.raids, parties), parties };
}

export { SIEGE_RAIDS, SIEGE_PARTIES };
