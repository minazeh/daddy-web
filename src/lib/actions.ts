"use server";

import { revalidatePath } from "next/cache";
import { getDb, isMongoConfigured } from "./mongo";
import { MAX_PARTY_SLOTS } from "./types";

// Server actions that mutate the `parties` collection (db `discordbot`).
// The field structure is FIXED and pre-seeded (12 Main + 18 Sub per guild) by
// data.ts/ensureGuildParties — there is no create/delete/reposition; parties
// are only ever updated in place (member assignments + locks). All writes
// revalidate "/" so the dashboard reflects the new state. When MONGODB_URI is
// unset these are no-ops that return a clear notice (mock mode).

const PARTIES = "parties";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

const NOT_CONFIGURED: ActionResult = {
  ok: false,
  message: "MONGODB_URI is not set — changes are not persisted.",
};

// Persist a party's slot assignments (auto-saved on every drag).
export async function updateParty(
  partyId: string,
  memberIds: string[],
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  // Enforce slot cap + dedupe defensively on the server.
  const deduped = Array.from(new Set(memberIds)).slice(0, MAX_PARTY_SLOTS);
  const db = await getDb();
  await db.collection(PARTIES).updateOne(
    { partyId },
    { $set: { memberIds: deduped, updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true };
}

// Persist the set of locked slot indexes for a party.
export async function setPartyLocks(
  partyId: string,
  lockedSlots: number[],
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const cleaned = Array.from(new Set(lockedSlots)).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < MAX_PARTY_SLOTS,
  );
  const db = await getDb();
  await db.collection(PARTIES).updateOne(
    { partyId },
    { $set: { lockedSlots: cleaned, updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true };
}

// Persist a party rename (cards are still individually renameable).
export async function renameParty(
  partyId: string,
  name: string,
): Promise<ActionResult> {
  if (!isMongoConfigured) return NOT_CONFIGURED;

  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { ok: false, message: "Name cannot be empty." };
  const db = await getDb();
  await db.collection(PARTIES).updateOne(
    { partyId },
    { $set: { name: trimmed, updatedAt: new Date() } },
  );
  revalidatePath("/");
  return { ok: true };
}
