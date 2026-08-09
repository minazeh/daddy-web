import { roleFor, type Member, type Settings } from "./types";

// ============================================================================
// SHARED roster auto-fill machinery.
//
// This module was EXTRACTED VERBATIM from actions.ts (the GvG builder's
// Generate) so a second feature — Polarity Raids — can reuse the exact same
// composition engine instead of growing a parallel generator. It is PURE: no
// Mongo, no `server-only`, no React. That keeps it unit-testable in isolation
// and importable from both `actions.ts` and `polarity-actions.ts`.
//
// It cannot live in actions.ts because that file carries the `"use server"`
// directive — every export of a `"use server"` module must be an async
// function, so a synchronous helper like `buildPlans` can't be exported there.
//
// The engine is COHORT-based. A cohort is an ordered group of party plans that
// competes for one slice of the power-ranked member pool:
//   - GvG (`generateGuild`)      -> 2 cohorts: Main field, Sub field.
//   - Polarity (`generatePolarity`) -> 6 cohorts: 2 main raids + 4 normal raids.
// ============================================================================

// In-place Fisher–Yates shuffle (server-side randomness only).
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The slot layout for a party during generation: a fixed-length (partySize)
// array where LOCKED indexes keep their existing member (or stay empty), and
// UNLOCKED indexes are the ones we (re)fill.
export interface PartyPlan {
  partyId: string;
  slots: (string | null)[]; // length partySize; userId or null
  locked: Set<number>;
  // Count of RETAINED (locked) members of each className, so we know which
  // required-class minimums are still unmet after locks.
  classCounts: Map<string, number>;
}

// The minimal shape `buildPlans` needs from a stored party. Both `Party` (GvG)
// and `PolarityParty` satisfy it structurally.
export interface PlanSource {
  partyId: string;
  memberIds: string[];
  lockedSlots: number[];
}

// Compact a plan's slot array to a dense memberIds array (nulls dropped).
// Callers re-key `lockedSlots` to the compacted indexes so a pinned member
// keeps its lock even though its index shifts.
export function slotsToMemberIds(slots: (string | null)[]): string[] {
  return slots.filter((s): s is string => s !== null);
}

// Build the per-party plan from current parties: which slots are locked, which
// (locked) members are pinned, and a count of retained members per className
// (so we know which required-class minimums are already met by locked members).
export function buildPlans(
  parties: PlanSource[],
  memberById: Map<string, Pick<Member, "className">>,
  partySize: number,
): PartyPlan[] {
  return parties.map((p) => {
    const locked = new Set(p.lockedSlots);
    const slots: (string | null)[] = Array.from(
      { length: partySize },
      (_, i) => p.memberIds[i] ?? null,
    );
    // Unlocked slots start empty (their members return to the pool). Slots
    // beyond partySize are already excluded by the Array length above.
    for (let i = 0; i < partySize; i++) {
      if (!locked.has(i)) slots[i] = null;
    }
    const classCounts = new Map<string, number>();
    for (const uid of slots) {
      if (!uid) continue;
      const cls = memberById.get(uid)?.className ?? null;
      if (cls) classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    }
    return { partyId: p.partyId, slots, locked, classCounts };
  });
}

// How ties (equal power) are ordered.
//   "random" — legacy GvG behavior: equal-power members shuffle each run.
//   "userId" — DETERMINISTIC: equal-power members order by userId ascending, so
//              re-running Generate on unchanged data reproduces the same board.
//              Required by Polarity Raids (power is 0 for most of the roster,
//              so nearly every comparison is a tie).
export type TieBreak = "random" | "userId";

export interface GenerateOptions {
  tieBreak?: TieBreak;
  // FALSE (GvG, legacy): run the required-class pass across ALL cohorts first
  //   (cohort order = priority), THEN split what's left by power rank.
  //   Consequence: the hard rule can pull a low-power required-class member
  //   into an early cohort.
  // TRUE (Polarity): split the pool by power rank FIRST (so cohort membership
  //   is strictly rank-determined — "the top N go into the main raids"), THEN
  //   satisfy the required classes from within each cohort. A cohort that has
  //   too few of a required class flags those parties as missing rather than
  //   stealing a member from a lower cohort.
  partitionFirst?: boolean;
  // Given each cohort's remaining free-slot capacity (in cohort order) and the
  // number of members still to place, return how many of the ranked remainder
  // each cohort absorbs. Default = "every cohort takes its capacity, the LAST
  // one takes everything that is left" (the legacy GvG Main/Sub split).
  quotas?: (capacities: number[], remaining: number) => number[];
}

