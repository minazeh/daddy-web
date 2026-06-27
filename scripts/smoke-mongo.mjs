// Live Atlas connection smoke test.
// Loads .env.local exactly the way Next.js does (via @next/env) and connects to
// the `discordbot` database, then prints ONLY the document counts for the
// `members` and `parties` collections. The connection string / secret is NEVER
// printed. Safe to rerun.
//
//   node scripts/smoke-mongo.mjs
//
// Expected right now: members likely 0 (bot member-sync built but not yet
// deployed). A clean connection + counts means the web app can talk to Atlas.

import nextEnv from "@next/env";
import { MongoClient } from "mongodb";

const { loadEnvConfig } = nextEnv;

const projectDir = process.cwd();
loadEnvConfig(projectDir); // reads .env, .env.local, etc. — same as the app

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set (.env.local missing or empty). Abort.");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });

try {
  await client.connect();
  await client.db("discordbot").command({ ping: 1 });
  const db = client.db("discordbot");
  const members = await db.collection("members").countDocuments();
  const parties = await db.collection("parties").countDocuments();
  console.log("connection: OK");
  console.log(`discordbot.members docs: ${members}`);
  console.log(`discordbot.parties docs: ${parties}`);
} catch (err) {
  // Print only the error message/name, not anything that could echo the URI.
  console.error("connection: FAILED");
  console.error(`${err?.name ?? "Error"}: ${err?.message ?? "unknown error"}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
