import type { Guild } from "./types";

// ============================================================================
// POLARITY RAIDS — domain types + the fixed structural rules.
//
// A Polarity Raid layout is a SECOND, INDEPENDENT raid arrangement that sits
// alongside the existing GvG main/sub field structure. It shares nothing with
// it: its own `polarityRaids` + `polarityParties` collections, its own page,
// its own generator entry point. The GvG `parties` / `raidGroups` collections
// are never read or written by this feature.
//
// Daddy and Mummy remain two SEPARATE guilds (see the header of types.ts).
// Everything here is scoped per guild — SIX raid groups PER GUILD.
//
// Structure (fixed; only `partySize` is configurable, via global Settings):
//   2 "main"   raids x 5 parties  -> the top-power cohort
//   4 "normal" raids x 8 parties  -> everyone else, split evenly
// A raid's people cap is (parties x partySize): 25 for a main raid, 40 for a
// normal raid at the default partySize of 5. The two main raids deliberately
// run 5 parties rather than 8 because the top-50 cohort must SPLIT across two
// raids — 50 people exceeds a single raid's 40-person cap.
// ============================================================================

export type PolarityKind = "main" | "normal";

export const POLARITY_KINDS: PolarityKind[] = ["main", "normal"];

// How many raids of each kind, per guild.
export const POLARITY_RAID_COUNT: Record<PolarityKind, number> = {
  main: 2,
  normal: 4,
};

// How many parties each raid of that kind holds.
export const POLARITY_PARTY_COUNT: Record<PolarityKind, number> = {
  main: 5,
  normal: 8,
};

// Total raid groups per guild — SIX.
export const POLARITY_TOTAL_RAIDS =
  POLARITY_RAID_COUNT.main + POLARITY_RAID_COUNT.normal;

export const POLARITY_KIND_LABEL: Record<PolarityKind, string> = {
  main: "Main Raid",
  normal: "Raid",
};

// Cards per row in the party grid (mirrors CARDS_PER_ROW on the GvG board, but
// a main raid is exactly 5 parties wide so a 5-column grid lays out cleanly).
export const POLARITY_CARDS_PER_ROW = 5;

// ---- Documents ------------------------------------------------------------
// NOTE ON FIELD NAMES: a polarity party's primary key is called `partyId` (and
// a raid's `raidId`) even though it lives in its own collection. That is
// deliberate — it makes `PolarityParty` structurally compatible with the shared
// `PlanSource` (generate.ts) and with `PartyCard`, so the generator and the UI
// are genuinely reused rather than duplicated. The id VALUES are namespaced
// (`daddy-polarity-main-0-p3`) so they can never be confused with a GvG party
// id (`daddy-main-3`), and the collections are separate regardless.

export interface PolarityRaid {
  raidId: string; // deterministic: `${guild}-polarity-${kind}-${index}`
  type: Guild;
  kind: PolarityKind;
  index: number; // index within its kind (main: 0-1, normal: 0-3)
  name: string;
  position: number; // global order 0..5 (main raids first)
  // The raid leader: a userId that MUST be a member of one of this raid's
  // parties. null = no leader. The bot crowns this member in /polarityraid.
  leaderId: string | null;
  updatedAt: string; // ISO
}

export interface PolarityParty {
  partyId: string; // deterministic: `${raidId}-p${position}`
  type: Guild;
  raidId: string;
  kind: PolarityKind;
  name: string;
  memberIds: string[]; // assigned userIds, max settings.partySize
  position: number; // 0-based index within its raid
  lockedSlots: number[]; // slot indexes that are locked
  updatedAt: string; // ISO
}

// ---- Deterministic ids ----------------------------------------------------

export function polarityRaidId(
  guild: Guild,
  kind: PolarityKind,
  index: number,
): string {
  return `${guild}-polarity-${kind}-${index}`;
}

export function polarityPartyId(raidId: string, position: number): string {
  return `${raidId}-p${position}`;
}

// Default display names. Main raids read "Polarity Main 1/2", normal raids
// "Polarity Raid 1..4". Parties are "Party 1..n" within their raid.
export function polarityRaidName(kind: PolarityKind, index: number): string {
  return kind === "main"
    ? `Polarity Main ${index + 1}`
    : `Polarity Raid ${index + 1}`;
}