const DEFAULT_QUOTAS = (capacities: number[]): number[] =>
  capacities.map((c, i) => (i === capacities.length - 1 ? Infinity : c));

// Core generation — POWER-AWARE, COHORT-TIERED, SETTINGS-DRIVEN. Mutates the
// plans' slots. Returns a map partyId → missing required classNames
// (empty/absent = party meets all requirements).
//
// Rules (after locks; locked members count toward their party from the start):
//   1. REQUIREMENTS hard rule, power DESC, earlier cohorts first: for each
//      required class (className, min), parties still short get members of that
//      class. Locked members of that class already count. Parties that can't be
//      satisfied are flagged with the class(es) still missing.
//   2. TIER PARTITION: rank the available members by power DESC and slice them
//      across the cohorts using `quotas`.
//   3. PER-COHORT BALANCE: within each cohort, a ~1-tank pass (using settings
//      classRoles) then a largest-into-smallest-bin balance fill from that
//      cohort's slice. Cohorts are never balanced against each other.
// Steps 1 and 2 swap order when `partitionFirst` is set (see GenerateOptions).
export function generateCohorts(
  cohorts: PartyPlan[][],
  pool: Member[],
  powerOf: (uid: string) => number,
  classOf: (uid: string) => string | null,
  settings: Settings,
  options: GenerateOptions = {},
): Map<string, string[]> {
  const { requiredClasses, classRoles } = settings;
  const tieBreak = options.tieBreak ?? "random";
  const partitionFirst = options.partitionFirst ?? false;
  const quotaFn = options.quotas ?? DEFAULT_QUOTAS;

  const allPlans = cohorts.flat();

  // Power DESC. Ties either shuffle (legacy) or order by userId (deterministic).
  const byPowerDesc = (list: Member[]) =>
    tieBreak === "userId"
      ? list
          .slice()
          .sort(
            (a, b) =>
              powerOf(b.userId) - powerOf(a.userId) ||
              a.userId.localeCompare(b.userId),
          )
      : shuffle(list.slice()).sort(
          (a, b) => powerOf(b.userId) - powerOf(a.userId),
        );

  const used = new Set<string>();
  const freeSlots = (plan: PartyPlan): number[] => {
    const out: number[] = [];
    for (let i = 0; i < plan.slots.length; i++) {
      if (!plan.locked.has(i) && plan.slots[i] === null) out.push(i);
    }
    return out;
  };
  const capacityOf = (subset: PartyPlan[]) =>
    subset.reduce((s, p) => s + freeSlots(p).length, 0);
  const place = (plan: PartyPlan, uid: string) => {
    const free = freeSlots(plan);
    if (free.length === 0) return false;
    plan.slots[free[0]] = uid;
    const cls = classOf(uid);
    if (cls) plan.classCounts.set(cls, (plan.classCounts.get(cls) ?? 0) + 1);
    return true;
  };

  const power = new Map<string, number>();
  for (const plan of allPlans) {
    let sum = 0;
    for (const uid of plan.slots) if (uid) sum += powerOf(uid);
    power.set(plan.partyId, sum);
  }
  const addPower = (plan: PartyPlan, uid: string) =>
    power.set(plan.partyId, (power.get(plan.partyId) ?? 0) + powerOf(uid));

  const lowestOpenIn = (
    subset: PartyPlan[],
    pred?: (p: PartyPlan) => boolean,
  ): PartyPlan | null => {
    let best: PartyPlan | null = null;
    for (const plan of subset) {
      if (freeSlots(plan).length === 0) continue;
      if (pred && !pred(plan)) continue;
      const pp = power.get(plan.partyId) ?? 0;
      const bp = best ? (power.get(best.partyId) ?? 0) : 0;
      if (
        best === null ||
        pp < bp ||
        (pp === bp && plan.partyId.localeCompare(best.partyId) < 0)
      ) {
        best = plan;
      }
    }
    return best;
  };
  const takeNext = (list: Member[]): Member | null => {
    while (list.length) {
      const m = list.shift()!;
      if (!used.has(m.userId)) {
        used.add(m.userId);
        return m;
      }
    }
    return null;
  };

  // ---- REQUIRED CLASSES: top up every party still short of a minimum. ----
  const needsClass = (plan: PartyPlan, cls: string, min: number) =>
    (plan.classCounts.get(cls) ?? 0) < min && freeSlots(plan).length > 0;
  const assignTo = (
    subset: PartyPlan[],
    classPool: Member[],
    className: string,
    min: number,
  ) => {
    // Keep going until no short party can be filled or the class pool dries.
    let guard = subset.length * min + 1;
    while (guard-- > 0) {
      const target = lowestOpenIn(subset, (p) => needsClass(p, className, min));
      if (!target) break;
      const m = takeNext(classPool);
      if (!m) break;
      place(target, m.userId);
      addPower(target, m.userId);
    }
  };

  // ---- PER-COHORT FILL: ~1 tank pass, then balance fill. ----
  const fillCohort = (subset: PartyPlan[], cohortPool: Member[]) => {
    const localUsed = new Set<string>();
    const take = (pred: (m: Member) => boolean): Member | null => {
      for (let i = 0; i < cohortPool.length; i++) {
        const m = cohortPool[i];
        if (localUsed.has(m.userId) || used.has(m.userId)) continue;
        if (!pred(m)) continue;
        localUsed.add(m.userId);
        used.add(m.userId);
        return m;
      }
      return null;
    };

    // Tank spread: ~1 tank into each lowest-power open party (within cohort).
    for (let k = 0; k < subset.length; k++) {
      const target = lowestOpenIn(subset);
      if (!target) break;
      const t = take((m) => roleFor(m.className, classRoles) === "tank");
      if (!t) break;
      place(target, t.userId);
      addPower(target, t.userId);
    }

    // Balance fill: strongest remaining → lowest-power open party in this cohort.
    for (const m of cohortPool) {
      if (localUsed.has(m.userId) || used.has(m.userId)) continue;
      const target = lowestOpenIn(subset);
      if (!target) break;
      localUsed.add(m.userId);
      used.add(m.userId);
      place(target, m.userId);
      addPower(target, m.userId);
    }
  };

  // Slice a ranked list into per-cohort pools using the quota function.
  const sliceByQuota = (ranked: Member[]): Member[][] => {
    const caps = cohorts.map(capacityOf);
    const quotas = quotaFn(caps, ranked.length);
    const out: Member[][] = [];
    let offset = 0;
    for (let i = 0; i < cohorts.length; i++) {
      const q = quotas[i];
      const take = q === Infinity ? ranked.length - offset : Math.max(0, q);
      out.push(ranked.slice(offset, offset + take));
      offset += take;
    }
    return out;
  };

  // Snapshot of which parties are still short of a required class RIGHT NOW.
  const snapshotMissing = (): Map<string, string[]> => {
    const missing = new Map<string, string[]>();
    for (const plan of allPlans) {
      const miss = requiredClasses
        .filter((rc) => (plan.classCounts.get(rc.className) ?? 0) < rc.min)
        .map((rc) => rc.className);
      if (miss.length > 0) missing.set(plan.partyId, miss);
    }
    return missing;
  };

  if (partitionFirst) {
    // POLARITY ORDER: rank → split into cohorts → satisfy requirements from
    // within each cohort → balance fill. Cohort membership is decided purely by
    // power rank, so "the top N land in the main raids" holds exactly.
    const cohortPools = sliceByQuota(byPowerDesc(pool));
    for (let i = 0; i < cohorts.length; i++) {
      for (const rc of requiredClasses) {
        const classPool = cohortPools[i].filter(
          (m) => m.className === rc.className && !used.has(m.userId),
        );
        assignTo(cohorts[i], classPool, rc.className, rc.min);
      }
      fillCohort(cohorts[i], cohortPools[i]);
    }
    // Flagged AFTER the full run — for Polarity the required pass and the
    // balance fill both draw from the same cohort slice, so the end state is
    // the only meaningful answer.
    return snapshotMissing();
  } else {
    // LEGACY GvG ORDER: requirements across all cohorts first (earlier cohorts
    // get first pick of each required class), then rank-split what's left.
    for (const rc of requiredClasses) {
      const classPool = byPowerDesc(
        pool.filter((m) => m.className === rc.className && !used.has(m.userId)),
      );
      for (const subset of cohorts) {
        assignTo(subset, classPool, rc.className, rc.min);
      }
    }
    // Flagged HERE, immediately after the required pass — verbatim legacy
    // behavior (the GvG builder recomputes the badge live from party
    // membership anyway, so this value is informational).
    const missing = snapshotMissing();
    const cohortPools = sliceByQuota(
      byPowerDesc(pool.filter((m) => !used.has(m.userId))),
    );
    for (let i = 0; i < cohorts.length; i++) {
      fillCohort(cohorts[i], cohortPools[i]);
    }
    return missing;
  }
}
