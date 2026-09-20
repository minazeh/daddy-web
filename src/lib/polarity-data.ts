import "server-only";
import type { AnyBulkWriteOperation } from "mongodb";
import { getDb, isMongoConfigured } from "./mongo";
import { ensureSchema } from "./bootstrap";
import { getMembers, getSettings } from "./data";
import type { Guild } from "./types";
import {
  polarityPartyId,
  polarityPartyName,
  polarityRaidName,
  polarityStructure,
  type PolarityKind,
  type PolarityParty,
  type PolarityRaid,
} from "./polarity";

// ============================================================================
// POLARITY RAIDS — server-side data access.
//
// Two NEW web-owned collections, fully isolated from the GvG structure:
//   polarityRaids   — the 6 raid groups per guild (name + leader).
//   polarityParties — their parties (5 per raid, every raid).
// The existing `parties` / `raidGroups` collections are never touched here.
//
// The structure is FIXED, so seeding is a pure idempotent upsert: canonical
// ids are computed from the structure and `$setOnInsert` never disturbs an
// existing assignment. Nothing is ever deleted.
//
// HIDDEN SURPLUS PARTIES. Normal raids ran 8 parties until 2026-09-20; the
// documents at positions 5-7 are still in `polarityParties`, with whatever
// they last held. They are HIDDEN, NOT DELETED (Conrad's call). Every read
// path here is driven by `canonicalBoard` → `polarityStructure`, which now
// stops at position 4, so:
//   - assembleBoard never returns them, and the board's `parties` array — the
//     one the UI counts "assigned" and "unassigned" from — is visible-only, so
//     a member sitting in a hidden row counts as UNASSIGNED and comes back to
//     the pool, which is exactly right;
//   - `reconcile` only ever walks the assembled (visible) parties, so it can
//     neither prune nor rewrite them;
//   - the seeding bulkWrite addresses canonical ids only, with $setOnInsert.
// Raising POLARITY_NORMAL_PARTY_COUNT again brings them back untouched.
//
// IMPORTANT — no revalidation from a read path. `reconcile()` below writes
// during a render (pruning departed members), exactly like the GvG
// `ensureGuildParties`, but it deliberately does NOT call `revalidatePath`.
// Next throws when revalidation happens during render; the GvG path carried a
// cold-load 500 for precisely that reason until its `reconcileParties` was
// brought in line with this one. Revalidation lives ONLY in the server actions.
// ============================================================================

const POLARITY_RAIDS = "polarityRaids";
const POLARITY_PARTIES = "polarityParties";

interface PolarityRaidDoc {
  raidId: string;
  type: Guild;
  kind?: PolarityKind;
  index?: number;
  name?: string;
  position?: number;
  leaderId?: string | null;
  updatedAt?: Date | string;
}

