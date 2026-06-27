import nextEnv from "@next/env";
import { MongoClient } from "mongodb";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const col = c.db("discordbot").collection("parties");
for (const guild of ["daddy","mummy"]) {
  const main = await col.countDocuments({ type: guild, field: "main" });
  const sub = await col.countDocuments({ type: guild, field: "sub" });
  const noField = await col.countDocuments({ type: guild, field: { $exists: false } });
  const canonical = await col.countDocuments({ type: guild, partyId: { $regex: `^${guild}-(main|sub)-` } });
  console.log(`${guild}: main=${main} sub=${sub} noField=${noField} canonicalId=${canonical}`);
}
const total = await col.countDocuments({});
const otherType = await col.countDocuments({ type: { $nin: ["daddy","mummy"] } });
console.log("total:", total, "| docs with type not daddy/mummy:", otherType);
// sample stray ids
const strays = await col.find({ partyId: { $not: { $regex: "^(daddy|mummy)-(main|sub)-" } } }).project({partyId:1,type:1,field:1,_id:0}).limit(10).toArray();
console.log("non-canonical id samples:", JSON.stringify(strays));
await c.close();
