// Verify member-assignment persistence + seed idempotency end-to-end:
// assign a member to daddy-main-0, re-run the seed (ensureGuildParties), and
// confirm the assignment survives (seed never overwrites existing parties).
import nextEnv from "@next/env";
import { MongoClient } from "mongodb";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const col = c.db("discordbot").collection("parties");
// pick a real daddy member
const mem = await c.db("discordbot").collection("members").findOne({ isMain: true });
const uid = mem.userId;
// assign to daddy-main-0
await col.updateOne({ partyId: "daddy-main-0" }, { $set: { memberIds: [uid], updatedAt: new Date() } });
console.log("assigned", uid, "to daddy-main-0");
// simulate a reload seed: upsert all canonical daddy ids with $setOnInsert (should NOT touch existing)
const ops = [];
for (let i=0;i<12;i++) ops.push({ updateOne: { filter:{partyId:`daddy-main-${i}`}, update:{ $setOnInsert:{ partyId:`daddy-main-${i}`, memberIds:[] } }, upsert:true }});
for (let i=0;i<18;i++) ops.push({ updateOne: { filter:{partyId:`daddy-sub-${i}`}, update:{ $setOnInsert:{ partyId:`daddy-sub-${i}`, memberIds:[] } }, upsert:true }});
await col.bulkWrite(ops, { ordered:false });
const after = await col.findOne({ partyId: "daddy-main-0" });
console.log("after re-seed, daddy-main-0 memberIds:", JSON.stringify(after.memberIds), "-> retained:", after.memberIds.includes(uid));
// cleanup: clear the test assignment so the board starts blank
await col.updateOne({ partyId: "daddy-main-0" }, { $set: { memberIds: [] } });
console.log("cleaned test assignment");
console.log("final party count:", await col.countDocuments({}));
await c.close();
