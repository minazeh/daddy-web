// One-off diagnostic: confirm displayName ties + sort-order instability in the
// live `members` data that caused the hydration mismatch, and that the
// total-order sort is deterministic. Prints no secrets. (Temp diagnostic.)
import nextEnv from "@next/env";
import { MongoClient } from "mongodb";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db("discordbot");
const docs = await db
  .collection("members")
  .find({ isMain: true })
  .project({ displayName: 1, userId: 1, _id: 0 })
  .toArray();
const seen = new Map();
for (const d of docs) seen.set(d.displayName, (seen.get(d.displayName) || 0) + 1);
const dups = [...seen.entries()].filter(([, n]) => n > 1);
console.log("daddy (isMain) members:", docs.length);
console.log("displayName ties (>=2 share a name):", dups.length);
console.log(
  "sample ties:",
  dups.slice(0, 5).map(([n, k]) => `${JSON.stringify(n)} x${k}`).join(", ") ||
    "(none)",
);
const q1 = await db.collection("members").find({ isMain: true }).sort({ displayName: 1 }).project({ userId: 1, _id: 0 }).toArray();
const q2 = await db.collection("members").find({ isMain: true }).sort({ displayName: 1 }).project({ userId: 1, _id: 0 }).toArray();
console.log("displayName-only sort: two queries identical order?", q1.every((d, i) => d.userId === q2[i].userId));
const t1 = await db.collection("members").find({ isMain: true }).sort({ displayName: 1, userId: 1 }).project({ userId: 1, _id: 0 }).toArray();
const t2 = await db.collection("members").find({ isMain: true }).sort({ displayName: 1, userId: 1 }).project({ userId: 1, _id: 0 }).toArray();
console.log("total-order sort (displayName+userId): two queries identical order?", t1.every((d, i) => d.userId === t2[i].userId));
await c.close();
