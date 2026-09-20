import type { PartyPlan } from "./generate";
import type { Member } from "./types";

// ============================================================================
// POLARITY RAIDS — the priest guarantee, and the DPS-ranked main-raid fill.
//
// ONE PRIEST IN EVERY PARTY, ALL SIX RAIDS (added 2026-09-20). Conrad: "each
// party must have 1 priest. its not working that way right now". It was not
// working because the rule was being read from `settings.requiredClasses`,
// which is stored as an EMPTY ARRAY in production — generateCohorts therefore
// ran its required-class pass over nothing at all. The rule is now HARDWIRED
// here, in the polarity generator, and reads no setting:
//   - `settings.requiredClasses` is deliberately NOT changed. It also drives
//     the GvG builder, and Conrad's instruction is to leave GvG alone.
//   - `generate.ts` is likewise untouched (see the note below).
// Main raids seed their priest from a DPS ranking, normal raids from a power
// ranking; the seeding pass itself is shared (seedOnePriestPerParty) so the
// two can never drift apart on the "every party gets its first priest before
// any party gets a second" invariant.
//
// The two MAIN raids no longer rank on `power`. They rank on the DPS figure
// imported from the game's ranking board (see ranking-import.ts), which is
// stored separately from `memberMeta.power` precisely so that power keeps
// driving the leaderboard, the GvG builder and Siege unchanged.
//
// WHY THIS IS NOT generateCohorts: the shared engine (generate.ts) fills a
// cohort with a required-class pass, a ~1-tank spread and a balance fill. The
// main raids now want something the engine cannot express — EXACTLY ONE priest
// per party ahead of everything else — and they want no tank pass at all. The
// four NORMAL
// raids are untouched and still go through generateCohorts with `power`, so
// generate.ts is deliberately left byte-for-byte as it was: that is what lets
// scripts/verify-polarity-dps.ts run the OLD generator and the NEW one side by
// side and prove the normal raids are identical rather than assert it.
//
// THE RULES, in order:
//   1. ELIGIBILITY — a member with no imported DPS row CANNOT enter a main
//      raid. There is no fallback to power here; they drop through to the
//      normal-raid pool, and the count is reported so the UI can say so.
//   2. PRIESTS FIRST, held out in their own DPS-ranked pool. Exactly one priest
//      is seeded into each of the 10 main parties, highest DPS first. A party
//      that already holds a priest in a LOCKED slot keeps it and is skipped. A
//      party that cannot get one is flagged missing. Priests left over after
//      the 10 seats are filled are NOT placed by this pass — every party on the
//      WHOLE board, normal raids included, must get its first priest before any
//      party gets a second — so they fall to the normal pool.
//   3. THE REST is filled from the non-priest DPS ranking: the ranked list is
//      split across the two raids by remaining capacity (raid 1 first, so the
//      top of the ranking lands in Main 1 exactly as the old power split did),
//      and within a raid each next-strongest member goes to the party with the
//      lowest DPS total, tie-broken by partyId.
//   4. ONLY IF SEATS ARE STILL EMPTY, a leftover priest may take one
//      (seatSparePriests, run LAST by the caller over the whole board). Conrad
//      reversed the old "never two priests" rule on 2026-09-20 once he saw it
//      left daddy 5 and mummy 7 priests unassigned against exactly that many
//      empty seats. In practice this never bites the main raids — 50 seats
//      against ~147 members means they never run out of non-priests — but it
//      is applied to both halves rather than special-cased.
//
// "IS A PRIEST" is decided by the IMPORTED Class column when the member has an
// imported row, falling back to their stored className. The imported table is
// the more recent statement of what the member actually played.
//
// DETERMINISM: every ordering is total — DPS descending then userId ascending
// for members, party DPS total then partyId for parties — so re-running
// Generate on unchanged data reproduces the same board exactly. Nothing here
// shuffles.
//
// PURE — no Mongo, no Next, no "server-only".
// ============================================================================

/** The imported ranking figures the generator needs for one member. */
export interface DpsRow {
  dps: number;
  /** The Class column as it appeared in the import. */
  className: string | null;
}

export interface MainFillResult {
  /** userIds this pass placed into a main party. */
  placed: Set<string>;
  /** partyId → required classNames the party is still missing. */
  missing: Map<string, string[]>;
  /** Priests actually seeded by this pass (locked ones are not counted). */
  seededPriests: number;
  /** Main parties left without a priest, in board order. */
  partiesMissingPriest: string[];
  /** Pool members carrying an imported DPS row (i.e. eligible for a main raid). */
  eligible: number;
  /** Pool members with NO imported DPS row — barred from the main raids. */
  noDps: number;
  /** Eligible members the main raids had no room for. */
  overflow: number;
}

