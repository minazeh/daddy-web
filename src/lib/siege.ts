import type { Guild } from "./types";
import { evenQuotas } from "./polarity";

// ============================================================================
// SIEGE — domain types + the fixed structural rules.
//
// A Siege layout is a THIRD, INDEPENDENT raid arrangement that sits alongside
// the GvG main/sub board and the Polarity board. It shares no data with either:
// its own `siegeRaids` + `siegeParties` collections, its own page, its own
// server actions. `parties` / `raidGroups` / `polarityParties` / `polarityRaids`
// are never read or written by this feature.
//
// A member may sit in a GvG party, a Polarity raid AND a Siege party at the same
// time — that is INTENDED. There is deliberately no cross-feature exclusivity
// check anywhere in this feature. "Nothing overlaps" meant the COLLECTIONS must
// not collide, not that members are exclusive.
//
// Daddy and Mummy remain two SEPARATE guilds (see the header of types.ts).
// Everything here is scoped per guild — FOUR raids PER GUILD, so two entirely
// independent sieges: 2 x 4 x 8 x 5 = 320 slots in total.
//
// Structure (fixed; only `partySize` is configurable, via global Settings):
//   alpha / bravo / charlie / delta  x  8 parties each
// There is no main/normal split — every raid is the same shape. Delta's display
// name is "Delta Flex": it is EXPECTED to run 6 parties, and parties 7-8 are a
// visual flex/overflow state (dimmed). That expectation is PURELY COSMETIC —
// all 8 parties are seeded, all 8 render, all 8 are freely usable and Generate
// fills them like any other. Nothing enforces the 6.
// ============================================================================

export type SiegeRaidKey = "alpha" | "bravo" | "charlie" | "delta";

export const SIEGE_RAID_KEYS: SiegeRaidKey[] = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
];

// Total raids per guild — FOUR.
export const SIEGE_TOTAL_RAIDS = SIEGE_RAID_KEYS.length;

// Parties per raid — UNIFORM across all four raids. Every raid always exposes
// all 8; see the flex note above.
export const SIEGE_PARTY_COUNT = 8;

// How many parties a raid is EXPECTED to fill. Parties at a position >= this
// value render as "flex" (dimmed) but are otherwise completely ordinary — no
// cap, no unlock gesture, no data-model support of any kind. Only Delta Flex
// differs from the seeded 8.
export const SIEGE_EXPECTED_PARTY_COUNT: Record<SiegeRaidKey, number> = {
  alpha: SIEGE_PARTY_COUNT,
  bravo: SIEGE_PARTY_COUNT,
  charlie: SIEGE_PARTY_COUNT,
  delta: 6,
};

// Default display names. Delta is "Delta Flex" — the name is the only place the
// flex expectation is stated to the user besides the dimming.
export const SIEGE_RAID_LABEL: Record<SiegeRaidKey, string> = {
  alpha: "Alpha",
  bravo: "Bravo",
  charlie: "Charlie",
  delta: "Delta Flex",
};

// Cards per row in the party grid. 4 divides the 8 parties into exactly two
// even rows, so a raid always reads as one rectangular block and the flex
// parties (delta 7-8) land together at the bottom-right of their raid.
export const SIEGE_CARDS_PER_ROW = 4;

// ---- Documents ------------------------------------------------------------
// NOTE ON FIELD NAMES: a siege party's primary key is called `partyId` (and a
// raid's `raidId`) even though it lives in its own collection — the same
// reasoning as PolarityParty. It makes `SiegeParty` structurally compatible
// with the shared `PlanSource` (generate.ts) and with `PartyCard`, so the
// generator and the UI are genuinely reused rather than duplicated. The id
// VALUES are namespaced (`daddy-siege-alpha-p3`) so they can never be confused
// with a GvG party id (`daddy-main-3`) or a Polarity one
// (`daddy-polarity-main-0-p3`), and the collections are separate regardless.

