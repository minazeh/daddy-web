import "server-only";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import { getDb, isMongoConfigured } from "./mongo";
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
//   polarityParties — their parties (5 per main raid, 8 per normal raid).
// The existing `parties` / `raidGroups` collections are never touched here.
//
// The structure is FIXED, so seeding is a pure idempotent upsert: canonical
// ids are computed from the structure and `$setOnInsert` never disturbs an
// existing assignment. Nothing is ever deleted.
//
// IMPORTANT — no revalidation from a read path. `reconcile()` below writes
// during a render (pruning departed members), exactly like the GvG
// `ensureGuildParties`, but it deliberately does NOT call `revalidatePath`.
// Next throws when revalidation happens during render; the GvG path has a
// known cold-load 500 for precisely that reason (data.ts:576). Revalidation
// for this feature lives ONLY in the server actions.
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
  parties: PolarityParty[]; // always 2*5 + 4*8 = 42, grouped by raid then position
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

// Idempotently guarantee the 6-raid / 42-party structure for ONE guild and
// return it. Never deletes: the structure is fixed, so there are no strays to
// prune, and `$setOnInsert` leaves every existing assignment untouched.
export async function ensurePolarityBoard(guild: Guild): Promise<PolarityBoard> {
  const canonical = canonicalBoard(guild);
  if (!isMongoConfigured) return canonical;

  const settings = await getSettings();
  const db = await getDb();
  const raidCol = db.collection<PolarityRaidDoc>(POLARITY_RAIDS);
  const partyCol = db.collection<PolarityPartyDoc>(POLARITY_PARTIES);

  // Unique indexes make the upsert seed race-safe.
  await Promise.all([
    raidCol.createIndex({ raidId: 1 }, { unique: true }),
    partyCol.createIndex({ partyId: 1 }, { unique: true }),
  ]);

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
  const raidById = new Map(raidDocs.map((d) => [d.raidId, d]));
  const partyById = new Map(partyDocs.map((d) => [d.partyId, d]));

  // Read back in CANONICAL order, so the board is deterministic regardless of
  // Mongo's natural order and immune to any unexpected extra document.
  const raids = canonical.raids.map((r) => {
    const doc = raidById.get(r.raidId);
    return doc ? serializeRaid(doc, r) : r;
  });
  const parties = canonical.parties.map((p) => {
    const doc = partyById.get(p.partyId);
    return doc ? serializeParty(doc, p) : p;
  });

  // Reconcile against the live roster + the current party size.
  const validIds = new Set((await getMembers(guild)).map((m) => m.userId));
  const reconciled = await reconcile(
    partyCol,
    parties,
    validIds,
    settings.partySize,
  );

  // Drop a leader that is no longer in any of its raid's parties.
  const membersByRaid = new Map<string, Set<string>>();
  for (const p of reconciled) {
    let set = membersByRaid.get(p.raidId);
    if (!set) {
      set = new Set<string>();
      membersByRaid.set(p.raidId, set);
    }
    for (const id of p.memberIds) set.add(id);
  }
  const cleanedRaids = raids.map((r) =>
    r.leaderId && !membersByRaid.get(r.raidId)?.has(r.leaderId)
      ? { ...r, leaderId: null }
      : r,
  );

  return { raids: cleanedRaids, parties: reconciled };
}

// Remove any memberId no longer in this guild's roster, cap each party to
// `partySize` (a shrunk party size frees overflow members back to the pool),
// and re-key lockedSlots onto the compacted indexes. Persists ONLY the parties
// that actually changed. NO revalidatePath — this runs during render.
async function reconcile(
  col: Collection<PolarityPartyDoc>,
  parties: PolarityParty[],
  validIds: Set<string>,
  partySize: number,
): Promise<PolarityParty[]> {
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

  if (writes.length > 0) await col.bulkWrite(writes, { ordered: false });
  return reconciled;
}

// Read the polarity board for ONE guild (seeds it on first access).
export async function getPolarityBoard(guild: Guild): Promise<PolarityBoard> {
  return ensurePolarityBoard(guild);
}

export { POLARITY_RAIDS, POLARITY_PARTIES };