// --- slot helpers -----------------------------------------------------------
// Deliberately local rather than shared with generate.ts: keeping that module
// untouched is what makes the before/after proof of the normal raids honest.

function freeSlots(plan: PartyPlan): number[] {
  const out: number[] = [];
  for (let i = 0; i < plan.slots.length; i++) {
    if (!plan.locked.has(i) && plan.slots[i] === null) out.push(i);
  }
  return out;
}

function occupants(plan: PartyPlan): string[] {
  return plan.slots.filter((s): s is string => s !== null);
}

// --- the shared priest guarantee -------------------------------------------
// ONE PRIEST IN EVERY PARTY, FIRST. Used by BOTH halves of the board so the
// invariant is stated once:
//   - a party that already holds a priest (only possible via a LOCKED slot) is
//     left alone — it is satisfied, and it must not be given a second here;
//   - a party with no free slot (full of locked non-priests) is FLAGGED;
//   - a party reached after the priest pool has run dry is FLAGGED;
//   - otherwise the next priest off the ranked pool is seated.
//
// THIS PASS NEVER SEATS A SECOND PRIEST. That is the whole point of keeping it
// separate: the relaxation added on 2026-09-20 (a surplus priest may take an
// EMPTY seat once the non-priests are exhausted — see seatSparePriests below)
// lives in its own pass that runs LAST, so it cannot erode the guarantee that
// every party gets its first priest before any party gets a second. Do not let
// the spare-seat rule leak in here.
interface PriestSeedResult {
  /** userIds this pass seated. */
  seeded: string[];
  /** Parties left without a priest, in board order. */
  partiesMissingPriest: string[];
  /** partyId → [healerClass], the existing `partiesMissing` mechanism. */
  missing: Map<string, string[]>;
  /** How many of `priests` were consumed. */
  consumed: number;
}

function seedOnePriestPerParty(
  /** Every party to guarantee, in board order. */
  plans: PartyPlan[],
  /** The priest pool, ALREADY ranked — highest first, total ordering. */
  priests: Member[],
  isPriest: (uid: string) => boolean,
  healerClass: string,
  /** Seats a member in the plan's first free slot; false when it could not. */
  put: (plan: PartyPlan, uid: string) => boolean,
): PriestSeedResult {
  const seeded: string[] = [];
  const partiesMissingPriest: string[] = [];
  const missing = new Map<string, string[]>();

  const flag = (plan: PartyPlan) => {
    partiesMissingPriest.push(plan.partyId);
    const list = missing.get(plan.partyId);
    if (list) {
      if (!list.includes(healerClass)) list.push(healerClass);
    } else {
      missing.set(plan.partyId, [healerClass]);
    }
  };

  let index = 0;
  for (const plan of plans) {
    if (occupants(plan).some((uid) => isPriest(uid))) continue; // locked priest
    if (freeSlots(plan).length === 0) {
      flag(plan); // full of locked non-priests
      continue;
    }
    if (index >= priests.length) {
      flag(plan); // fewer priests than parties
      continue;
    }
    const uid = priests[index++].userId;
    if (put(plan, uid)) seeded.push(uid);
    else flag(plan);
  }

  return { seeded, partiesMissingPriest, missing, consumed: index };
}

