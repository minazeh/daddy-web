import "server-only";
import type { AnyBulkWriteOperation } from "mongodb";
import { getDb, isMongoConfigured } from "./mongo";
import { MOCK_POLARITY_DPS, mockDpsKey } from "./mock";
import type { StoredDps } from "./ranking-import";
import type { Guild } from "./types";

// ============================================================================
// POLARITY DPS — server-side data access for the imported ranking figures.
//
// A THIRD web-owned collection alongside polarityRaids / polarityParties, and
// the reason it is its own collection rather than another field on memberMeta:
//
//   `memberMeta.power` is HAND-MAINTAINED data. It drives the /members
//   leaderboard, the GvG builder's Generate and Siege. The DPS figures come
//   from a pasted game ranking and drive the polarity main raids ONLY. Mixing
//   them would mean a ranking paste silently re-ordered three other features.
//   They are separate values with separate lifecycles, so they are separate
//   documents.
//
// The bot never reads or writes this collection, so nothing on the bot side
// needs to change. The name is namespaced with the rest of the polarity feature
// (`polarityDps`) so it cannot collide with a bot-owned collection.
//
// ONE DOCUMENT PER (guild, userId). A member who is somehow on both rosters
// carries an independent row per guild — an import targets exactly one guild,
// exactly like the CSV power import.
//
// NO WRITES ON THE RENDER PATH. getPolarityDpsMap is a single projected find
// and nothing else; the only writer is the server action.
// ============================================================================

const POLARITY_DPS = "polarityDps";

interface PolarityDpsDoc {
  guild: Guild;
  userId: string;
  dps?: number;
  total?: number;
  deadSeconds?: number;
  /** The Class column as it appeared in the import. */
  className?: string;
  /** When the member submitted the run, inferred from the MM-DD HH:MM stamp. */
  submittedAt?: Date | string;
  /** When this row was written by an import. */
  importedAt?: Date | string;
}

function toIso(v: Date | string | undefined): string {
  if (!v) return new Date(0).toISOString();
  return typeof v === "string" ? v : v.toISOString();
}

function serialize(d: PolarityDpsDoc): StoredDps {
  return {
    dps: typeof d.dps === "number" && d.dps >= 0 ? Math.floor(d.dps) : 0,
    total: typeof d.total === "number" && d.total >= 0 ? Math.floor(d.total) : 0,
    deadSeconds:
      typeof d.deadSeconds === "number" && d.deadSeconds >= 0
        ? d.deadSeconds
        : 0,
    className: typeof d.className === "string" ? d.className : "",
    submittedAt: toIso(d.submittedAt),
  };
}

/**
 * The imported DPS rows for ONE guild, keyed userId. PURE READ, one round trip.
 * Members with no imported row are simply absent from the map — the generator
 * treats that as "not eligible for a main raid", never as DPS 0.
 */
export async function getPolarityDpsMap(
  guild: Guild,
): Promise<Map<string, StoredDps>> {
  const map = new Map<string, StoredDps>();

  if (!isMongoConfigured) {
    for (const [key, row] of MOCK_POLARITY_DPS) {
      if (key.startsWith(`${guild}:`)) {
        map.set(key.slice(guild.length + 1), { ...row });
      }
    }
    return map;
  }

  const db = await getDb();
  const docs = await db
    .collection<PolarityDpsDoc>(POLARITY_DPS)
    .find({ guild })
    .project<PolarityDpsDoc>({
      _id: 0,
      guild: 1,
      userId: 1,
      dps: 1,
      total: 1,
      deadSeconds: 1,
      className: 1,
      submittedAt: 1,
    })
    .batchSize(5000)
    .toArray();
  for (const d of docs) map.set(d.userId, serialize(d));
  return map;
}

export interface PolarityDpsWrite {
  userId: string;
  dps: number;
  total: number;
  deadSeconds: number;
  className: string;
  /** ISO string. */
  submittedAt: string;
}

/**
 * Persist confirmed ranking rows for one guild. THE ONLY WRITE PATH.
 *
 * Upserts, unlike the CSV power import's deliberate no-upsert: a memberMeta row
 * missing is a sign something is wrong (the roster sync creates them), whereas
 * a polarityDps row is created by this import and by nothing else, so the first
 * import for a member legitimately has nothing to update.
 */
export async function writePolarityDps(
  guild: Guild,
  writes: PolarityDpsWrite[],
  importedAt: Date,
): Promise<void> {
  if (writes.length === 0) return;

  if (!isMongoConfigured) {
    for (const w of writes) {
      MOCK_POLARITY_DPS.set(mockDpsKey(guild, w.userId), {
        dps: w.dps,
        total: w.total,
        deadSeconds: w.deadSeconds,
        className: w.className,
        submittedAt: w.submittedAt,
      });
    }
    return;
  }

  const db = await getDb();
  const ops: AnyBulkWriteOperation<PolarityDpsDoc>[] = writes.map((w) => ({
    updateOne: {
      filter: { guild, userId: w.userId },
      update: {
        $set: {
          dps: w.dps,
          total: w.total,
          deadSeconds: w.deadSeconds,
          className: w.className,
          submittedAt: new Date(w.submittedAt),
          importedAt,
        },
        $setOnInsert: { guild, userId: w.userId },
      },
      upsert: true,
    },
  }));
  await db.collection<PolarityDpsDoc>(POLARITY_DPS).bulkWrite(ops, {
    ordered: false,
  });
}

export { POLARITY_DPS };