export interface SiegeRaid {
  raidId: string; // deterministic: `${guild}-siege-${raidKey}`
  type: Guild;
  raidKey: SiegeRaidKey;
  name: string;
  position: number; // display order 0..3, matching SIEGE_RAID_KEYS
  // The raid leader: a userId that MUST be a member of one of this raid's
  // parties. null = no leader. ONE leader per raid, four per guild — there are
  // deliberately no party-level leaders.
  leaderId: string | null;
  updatedAt: string; // ISO
}

export interface SiegeParty {
  partyId: string; // deterministic: `${raidId}-p${position}`
  type: Guild;
  raidId: string;
  raidKey: SiegeRaidKey;
  name: string;
  memberIds: string[]; // assigned userIds, max settings.partySize
  position: number; // 0-based index within its raid (0..7)
  lockedSlots: number[]; // slot indexes into memberIds that are locked
  updatedAt: string; // ISO
}

// ---- Deterministic ids ----------------------------------------------------

export function siegeRaidId(guild: Guild, raidKey: SiegeRaidKey): string {
  return `${guild}-siege-${raidKey}`;
}

export function siegePartyId(raidId: string, position: number): string {
  return `${raidId}-p${position}`;
}

export function siegeRaidName(raidKey: SiegeRaidKey): string {
  return SIEGE_RAID_LABEL[raidKey];
}

export function siegePartyName(position: number): string {
  return `Party ${position + 1}`;
}

// Is this party position part of the raid's dimmed flex overflow? Cosmetic
// ONLY — nothing branches on this outside the presentation layer.
export function isFlexParty(raidKey: SiegeRaidKey, position: number): boolean {
  return position >= SIEGE_EXPECTED_PARTY_COUNT[raidKey];
}

// ---- Structure ------------------------------------------------------------

export interface SiegeRaidSpec {
  raidKey: SiegeRaidKey;
  position: number;
  raidId: string;
  partyCount: number;
}

// The canonical 4-raid skeleton for one guild, in display order.
export function siegeStructure(guild: Guild): SiegeRaidSpec[] {
  return SIEGE_RAID_KEYS.map((raidKey, position) => ({
    raidKey,
    position,
    raidId: siegeRaidId(guild, raidKey),
    partyCount: SIEGE_PARTY_COUNT,
  }));
}

// People cap for ONE raid = parties x partySize (40 at the default partySize).
// Identical for all four raids, Delta included — the flex expectation does not
// reduce Delta's capacity.
export function siegeRaidCapacity(partySize: number): number {
  return SIEGE_PARTY_COUNT * partySize;
}

// The headcount a raid is EXPECTED to hold — Delta's 6 x partySize, everyone
// else's 8 x partySize. Shown in the raid header next to the real capacity;
// never used to restrict anything.
export function siegeExpectedCapacity(
  raidKey: SiegeRaidKey,
  partySize: number,
): number {
  return SIEGE_EXPECTED_PARTY_COUNT[raidKey] * partySize;
}

// Total people one guild's siege layout can hold.
// 4 x 8 x partySize = 32 x partySize = 160 at the default.
export function siegeTotalCapacity(partySize: number): number {
  return SIEGE_TOTAL_RAIDS * siegeRaidCapacity(partySize);
}

// ---- Quotas ---------------------------------------------------------------

// The per-cohort quota function handed to generateCohorts for Siege: an EVEN
// 4-WAY SPLIT across all four raids, Delta included.
//
// `evenQuotas` is imported from polarity.ts rather than copied — it is pure,
// generic bin-packing math with no Polarity-specific behaviour (see the Siege
// recon, section C). This is the ONLY thing Siege borrows from Polarity, and it
// is code, not data.
//
// CONSEQUENCE, DELIBERATELY ACCEPTED: an even split fills Delta to roughly the
// same party count as the other three, which cuts against "Delta normally runs
// 6". Conrad chose the even split with that trade-off in front of him. If he
// ever wants Alpha/Bravo/Charlie filled first with Delta taking only the
// remainder, that is a different function here and nothing else changes.
export function siegeQuotas(
  capacities: number[],
  remaining: number,
): number[] {
  return evenQuotas(remaining, capacities);
}