export function fillMainRaidsByDps(
  /** One entry per main raid, each an ordered list of that raid's party plans. */
  mainCohorts: PartyPlan[][],
  /** Available members — already excludes anyone pinned in a locked slot. */
  pool: Member[],
  /** The member's imported ranking row, or null when they have none. */
  dpsOf: (userId: string) => DpsRow | null,
  /** The member's STORED className (the fallback when there is no import). */
  storedClassOf: (userId: string) => string | null,
  /** The className that counts as a priest ("Priest"). */
  healerClass: string,
): MainFillResult {
  const mainPlans = mainCohorts.flat();

  // The import's Class column wins; the stored className is the fallback.
  const effectiveClass = (uid: string): string | null =>
    dpsOf(uid)?.className ?? storedClassOf(uid);
  const isPriest = (uid: string) => effectiveClass(uid) === healerClass;
  const dpsValue = (uid: string) => dpsOf(uid)?.dps ?? 0;

  // ---- 1. eligibility ----------------------------------------------------
  const eligible = pool.filter((m) => dpsOf(m.userId) !== null);
  const ranked = eligible
    .slice()
    .sort(
      (a, b) =>
        dpsValue(b.userId) - dpsValue(a.userId) ||
        a.userId.localeCompare(b.userId),
    );
  const priests = ranked.filter((m) => isPriest(m.userId));
  const others = ranked.filter((m) => !isPriest(m.userId));

  const placed = new Set<string>();

  // Running DPS total per party, seeded from whoever is already locked in.
  const dpsTotal = new Map<string, number>();
  for (const plan of mainPlans) {
    let sum = 0;
    for (const uid of occupants(plan)) sum += dpsValue(uid);
    dpsTotal.set(plan.partyId, sum);
  }

  const put = (plan: PartyPlan, uid: string) => {
    const free = freeSlots(plan);
    if (free.length === 0) return false;
    plan.slots[free[0]] = uid;
    // classCounts tracks the STORED className, exactly as buildPlans seeded it,
    // so the two never disagree about what is in the map.
    const cls = storedClassOf(uid);
    if (cls) plan.classCounts.set(cls, (plan.classCounts.get(cls) ?? 0) + 1);
    dpsTotal.set(plan.partyId, (dpsTotal.get(plan.partyId) ?? 0) + dpsValue(uid));
    placed.add(uid);
    return true;
  };

  // ---- 2. one priest per main party --------------------------------------
  // The shared guarantee — identical pass to the one the normal raids run,
  // differing only in how the priest pool was ranked (DPS here, power there).
  const seed = seedOnePriestPerParty(
    mainPlans,
    priests,
    isPriest,
    healerClass,
    put,
  );
  const missing = seed.missing;
  const partiesMissingPriest = seed.partiesMissingPriest;
  const seededPriests = seed.seeded.length;

  // ---- 3. fill the rest from the non-priest DPS ranking -------------------
  // The ranked remainder is split across the raids by remaining capacity, raid
  // 1 first, so the top of the ranking lands in Main 1.
  let offset = 0;
  for (const cohort of mainCohorts) {
    const capacity = cohort.reduce((s, p) => s + freeSlots(p).length, 0);
    const slice = others.slice(offset, offset + capacity);
    offset += slice.length;

    for (const m of slice) {
      // Lowest DPS total with a free slot; partyId breaks the tie.
      let target: PartyPlan | null = null;
      for (const plan of cohort) {
        if (freeSlots(plan).length === 0) continue;
        if (target === null) {
          target = plan;
          continue;
        }
        const a = dpsTotal.get(plan.partyId) ?? 0;
        const b = dpsTotal.get(target.partyId) ?? 0;
        if (a < b || (a === b && plan.partyId.localeCompare(target.partyId) < 0)) {
          target = plan;
        }
      }
      if (!target) break;
      put(target, m.userId);
    }
  }

  return {
    placed,
    missing,
    seededPriests,
    partiesMissingPriest,
    eligible: eligible.length,
    noDps: pool.length - eligible.length,
    // Priests beyond the 10 seats and any ranked member the raids had no room
    // for. They are not dropped — they drop through to the normal-raid pool.
    overflow: eligible.length - placed.size,
  };
}

// ============================================================================
// NORMAL RAIDS — the priest guarantee only.
//
// The four normal raids still rank on `power` through the untouched shared
// engine (generate.ts). All this pass does is run FIRST and seat exactly one
// priest in each normal party, so that by the time generateCohorts sees the
// cohorts their free capacity is already one short per party and its balance
// fill can only top up the remaining four seats.
//
// WHY A SEPARATE PASS rather than settings.requiredClasses: that setting is
// `[]` in production and it is shared with the GvG builder, which Conrad wants
// left alone. Hardwiring the rule here is the only way to guarantee it for
// Polarity without changing behaviour anywhere else.
//
// THE CALLER MUST THEN EXCLUDE EVERY PRIEST from the pool it hands to
// generateCohorts — not just the ones seated here. A priest the pass could not
// seat is a SURPLUS priest, and letting the engine place one would put a second
// priest in a party while another party might still be waiting for its first.
// The surplus comes back as `leftover` (and `priestsLeftOver`) and is offered
// to seatSparePriests AFTERWARDS, once the non-priests have had their turn.
//
// Ordering: power DESC, ties by userId — the same total ordering the engine
// itself uses, so the whole run stays deterministic.
// ============================================================================

