import "server-only";
import { MongoClient, type Db } from "mongodb";

// Serverless-safe MongoClient singleton (the standard Next.js / Vercel pattern).
// The connect() promise is cached on `globalThis` in EVERY environment so that:
//   - in dev, HMR module re-evaluation reuses one connection (no leak per save);
//   - on Vercel serverless, a warm function invocation reuses the existing pool
//     instead of opening a new one — preventing Atlas connection exhaustion.
// This module is server-only — process.env.MONGODB_URI never reaches the browser.

const DB_NAME = "discordbot";

const uri = process.env.MONGODB_URI;

// `isMongoConfigured` lets the data layer render a graceful empty / mock state
// instead of crashing when MONGODB_URI is unset (local dev without a DB).
export const isMongoConfigured = Boolean(uri);

declare global {
  // Cached across module re-evaluations within a single runtime/container.
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

function getClientPromise(): Promise<MongoClient> {
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Mongo access is unavailable; the app should " +
        "guard reads/writes behind isMongoConfigured.",
    );
  }
  const cached = globalThis._mongoClientPromise;
  if (cached) return cached;

  const pending = new MongoClient(uri).connect();
  globalThis._mongoClientPromise = pending;

  // A REJECTED connect must not be cached. Without this, one transient failure
  // — a DNS/SRV hiccup or a server-selection timeout on a serverless cold start
  // — leaves a permanently rejected promise on `globalThis`, and every later
  // getDb() on that instance re-throws it: a single blip bricks the whole
  // container until it recycles. Dropping the memo lets the next caller retry
  // with a fresh client. Same guard `ensureSchema` already applies to its own
  // memo (see bootstrap.ts). The `=== pending` check makes it safe against a
  // concurrent replacement; the handler swallows, so the returned promise (not
  // this derived one) is what callers see reject.
  pending.catch(() => {
    if (globalThis._mongoClientPromise === pending) {
      globalThis._mongoClientPromise = undefined;
    }
  });

  return pending;
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise();
  return client.db(DB_NAME);
}
