// One-time cleanup: collapse duplicate parties sharing a partyId (caused by an
// earlier non-atomic seed race), keeping the one with the most assigned members
// (so we don't lose assignments), then leave the collection ready for a unique
// index on partyId. Safe/idempotent to rerun.
import nextEnv from "@next/env";
import { MongoClient } from "mongodb";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const col = c.db("discordbot").collection("parties");
const all = await col.find({}).toArray();
const byPid = new Map();
for (const d of all) {
  if (!byPid.has(d.partyId)) byPid.set(d.partyId, []);
  byPid.get(d.partyId).push(d);
}
let removed = 0;
for (const [pid, docs] of byPid) {
  if (docs.length <= 1) continue;
  // keep the one with most memberIds; delete the rest by _id
  docs.sort((a,b) => (b.memberIds?.length||0) - (a.memberIds?.length||0));
  const keep = docs[0];
  const dropIds = docs.slice(1).map(d => d._id);
  await col.deleteMany({ _id: { $in: dropIds } });
  removed += dropIds.length;
  console.log(`dedup ${pid}: kept 1 (members=${keep.memberIds?.length||0}), removed ${dropIds.length}`);
}
console.log("total duplicate rows removed:", removed);
console.log("remaining parties:", await col.countDocuments({}));
await c.close();