export interface NormalPriestResult {
  /** userIds this pass seated into a normal party. */
  placed: Set<string>;
  /** partyId → required classNames still missing (the `partiesMissing` map). */
  missing: Map<string, string[]>;
  /** Priests actually seeded (locked ones are not counted). */
  seededPriests: number;
  /** Normal parties left without a priest, in board order. */
  partiesMissingPriest: string[];
  /** How many priests this pass could not seat (every party already had one). */
  priestsLeftOver: number;
  /**
   * Those same surplus priests, IN RANK ORDER (power desc, userId asc). They
   * are NOT on the board yet. The caller runs the non-priest fill first and
   * then offers this list to seatSparePriests, which seats as many as there
   * are empty seats left. Whatever is still here after that stays unassigned.
   */
  leftover: Member[];
}

export function fillNormalRaidPriests(
  /** One entry per normal raid, each an ordered list of that raid's plans. */
  normalCohorts: PartyPlan[][],
  /** The normal-raid pool — already excludes locked members and main-raid picks. */
  pool: Member[],
  /** "Is this member a priest", by the SAME effective-class rule the main pass uses. */
  isPriest: (userId: string) => boolean,
  /** Power, the figure the normal raids rank on. */
  powerOf: (userId: string) => number,
  /** The member's STORED className — what classCounts is keyed on. */
  storedClassOf: (userId: string) => string | null,
  /** The className that counts as a priest ("Priest"). */
  healerClass: string,
): NormalPriestResult {
  const normalPlans = normalCohorts.flat();

  const priests = pool
    .filter((m) => isPriest(m.userId))
    .sort(
      (a, b) =>
        powerOf(b.userId) - powerOf(a.userId) ||
        a.userId.localeCompare(b.userId),
    );

  const placed = new Set<string>();
  // classCounts tracks the STORED className, exactly as buildPlans seeded it
  // and exactly as generateCohorts will keep doing after us, so the two never
  // disagree about what is in the map.
  const put = (plan: PartyPlan, uid: string) => {
    const free = freeSlots(plan);
    if (free.length === 0) return false;
    plan.slots[free[0]] = uid;
    const cls = storedClassOf(uid);
    if (cls) plan.classCounts.set(cls, (plan.classCounts.get(cls) ?? 0) + 1);
    placed.add(uid);
    return true;
  };

  const seed = seedOnePriestPerParty(
    normalPlans,
    priests,
    isPriest,
    healerClass,
    put,
  );

  return {
    placed,
    missing: seed.missing,
    seededPriests: seed.seeded.length,
    partiesMissingPriest: seed.partiesMissingPriest,
    priestsLeftOver: priests.length - seed.consumed,
    // `consumed` is an index into the ranked pool, so the tail is exactly the
    // priests this pass did not seat, still in rank order.
    leftover: priests.slice(seed.consumed),
  };
}

