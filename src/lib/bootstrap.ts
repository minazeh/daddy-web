import "server-only";
import { getDb, isMongoConfigured } from "./mongo";
import { DEFAULT_SETTINGS } from "./types";

// ============================================================================
// SCHEMA BOOTSTRAP — the one place that creates indexes and seeds the settings
// doc. Runs ONCE per server process (see src/instrumentation.ts), never during
// a render.
//
// These used to be inline in the data layer: `createIndex` on every getParties
// / getPowerMap / polarity board read, and a `$setOnInsert` settings upsert on
// every getSettings. `createIndex` against an existing index is a server-side
// no-op, but it is still a command round trip — measured at 49-108 ms each, and
// /polarity-raids was spending ~197 ms per view on three of them. Page views
// must not write; see the performance audit.
//
// The indexes still matter — they are what make the seeding upserts race-safe —
// so every remaining WRITE path (seedGuildParties, seedPolarityBoard,
// syncMemberMeta) awaits ensureSchema() before it writes. The memoized promise
// makes that free after the first call in a process.
// ============================================================================

let schema: Promise<void> | null = null;

// Seed the global settings doc if it is absent. Idempotent — $setOnInsert never
// disturbs edited values. getSettings() is a plain findOne now and degrades to
// DEFAULT_SETTINGS when the doc is missing, so this is belt-and-braces rather
// than a correctness requirement of the read path.
async function seedSettings(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  await db.collection("settings").updateOne(
    { _id: "global" as never },
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
}

async function build(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection("memberMeta").createIndex({ userId: 1 }, { unique: true }),
    db.collection("parties").createIndex({ partyId: 1 }, { unique: true }),
    db.collection("polarityRaids").createIndex({ raidId: 1 }, { unique: true }),
    db.collection("polarityParties").createIndex({ partyId: 1 }, { unique: true }),
    // One imported DPS row per (guild, member). Unique so the import's upserts
    // are race-safe, exactly like the party seeding above.
    db
      .collection("polarityDps")
      .createIndex({ guild: 1, userId: 1 }, { unique: true }),
    db.collection("siegeRaids").createIndex({ raidId: 1 }, { unique: true }),
    db.collection("siegeParties").createIndex({ partyId: 1 }, { unique: true }),
    seedSettings(db),
  ]);
}

// Idempotent, memoized per process. A failure clears the memo so the next
// caller retries rather than inheriting a permanently rejected promise.
export function ensureSchema(): Promise<void> {
  if (!isMongoConfigured) return Promise.resolve();
  if (!schema) {
    schema = build().catch((err) => {
      schema = null;
      throw err;
    });
  }
  return schema;
}