interface PolarityPartyDoc {
  partyId: string;
  type: Guild;
  raidId?: string;
  kind?: PolarityKind;
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

function normalizeKind(v: unknown): PolarityKind {
  return v === "normal" ? "normal" : "main";
}

// A blank raid / party for the canonical structure.
function blankRaid(
  guild: Guild,
  kind: PolarityKind,
  index: number,
  position: number,
  raidId: string,
): PolarityRaid {
  return {
    raidId,
    type: guild,
    kind,
    index,
    name: polarityRaidName(kind, index),
    position,
    leaderId: null,
    updatedAt: new Date().toISOString(),
  };
}

function blankParty(
  guild: Guild,
  raidId: string,
  kind: PolarityKind,
  position: number,
): PolarityParty {
  return {
    partyId: polarityPartyId(raidId, position),
    type: guild,
    raidId,
    kind,
    name: polarityPartyName(position),
    memberIds: [],
    position,
    lockedSlots: [],
    updatedAt: new Date().toISOString(),
  };
}

function serializeRaid(d: PolarityRaidDoc, fallback: PolarityRaid): PolarityRaid {
  return {
    raidId: d.raidId,
    type: d.type,
    kind: normalizeKind(d.kind ?? fallback.kind),
    index: typeof d.index === "number" ? d.index : fallback.index,
    name: typeof d.name === "string" && d.name ? d.name : fallback.name,
    position: typeof d.position === "number" ? d.position : fallback.position,
    leaderId: typeof d.leaderId === "string" ? d.leaderId : null,
    updatedAt: toIso(d.updatedAt),
  };
}

function serializeParty(
  d: PolarityPartyDoc,
  fallback: PolarityParty,
): PolarityParty {
  return {
    partyId: d.partyId,
    type: d.type,
    raidId: typeof d.raidId === "string" ? d.raidId : fallback.raidId,
    kind: normalizeKind(d.kind ?? fallback.kind),
    name: typeof d.name === "string" && d.name ? d.name : fallback.name,
    memberIds: Array.isArray(d.memberIds) ? d.memberIds : [],
    position: typeof d.position === "number" ? d.position : fallback.position,
    lockedSlots: Array.isArray(d.lockedSlots) ? d.lockedSlots : [],
    updatedAt: toIso(d.updatedAt),
  };
}

export interface PolarityBoard {
  raids: PolarityRaid[]; // always 6, in structural order
  // Always 6*5 = 30, grouped by raid then position. VISIBLE parties only —
  // the hidden surplus rows (positions 5-7 of a normal raid) are not here.
  parties: PolarityParty[];
}

// The canonical (all-blank) board for a guild — used as the mock-mode result
// and as the per-document fallback when a stored doc predates a field.
function canonicalBoard(guild: Guild): PolarityBoard {
  const raids: PolarityRaid[] = [];
  const parties: PolarityParty[] = [];
  for (const spec of polarityStructure(guild)) {
    raids.push(
      blankRaid(guild, spec.kind, spec.index, spec.position, spec.raidId),
    );
    for (let i = 0; i < spec.partyCount; i++) {
      parties.push(blankParty(guild, spec.raidId, spec.kind, i));
    }
  }
  return { raids, parties };
}

// SEED the 6-raid / 30-party structure for ONE guild - THE WRITE PATH. Never
// deletes: the structure is fixed, so there are no strays to prune, and
// `$setOnInsert` leaves every existing assignment untouched.
//
// Called from the settings action (a partySize change is the only thing that
// can require the board to be re-capped) and, self-healing, from
// getPolarityBoard when it finds a document missing. It is NOT on the
// steady-state render path: a page view that finds the full board performs no
// writes at all. Rendering /polarity-raids used to cost 8 writes - two
// createIndex round trips, two seeding bulkWrites that inserted nothing, the
// memberMeta sync and the settings upsert - ~363 ms of pure no-ops.
export async function seedPolarityBoard(guild: Guild): Promise<PolarityBoard> {
  const canonical = canonicalBoard(guild);
  if (!isMongoConfigured) return canonical;

  // The unique indexes are what make the upserts below race-safe, so the write
  // path (and only the write path) waits for the schema bootstrap.
  await ensureSchema();

  const settings = await getSettings();
  const db = await getDb();
  const raidCol = db.collection<PolarityRaidDoc>(POLARITY_RAIDS);
  const partyCol = db.collection<PolarityPartyDoc>(POLARITY_PARTIES);

  await raidCol.bulkWrite(
    canonical.raids.map((r) => ({
      updateOne: {
        filter: { raidId: r.raidId },
        update: {
          $setOnInsert: {
            raidId: r.raidId,
            type: r.type,
            kind: r.kind,
            index: r.index,
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
            kind: p.kind,
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

  // Reconcile against the live roster + the current party size, and PERSIST the
  // corrections (this is the write path, so the DB is brought fully in line).
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
  canonical: PolarityBoard,
  raidDocs: PolarityRaidDoc[],
  partyDocs: PolarityPartyDoc[],
): PolarityBoard {
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

// Drop a leader that is no longer in any of its raid's parties.
function dropOrphanLeaders(
  raids: PolarityRaid[],
  parties: PolarityParty[],
): PolarityRaid[] {
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
// and re-key lockedSlots onto the compacted indexes.
//
// PURE - it computes, it does not persist. It returns the corrected parties
// PLUS the writes that would bring the DB in line; getPolarityBoard (a render)
// renders the corrected parties and discards the writes, seedPolarityBoard (the
// write path, reached from a server action) applies them. That is what keeps a
// page view read-only. NO revalidatePath here or in either caller - this is
// reachable during render.
function reconcile(
  parties: PolarityParty[],
  validIds: Set<string>,
  partySize: number,
): {
  parties: PolarityParty[];
  writes: AnyBulkWriteOperation<PolarityPartyDoc>[];
} {
  const writes: AnyBulkWriteOperation<PolarityPartyDoc>[] = [];

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

// Read the polarity board for ONE guild. THE READ PATH - in the steady state it
// issues three finds (raids, parties, and the guild roster for the reconcile)
// and NO writes.
//
// Self-healing: if any canonical raid or party document is missing - a fresh
// database, or a structure change - it falls through to seedPolarityBoard,
// which is the write path. The check is free: it runs over the documents this
// function had to read anyway.
export async function getPolarityBoard(guild: Guild): Promise<PolarityBoard> {
  const canonical = canonicalBoard(guild);
  if (!isMongoConfigured) return canonical;

  const settings = await getSettings();
  const db = await getDb();
  const raidCol = db.collection<PolarityRaidDoc>(POLARITY_RAIDS);
  const partyCol = db.collection<PolarityPartyDoc>(POLARITY_PARTIES);

  const [raidDocs, partyDocs] = await Promise.all([
    raidCol.find({ type: guild }).toArray(),
    partyCol.find({ type: guild }).toArray(),
  ]);

  const haveRaids = new Set(raidDocs.map((d) => d.raidId));
  const haveParties = new Set(partyDocs.map((d) => d.partyId));
  const incomplete =
    canonical.raids.some((r) => !haveRaids.has(r.raidId)) ||
    canonical.parties.some((p) => !haveParties.has(p.partyId));
  if (incomplete) return seedPolarityBoard(guild);

  const assembled = assembleBoard(canonical, raidDocs, partyDocs);
  const validIds = new Set((await getMembers(guild)).map((m) => m.userId));
  const { parties } = reconcile(assembled.parties, validIds, settings.partySize);
  return { raids: dropOrphanLeaders(assembled.raids, parties), parties };
}

export { POLARITY_RAIDS, POLARITY_PARTIES };