// ============================================================================
// SPARE SEATS — a surplus priest may take an EMPTY seat, and only an empty one.
//
// Added 2026-09-20. Conrad reversed the original "a party is never given a
// second priest" rule once he saw what it cost: at live supply it left daddy 5
// and mummy 7 priests sitting unassigned while exactly that many seats sat
// empty on the board. An empty seat helps nobody.
//
// THE ORDER IS THE RULE, and this pass is deliberately LAST:
//   1. every party gets its first priest      (seedOnePriestPerParty)
//   2. the remaining seats fill from the non-priest ranking
//      (fillMainRaidsByDps step 3 for the mains, generateCohorts for the
//      normal raids)
//   3. ONLY THEN — this pass — leftover priests take whatever seats are still
//      empty.
// Because step 1 has already run over EVERY party on the board by the time we
// get here, no party can receive a second priest while another still lacks a
// first. The two ways a party ends step 1 without a priest are "the pool ran
// dry" (in which case there is no leftover to seat) and "it had no free slot"
// (in which case it cannot receive anyone here either). The guarantee therefore
// holds structurally, not by luck — scripts/verify-polarity-dps.ts proves it at
// several supply levels including deliberately short supply.
//
// WHICH PARTY GETS THE NEXT SPARE PRIEST. The existing lowest-open-party
// balance rule, with ONE addition: parties holding FEWER priests are preferred
// before the balance total is consulted at all.
//
//   That addition is not decoration. The balance rule ranks a party by the sum
//   of its members' weights, and a priest's weight is almost always ZERO here —
//   `memberMeta.power` is 0 for most of the live roster. Seating a zero-weight
//   member does not move the total, so a pure balance comparison would hand the
//   SAME party every spare seat it owns until it was full: three surplus
//   priests would stack into one party instead of spreading over three. Ranking
//   by priest count first makes "spread rather than stack" hold whatever the
//   power data looks like, and it changes nothing when the totals already
//   differ, because it only ever separates parties that are otherwise tied on
//   the thing we are balancing.
//
// Ties after that: the balance total, then partyId — the same total ordering
// every other pass uses, so re-running Generate reproduces the board exactly.
//
// ONE POOL PER HALF, NOT ONE PER RAID. The earlier passes slice their ranked
// list across the cohorts by capacity so the strongest lands in the earliest
// raid. This pass deliberately does NOT: it competes every open party in the
// half against every other. Slicing per raid would send two leftovers to the
// same raid's one open party while an open party in the next raid took none,
// which is the stacking Conrad asked us to avoid. Spread beats raid seniority
// for what is, by definition, the dregs of the pool.
//
// WHAT THIS PASS CANNOT FIX: it can only use seats the earlier passes left
// empty. If the non-priest fill piled its empty seats into one party — which it
// does when `power` is 0 across the roster, since a zero-weight member never
// moves a party's balance total — then that is where the spare priests have to
// go. Spreading further would mean moving non-priests, which is a different
// change to a different pass.
// ============================================================================

export interface SparePriestResult {
  /** userIds this pass seated. */
  placed: Set<string>;
  /** Those userIds in placement order — the spread is visible in this list. */
  seated: string[];
}

export function seatSparePriests(
  /** Every party in this half of the board, in board order. */
  allPlans: PartyPlan[],
  /** Surplus priests, ALREADY ranked — highest first, total ordering. */
  priests: Member[],
  /** "Is this member a priest" — used to count what each party already holds. */
  isPriest: (userId: string) => boolean,
  /** The figure this half of the board balances on (power, or DPS). */
  weightOf: (userId: string) => number,
  /** The member's STORED className — what classCounts is keyed on. */
  storedClassOf: (userId: string) => string | null,
): SparePriestResult {
  const placed = new Set<string>();
  const seated: string[] = [];
  if (priests.length === 0) return { placed, seated };

  // Running totals, seeded from whoever is already on the board — locked
  // members and everything the earlier passes seated.
  const total = new Map<string, number>();
  const priestCount = new Map<string, number>();
  for (const plan of allPlans) {
    let sum = 0;
    let n = 0;
    for (const uid of occupants(plan)) {
      sum += weightOf(uid);
      if (isPriest(uid)) n += 1;
    }
    total.set(plan.partyId, sum);
    priestCount.set(plan.partyId, n);
  }

  const put = (plan: PartyPlan, uid: string) => {
    const free = freeSlots(plan);
    if (free.length === 0) return false;
    plan.slots[free[0]] = uid;
    const cls = storedClassOf(uid);
    if (cls) plan.classCounts.set(cls, (plan.classCounts.get(cls) ?? 0) + 1);
    total.set(plan.partyId, (total.get(plan.partyId) ?? 0) + weightOf(uid));
    priestCount.set(plan.partyId, (priestCount.get(plan.partyId) ?? 0) + 1);
    placed.add(uid);
    seated.push(uid);
    return true;
  };

  // Fewest priests, then lowest balance total, then partyId.
  const nextTarget = (): PartyPlan | null => {
    let best: PartyPlan | null = null;
    for (const plan of allPlans) {
      if (freeSlots(plan).length === 0) continue;
      if (best === null) {
        best = plan;
        continue;
      }
      const pn = priestCount.get(plan.partyId) ?? 0;
      const bn = priestCount.get(best.partyId) ?? 0;
      if (pn !== bn) {
        if (pn < bn) best = plan;
        continue;
      }
      const pt = total.get(plan.partyId) ?? 0;
      const bt = total.get(best.partyId) ?? 0;
      if (pt !== bt) {
        if (pt < bt) best = plan;
        continue;
      }
      if (plan.partyId.localeCompare(best.partyId) < 0) best = plan;
    }
    return best;
  };

  for (const m of priests) {
    const target = nextTarget();
    if (!target) break; // no empty seat left anywhere in this half
    put(target, m.userId);
  }

  return { placed, seated };
}