export function polarityPartyName(position: number): string {
  return `Party ${position + 1}`;
}

// ---- Structure ------------------------------------------------------------

export interface PolarityRaidSpec {
  kind: PolarityKind;
  index: number;
  position: number;
  raidId: string;
  partyCount: number;
}

// The canonical 6-raid skeleton for one guild, in display order: the 2 main
// raids first, then the 4 normal raids.
export function polarityStructure(guild: Guild): PolarityRaidSpec[] {
  const out: PolarityRaidSpec[] = [];
  let position = 0;
  for (const kind of POLARITY_KINDS) {
    for (let index = 0; index < POLARITY_RAID_COUNT[kind]; index++) {
      out.push({
        kind,
        index,
        position: position++,
        raidId: polarityRaidId(guild, kind, index),
        partyCount: POLARITY_PARTY_COUNT[kind],
      });
    }
  }
  return out;
}

// People cap for one raid of this kind = parties x partySize.
export function polarityRaidCapacity(
  kind: PolarityKind,
  partySize: number,
): number {
  return POLARITY_PARTY_COUNT[kind] * partySize;
}

// The size of the top-power cohort = everything the two main raids can hold.
// 2 x 5 x 5 = 50 at the default partySize.
export function polarityMainCohortSize(partySize: number): number {
  return POLARITY_RAID_COUNT.main * polarityRaidCapacity("main", partySize);
}

// Total people one guild's polarity layout can hold.
// (2 x 5 + 4 x 8) x partySize = 42 x partySize = 210 at the default.
export function polarityTotalCapacity(partySize: number): number {
  return (
    POLARITY_RAID_COUNT.main * polarityRaidCapacity("main", partySize) +
    POLARITY_RAID_COUNT.normal * polarityRaidCapacity("normal", partySize)
  );
}

// ---- Even split -----------------------------------------------------------

// Distribute `total` items across bins with the given `capacities` as EVENLY as
// possible, never exceeding a bin's capacity. Surplus that no bin can take is
// simply not distributed (the caller leaves those members unassigned rather
// than dropping them silently). Fully deterministic: when a remainder can't be
// divided evenly, the earliest bins get the extra one each, in index order.
//
//   evenQuotas(160, [40,40,40,40]) -> [40,40,40,40]
//   evenQuotas(10,  [40,40,40,40]) -> [3,3,2,2]
//   evenQuotas(200, [40,40,40,40]) -> [40,40,40,40]  (40 left over → unassigned)
export function evenQuotas(total: number, capacities: number[]): number[] {
  const out = capacities.map(() => 0);
  let remaining = Math.max(0, Math.min(total, sum(capacities)));

  while (remaining > 0) {
    const open: number[] = [];
    for (let i = 0; i < capacities.length; i++) {
      if (out[i] < capacities[i]) open.push(i);
    }
    if (open.length === 0) break;

    const base = Math.floor(remaining / open.length);
    if (base === 0) {
      // Fewer items left than open bins — hand out one each, lowest index first.
      for (const i of open) {
        if (remaining === 0) break;
        out[i] += 1;
        remaining -= 1;
      }
      break;
    }
    let progressed = false;
    for (const i of open) {
      const add = Math.min(base, capacities[i] - out[i]);
      if (add > 0) {
        out[i] += add;
        remaining -= add;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// The per-cohort quota function handed to generateCohorts for Polarity.
// `capacities` arrives in structural order: [main0, main1, normal0..normal3].
//   - The MAIN raids absorb the top-ranked members up to their combined free
//     capacity, split evenly between the two (so the top 25 land in Main 1 and
//     ranks 26-50 in Main 2 on a full roster).
//   - The remainder is split EVENLY across the 4 normal raids.
//   - Anything left over after every raid is at capacity stays unassigned.
export function polarityQuotas(
  capacities: number[],
  remaining: number,
): number[] {
  const mainCaps = capacities.slice(0, POLARITY_RAID_COUNT.main);
  const normalCaps = capacities.slice(POLARITY_RAID_COUNT.main);
  const mainTake = Math.min(remaining, sum(mainCaps));
  const mainQuotas = evenQuotas(mainTake, mainCaps);
  const normalQuotas = evenQuotas(remaining - sum(mainQuotas), normalCaps);
  return [...mainQuotas, ...normalQuotas];
}
