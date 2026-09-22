// PROOF HARNESS for the Polarity DPS ranking import and the generator rewire.
//
// MUST BE RUN FROM THE REPO ROOT — sections 13 and 15 read source files and
// shell out to git, both relative to process.cwd().
//
// Sixteen things this demonstrates by running the real code, not by asserting:
//   1. a multi-block paste with repeated headers and ─── rules parses to the
//      right row set;
//   2. K/M/B scaling is exact, 1.40B included;
//   3. a member name containing a space survives parsing;
//   4. dedupe keeps the LATEST Submitted, including the lower-DPS-but-newer
//      case;
//   5. one priest per party holds across all 10 main parties, and no party is
//      given a second while the non-priests can still fill the seats;
//   6. fewer priests than parties flags the short parties;
//   7. two consecutive Generate runs on unchanged data produce identical
//      boards;
//   8. on a ZERO-PRIEST roster — the control that removes the new pre-seed —
//      the 4 normal raids generate IDENTICALLY before and after the change.
//      The OLD generator is run here verbatim (generate.ts and polarity.ts's
//      polarityQuotas were deliberately left untouched so it still can be) and
//      its normal half is compared byte for byte with the new path's;
//   9. every raid, main and normal, is 5 parties — capacity 150 per guild;
//  10. at the LIVE roster supply (daddy 147/35 priests, mummy 150/37) every
//      one of the 30 parties gets a priest, the seats the old rule left EMPTY
//      are now filled, and the surplus priest count drops to zero — spread over
//      that many DIFFERENT parties, never stacked into one;
//  11. no party is given a second priest while another party could still take
//      its first, including when one is locked in;
//  12. short priest supply flags the short parties through the existing
//      partiesMissing mechanism, and those parties are still FILLED;
//  13. the hidden surplus parties (normal positions 5-7, left from the
//      8-party era) are never read and never written, and the members
//      stranded in them come back to the pool;
//  14. determinism at the live shape, whole board, locks included;
//  15. GvG is untouched: generate.ts is byte-identical to HEAD, the shared
//      Settings object is never mutated, and the priest rule still holds with
//      settings.requiredClasses EMPTY — which is how production stores it, and
//      which is why "1 priest per party" was doing nothing before this change;
//  16. THE ORDERED RULE (Conrad, 2026-09-20, reversing "never two priests"):
//      first priests everywhere, THEN the non-priests, and only then may a
//      leftover priest take a seat that would otherwise stay empty. Proved at
//      eleven supply levels, at short supply, across the main/normal boundary,
//      and on a degenerate all-zero-power roster.
//
// Run (compiles to a temp dir outside the repo, then executes):
//   node_modules/.bin/tsc src/lib/types.ts src/lib/name-match.ts \
//     src/lib/ranking-import.ts src/lib/generate.ts src/lib/polarity.ts \
//     src/lib/polarity-generate.ts scripts/verify-polarity-dps.ts \
//     --outDir "$TMP/polarity-dps-verify" --module commonjs --target es2020 \
//     --moduleResolution node --strict --skipLibCheck
//   node "$TMP/polarity-dps-verify/scripts/verify-polarity-dps.js"

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildRankingPreview,
  dedupeRankingRows,
  parseMagnitude,
  parseRankingText,
  type StoredDps,
} from "../src/lib/ranking-import";
import {
  fillMainRaidsByDps,
  fillNormalRaidPriests,
  seatSparePriests,
  type DpsRow,
} from "../src/lib/polarity-generate";
import {
  buildPlans,
  generateCohorts,
  slotsToMemberIds,
  type PartyPlan,
  type PlanSource,
} from "../src/lib/generate";
import {
  POLARITY_PARTY_COUNT,
  POLARITY_RAID_COUNT,
  polarityNormalQuotas,
  polarityPartyIds,
  polarityQuotas,
  polarityStructure,
  polarityTotalCapacity,
  type PolarityKind,
} from "../src/lib/polarity";
import {
  CLASS_ROLE,
  DEFAULT_SETTINGS,
  HEALER_CLASS,
  KNOWN_CLASSES,
  isHealer,
  partyHasPriest,
  roleFor,
  roleForClass,
  type Member,
  type Settings,
} from "../src/lib/types";
import type { RosterMember as MatchRosterMember } from "../src/lib/name-match";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}\n       actual:   ${a}\n       expected: ${e}`);
  }
}
function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

// A fixed clock, so the MM-DD year inference is reproducible.
const NOW = new Date("2026-09-20T12:00:00.000Z");

// ===========================================================================
// 1-4. THE PARSER
// ===========================================================================

console.log("\n1. multi-block paste: repeated headers and rule lines");

const BLOCK_A = [
  "  #     DPS   Total   Dead  Class       Submitted    Member",
  "───────────────────────────────────────────────────────────",
  "  1   11.8M   1.40B   2.0s  Paladin     08-31 14:12  Solar",
  "  2   8.14M    960M   2.0s  Priest      09-08 03:08  Darasaki",
  "  3   7.27M    858M   2.0s  Hunter      09-06 17:23  DuckyO",
].join("\n");

const BLOCK_B = [
  "",
  "  #     DPS   Total   Dead  Class       Submitted    Member",
  "───────────────────────────────────────────────────────────",
  "  8   3.46M    402M   4.0s  Blacksmith  09-15 13:21  MournWrath",
  " 24   2.49M    293M   2.0s  Blacksmith  09-04 00:11  YT-BKP938",
  " 25   2.48M    290M   3.0s  Knight      09-05 20:12  Q",
  "",
].join("\n");

const BLOCK_C = [
  "  #     DPS   Total   Dead  Class       Submitted    Member",
  "───────────────────────────────────────────────────────────",
  " 31   1.90M    210M   0s    Wizard      09-11 08:05  Lady Of War",
  " 40     950K   99.5M  1.5s  Priest      09-12 22:40  Acolyte Jo",
  "not a ranking row at all",
  " 41       -        -  2.0s  Monk        09-13 10:00  Broken",
].join("\n");

const PASTE = [BLOCK_A, BLOCK_B, BLOCK_C].join("\n");

const parsed = parseRankingText(PASTE, NOW);
check(
  "parsed member set (headers + rules + blanks stripped wherever they appear)",
  parsed.rows.map((r) => r.memberName),
  [
    "Solar",
    "Darasaki",
    "DuckyO",
    "MournWrath",
    "YT-BKP938",
    "Q",
    "Lady Of War",
    "Acolyte Jo",
  ],
);
check("header / rule lines dropped", parsed.skipped, 6);
check(
  "malformed rows reported per-row, never fatal",
  parsed.errors.map((e) => e.line),
  [17, 18],
);
ok(
  "a bad row does not fail the paste",
  parsed.rows.length === 8 && parsed.errors.length === 2,
  `rows=${parsed.rows.length} errors=${parsed.errors.length}`,
);

console.log("\n2. K/M/B scaling is EXACT");
check("11.8M", parseMagnitude("11.8M", "DPS").value, 11_800_000);
check("1.40B", parseMagnitude("1.40B", "Total").value, 1_400_000_000);
check("8.14M", parseMagnitude("8.14M", "DPS").value, 8_140_000);
check("960M", parseMagnitude("960M", "Total").value, 960_000_000);
check("950K", parseMagnitude("950K", "DPS").value, 950_000);
check("99.5M", parseMagnitude("99.5M", "Total").value, 99_500_000);
check("2.49M", parseMagnitude("2.49M", "DPS").value, 2_490_000);
check("plain integer", parseMagnitude("48200", "DPS").value, 48_200);
check("thousands separators", parseMagnitude("1,234,567", "DPS").value, 1_234_567);
// The whole reason for the digit-shift rather than a multiply, demonstrated on
// a figure straight out of Conrad's own sample table: `8.14 * 1e6` is
// 8140000.000000001 in IEEE-754. The parser shifts "814" left by 4 instead and
// lands on the integer exactly.
ok(
  "8.14 * 1e6 in IEEE-754 is NOT 8140000 — the parser does not multiply",
  8.14 * 1e6 !== 8_140_000 && parseMagnitude("8.14M", "DPS").value === 8_140_000,
  `8.14 * 1e6 = ${8.14 * 1e6}`,
);
ok(
  "and 1.005K is 1005, not 1004.9999999999999",
  1.005 * 1e3 !== 1005 && parseMagnitude("1.005K", "DPS").value === 1005,
  `1.005 * 1e3 = ${1.005 * 1e3}`,
);
ok(
  "every value the parser returns is a whole number",
  ["11.8M", "1.40B", "8.14M", "7.27M", "2.49M", "950K", "99.5M"].every((v) =>
    Number.isInteger(parseMagnitude(v, "DPS").value),
  ),
);
check("row values carried through", [parsed.rows[0].dps, parsed.rows[0].total], [
  11_800_000,
  1_400_000_000,
]);
check("Dead seconds parsed", parsed.rows.map((r) => r.deadSeconds), [
  2, 2, 2, 4, 2, 3, 0, 1.5,
]);

console.log("\n3. a member name containing a space survives");
const spaced = parsed.rows.find((r) => r.memberName.includes(" "));
check("name kept whole", spaced?.memberName, "Lady Of War");
check("its class is not eaten by the name", spaced?.className, "Wizard");
check("its DPS is still the DPS column", spaced?.dps, 1_900_000);
check("two-word name in the last column", parsed.rows[7].memberName, "Acolyte Jo");
check("a name with punctuation", parsed.rows[4].memberName, "YT-BKP938");
check("a one-character name", parsed.rows[5].memberName, "Q");

console.log("\n4. dedupe keeps the LATEST Submitted (Conrad's rule)");
const DUPES = [
  "  #     DPS   Total   Dead  Class       Submitted    Member",
  "───────────────────────────────────────────────────────────",
  "  1   11.8M   1.40B   2.0s  Paladin     08-31 14:12  Solar",
  "  2   5.00M    600M   2.0s  Priest      09-08 03:08  Darasaki",
  "  #     DPS   Total   Dead  Class       Submitted    Member",
  "───────────────────────────────────────────────────────────",
  // LOWER DPS but NEWER — this one must win.
  "  9   4.00M    480M   3.0s  Priest      09-19 21:00  Darasaki",
  "  3   9.00M   1.10B   2.0s  Paladin     08-20 09:00  Solar",
  // Identical timestamp — higher DPS breaks the tie, deterministically.
  "  4   1.00M    120M   0s    Monk        09-10 10:00  Tiebreak",
  "  5   2.00M    240M   0s    Monk        09-10 10:00  Tiebreak",
].join("\n");
const dupParsed = parseRankingText(DUPES, NOW);
const deduped = dedupeRankingRows(dupParsed.rows);
check("6 rows in, 3 out", [dupParsed.rows.length, deduped.length], [6, 3]);
check(
  "latest Submitted wins even at LOWER dps",
  deduped
    .filter((r) => r.memberName === "Darasaki")
    .map((r) => [r.dps, r.rawSubmitted]),
  [[4_000_000, "09-19 21:00"]],
);
check(
  "latest Submitted wins for the higher-dps-but-older case too",
  deduped.filter((r) => r.memberName === "Solar").map((r) => r.rawSubmitted),
  ["08-31 14:12"],
);
check(
  "identical timestamps fall to higher DPS",
  deduped.filter((r) => r.memberName === "Tiebreak").map((r) => r.dps),
  [2_000_000],
);
check(
  "the collapse is reported, not silent",
  deduped.map((r) => [r.memberName, r.supersededCount]),
  [
    ["Solar", 1],
    ["Darasaki", 1],
    ["Tiebreak", 1],
  ],
);
check(
  "dedupe is order-independent (reversed input, same winners)",
  dedupeRankingRows(dupParsed.rows.slice().reverse())
    .map((r) => [r.memberName, r.dps])
    .sort(),
  deduped.map((r) => [r.memberName, r.dps]).sort(),
);

console.log("\n4b. the preview wires parser + shared matcher together");
const ROSTER: MatchRosterMember[] = [
  { userId: "r1", displayName: "Solar", username: "solar", className: "Paladin", power: 10 },
  { userId: "r2", displayName: "Darasaki", username: "dara", className: "Priest", power: 20 },
  { userId: "r3", displayName: "Lady Of War", username: "low", className: "Wizard", power: 30 },
];
const prev = buildRankingPreview("daddy", PASTE, ROSTER, [], NOW, new Map());
check("preview ok", prev.ok, true);
check(
  "exact matches found through the SHARED matcher",
  prev.rows.filter((r) => r.tier === "exact").map((r) => [r.rawName, r.userId]),
  [
    ["Solar", "r1"],
    ["Darasaki", "r2"],
    ["Lady Of War", "r3"],
  ],
);
check(
  "every parsed row is accounted for in exactly one bucket",
  prev.counts.exact +
    prev.counts.suggested +
    prev.counts.unmatched +
    prev.counts.error,
  prev.counts.total,
);
check("malformed rows survive into the preview", prev.counts.error, 2);

console.log("\n4c. year inference (an assumption, so it is pinned)");
const future = parseRankingText(
  [
    "  #     DPS   Total   Dead  Class   Submitted    Member",
    "  1   1.00M    10M    0s    Monk    12-28 23:00  Xmas",
  ].join("\n"),
  NOW,
);
check(
  "a MM-DD in the future rolls back a year",
  new Date(future.rows[0].submittedAtMs).toISOString(),
  "2025-12-28T23:00:00.000Z",
);
check(
  "a MM-DD in the past stays in this year",
  new Date(parsed.rows[0].submittedAtMs).toISOString(),
  "2026-08-31T14:12:00.000Z",
);

// ===========================================================================
// 5-8. THE GENERATOR
// ===========================================================================

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  updatedAt: NOW.toISOString(),
};
const PARTY_SIZE = SETTINGS.partySize; // 5
const MAIN_PARTIES = POLARITY_RAID_COUNT.main * POLARITY_PARTY_COUNT.main; // 10
const MAIN_SEATS = MAIN_PARTIES * PARTY_SIZE; // 50
const NORMAL_PARTIES =
  POLARITY_RAID_COUNT.normal * POLARITY_PARTY_COUNT.normal; // 20
const NORMAL_SEATS = NORMAL_PARTIES * PARTY_SIZE; // 100
const BOARD_PARTIES = MAIN_PARTIES + NORMAL_PARTIES; // 30
const BOARD_SEATS = MAIN_SEATS + NORMAL_SEATS; // 150

// The LIVE rosters, read once from the discordbot DB on 2026-09-20 and pinned
// here so the proofs run at real supply rather than at a convenient shape.
const LIVE = {
  daddy: { members: 147, priests: 35 },
  mummy: { members: 150, priests: 37 },
};

interface TestParty extends PlanSource {
  raidId: string;
  kind: PolarityKind;
  position: number;
}

/** The canonical 30-party skeleton, all empty unless `locks` says otherwise. */
function makeParties(
  locks: Record<string, { memberIds: string[]; lockedSlots: number[] }> = {},
): TestParty[] {
  const out: TestParty[] = [];
  for (const spec of polarityStructure("daddy")) {
    for (let i = 0; i < spec.partyCount; i++) {
      const partyId = `${spec.raidId}-p${i}`;
      const lock = locks[partyId];
      out.push({
        partyId,
        raidId: spec.raidId,
        kind: spec.kind,
        position: i,
        memberIds: lock ? lock.memberIds : [],
        lockedSlots: lock ? lock.lockedSlots : [],
      });
    }
  }
  return out;
}

const NON_PRIEST_CLASSES = [
  "Paladin",
  "Hunter",
  "Blacksmith",
  "Knight",
  "Wizard",
  "Assassin",
  "Monk",
  "Druid",
  "Gunslinger",
];

/**
 * A deterministic roster. `priestCount` members are Priests; the rest cycle
 * through the other classes. Power is a fixed pseudo-spread so the normal-raid
 * ranking has real structure rather than an all-zero tie.
 */
function makeMembers(count: number, priestCount: number): Member[] {
  const out: Member[] = [];
  for (let i = 0; i < count; i++) {
    const className =
      i < priestCount
        ? HEALER_CLASS
        : NON_PRIEST_CLASSES[i % NON_PRIEST_CLASSES.length];
    const id = `u${String(i).padStart(3, "0")}`;
    out.push({
      userId: id,
      username: id,
      displayName: `Member ${id}`,
      avatarUrl: null,
      isMain: true,
      isSub: false,
      className,
      classRoleId: null,
      updatedAt: NOW.toISOString(),
      power: (i * 37) % 977,
    });
  }
  return out;
}

/** An imported DPS row for the first `covered` members, descending by index. */
function makeDps(members: Member[], covered: number): Map<string, StoredDps> {
  const map = new Map<string, StoredDps>();
  members.slice(0, covered).forEach((m, i) => {
    map.set(m.userId, {
      dps: (covered - i) * 100_000,
      total: (covered - i) * 10_000_000,
      deadSeconds: 2,
      className: m.className ?? "",
      submittedAt: NOW.toISOString(),
    });
  });
  return map;
}

interface RunContext {
  members: Member[];
  parties: TestParty[];
  plans: PartyPlan[];
  cohorts: PartyPlan[][];
  mainCohorts: PartyPlan[][];
  normalCohorts: PartyPlan[][];
  pool: Member[];
  powerOf: (uid: string) => number;
  classOf: (uid: string) => string | null;
}

function context(members: Member[], parties: TestParty[]): RunContext {
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const plans = buildPlans(parties, memberById, PARTY_SIZE);
  const planById = new Map(plans.map((p) => [p.partyId, p]));
  const raidIds: string[] = [];
  for (const p of parties) if (!raidIds.includes(p.raidId)) raidIds.push(p.raidId);
  const cohortFor = (raidId: string) =>
    parties
      .filter((p) => p.raidId === raidId)
      .sort((a, b) => a.position - b.position)
      .map((p) => planById.get(p.partyId)!)
      .filter((p): p is PartyPlan => p !== undefined);
  const cohorts = raidIds.map(cohortFor);
  const mainKind = new Map(parties.map((p) => [p.raidId, p.kind]));

  const pinned = new Set<string>();
  for (const plan of plans) {
    for (const i of plan.locked) {
      const uid = plan.slots[i];
      if (uid) pinned.add(uid);
    }
  }

  return {
    members,
    parties,
    plans,
    cohorts,
    mainCohorts: raidIds.filter((r) => mainKind.get(r) === "main").map(cohortFor),
    normalCohorts: raidIds
      .filter((r) => mainKind.get(r) !== "main")
      .map(cohortFor),
    pool: members.filter((m) => !pinned.has(m.userId)),
    powerOf: (uid) => memberById.get(uid)?.power ?? 0,
    classOf: (uid) => memberById.get(uid)?.className ?? null,
  };
}

/** partyId → assigned memberIds, in board order. The comparable board. */
function snapshot(plans: PartyPlan[]): [string, string[]][] {
  return plans.map((p) => [p.partyId, slotsToMemberIds(p.slots)]);
}

function isNormal(partyId: string): boolean {
  return partyId.includes("-polarity-normal-");
}

/**
 * THE OLD GENERATOR, VERBATIM. This is what generatePolarity did before the
 * change: one pass of generateCohorts over all six cohorts with polarityQuotas,
 * ranking the whole pool on POWER. generate.ts and polarityQuotas were left
 * untouched precisely so this reference can still be run.
 */
function runOld(
  members: Member[],
  locks: Record<string, { memberIds: string[]; lockedSlots: number[] }> = {},
) {
  const ctx = context(members, makeParties(locks));
  const missing = generateCohorts(
    ctx.cohorts,
    ctx.pool,
    ctx.powerOf,
    ctx.classOf,
    SETTINGS,
    { tieBreak: "userId", partitionFirst: true, quotas: polarityQuotas },
  );
  return { ctx, missing, board: snapshot(ctx.plans) };
}

/**
 * THE NEW GENERATOR — the pure core of generatePolarity: main raids by imported
 * DPS with one priest per party, then the untouched engine on power for the
 * four normal raids, and FINALLY the spare-seat pass that lets a surplus priest
 * take a seat that would otherwise stay empty. The stages and their order are
 * the same ones generatePolarity runs; keep them in step.
 */
function runNew(
  members: Member[],
  dps: Map<string, StoredDps>,
  locks: Record<string, { memberIds: string[]; lockedSlots: number[] }> = {},
  parties: TestParty[] = makeParties(locks),
) {
  const ctx = context(members, parties);
  const dpsOf = (uid: string): DpsRow | null => {
    const row = dps.get(uid);
    return row ? { dps: row.dps, className: row.className || null } : null;
  };
  const mainFill = fillMainRaidsByDps(
    ctx.mainCohorts,
    ctx.pool,
    dpsOf,
    ctx.classOf,
    HEALER_CLASS,
  );
  const normalPool = ctx.pool.filter((m) => !mainFill.placed.has(m.userId));
  // The SAME effective-class rule the main pass uses: imported Class first,
  // stored className as the fallback.
  const isPriest = (uid: string) =>
    (dpsOf(uid)?.className ?? ctx.classOf(uid)) === HEALER_CLASS;
  const normalPriests = fillNormalRaidPriests(
    ctx.normalCohorts,
    normalPool,
    isPriest,
    ctx.powerOf,
    ctx.classOf,
    HEALER_CLASS,
  );
  // EVERY priest is withheld from the engine, not just the seated ones — that
  // is what makes "never a second priest" hold rather than merely usually hold.
  const normalFillPool = normalPool.filter((m) => !isPriest(m.userId));
  const normalMissing = generateCohorts(
    ctx.normalCohorts,
    normalFillPool,
    ctx.powerOf,
    ctx.classOf,
    SETTINGS,
    { tieBreak: "userId", partitionFirst: true, quotas: polarityNormalQuotas },
  );
  // ---- 4. SPARE SEATS, LAST. Main raids first and only to leftovers that
  // carry an imported DPS row (main-raid eligibility is unchanged), then the
  // normal raids on power.
  const leftoverPriests = normalPriests.leftover;
  const mainSpare = seatSparePriests(
    ctx.mainCohorts.flat(),
    leftoverPriests
      .filter((m) => dpsOf(m.userId) !== null)
      .sort(
        (a, b) =>
          (dpsOf(b.userId)?.dps ?? 0) - (dpsOf(a.userId)?.dps ?? 0) ||
          a.userId.localeCompare(b.userId),
      ),
    isPriest,
    (uid) => dpsOf(uid)?.dps ?? 0,
    ctx.classOf,
  );
  const normalSpare = seatSparePriests(
    ctx.normalCohorts.flat(),
    leftoverPriests.filter((m) => !mainSpare.placed.has(m.userId)),
    isPriest,
    ctx.powerOf,
    ctx.classOf,
  );
  const sparePriestsSeated = mainSpare.seated.length + normalSpare.seated.length;

  const missing = new Map<string, string[]>();
  for (const src of [mainFill.missing, normalPriests.missing, normalMissing]) {
    for (const [partyId, classes] of src) {
      const list = missing.get(partyId);
      if (!list) {
        missing.set(partyId, [...classes]);
        continue;
      }
      for (const cls of classes) if (!list.includes(cls)) list.push(cls);
    }
  }
  return {
    ctx,
    mainFill,
    normalPriests,
    normalPool,
    mainSpare,
    normalSpare,
    sparePriestsSeated,
    /** Priests STILL unassigned once every empty seat has had its chance. */
    surplusPriestCount: normalPriests.priestsLeftOver - sparePriestsSeated,
    missing,
    board: snapshot(ctx.plans),
  };
}

/**
 * THE NEW NORMAL PATH ALONE — pre-seed a priest per party, then the untouched
 * engine on the non-priest remainder — over whatever pool the caller leaves.
 * Section 8 uses it to push the OLD generator's leftovers through the NEW
 * normal half and compare.
 */
function replayNewNormal(
  members: Member[],
  excludeIds: Set<string>,
  locks: Record<string, { memberIds: string[]; lockedSlots: number[] }> = {},
): [string, string[]][] {
  const ctx = context(members, makeParties(locks));
  const pool = ctx.pool.filter((m) => !excludeIds.has(m.userId));
  const isPriest = (uid: string) => ctx.classOf(uid) === HEALER_CLASS;
  fillNormalRaidPriests(
    ctx.normalCohorts,
    pool,
    isPriest,
    ctx.powerOf,
    ctx.classOf,
    HEALER_CLASS,
  );
  generateCohorts(
    ctx.normalCohorts,
    pool.filter((m) => !isPriest(m.userId)),
    ctx.powerOf,
    ctx.classOf,
    SETTINGS,
    { tieBreak: "userId", partitionFirst: true, quotas: polarityNormalQuotas },
  );
  return snapshot(ctx.plans).filter(([id]) => isNormal(id));
}

/** How many priests each party holds, in board order. */
function priestsPerParty(
  board: [string, string[]][],
  members: Member[],
  dps: Map<string, StoredDps>,
): [string, number][] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const effClass = (uid: string) =>
    dps.get(uid)?.className || byId.get(uid)?.className || null;
  return board.map(([partyId, ids]) => [
    partyId,
    ids.filter((id) => effClass(id) === HEALER_CLASS).length,
  ]);
}

/** How many priests sit in each main party, in board order. */
function priestsPerMainParty(
  board: [string, string[]][],
  members: Member[],
  dps: Map<string, StoredDps>,
): number[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const effClass = (uid: string) =>
    dps.get(uid)?.className || byId.get(uid)?.className || null;
  return board
    .filter(([partyId]) => !isNormal(partyId))
    .map(([, ids]) => ids.filter((id) => effClass(id) === HEALER_CLASS).length);
}

console.log("\n5. exactly one priest per main party, never two");
{
  const members = makeMembers(150, 24); // plenty of priests
  const dps = makeDps(members, 150); // everyone has an imported row
  const run = runNew(members, dps);
  const counts = priestsPerMainParty(run.board, members, dps);
  check("10 main parties", counts.length, MAIN_PARTIES);
  check("one priest in each", counts, new Array(MAIN_PARTIES).fill(1));
  ok(
    "no main party ever holds a second priest",
    counts.every((c) => c <= 1),
    JSON.stringify(counts),
  );
  check("priests seeded by this run", run.mainFill.seededPriests, MAIN_PARTIES);
  check("no main party flagged missing a priest", run.mainFill.partiesMissingPriest, []);
  check(
    "main raids filled to capacity",
    run.board.filter(([id]) => !isNormal(id)).reduce((s, [, ids]) => s + ids.length, 0),
    MAIN_SEATS,
  );
  // The 10 priests that got in are the 10 HIGHEST-DPS priests.
  const byId = new Map(members.map((m) => [m.userId, m]));
  const mainPriests = run.board
    .filter(([id]) => !isNormal(id))
    .flatMap(([, ids]) => ids)
    .filter((id) => byId.get(id)?.className === HEALER_CLASS)
    .sort();
  const topPriests = members
    .filter((m) => m.className === HEALER_CLASS)
    .sort((a, b) => (dps.get(b.userId)!.dps - dps.get(a.userId)!.dps))
    .slice(0, MAIN_PARTIES)
    .map((m) => m.userId)
    .sort();
  check("and they are the top-DPS priests", mainPriests, topPriests);

  console.log("\n5b. a member with NO imported DPS row cannot enter a main raid");
  const partial = makeDps(members, 60); // only 60 of 150 have a row
  const run2 = runNew(members, partial);
  const mainIds = run2.board
    .filter(([id]) => !isNormal(id))
    .flatMap(([, ids]) => ids);
  ok(
    "every main-raid member has an imported row",
    mainIds.every((id) => partial.has(id)),
    mainIds.filter((id) => !partial.has(id)).join(","),
  );
  check("the barred count is reported", run2.mainFill.noDps, 150 - 60);
  check("eligible count is reported", run2.mainFill.eligible, 60);
  ok(
    "the barred members are not dropped — they are in the normal raids",
    run2.board
      .filter(([id]) => isNormal(id))
      .flatMap(([, ids]) => ids)
      .some((id) => !partial.has(id)),
  );

  console.log("\n5c. a LOCKED slot still wins over everything");
  const locks = {
    "daddy-polarity-main-0-p0": {
      // u149 is the WEAKEST member and has no DPS row in `partial` — pinned, so
      // the DPS pass must leave them exactly where they are.
      memberIds: ["u149"],
      lockedSlots: [0],
    },
  };
  const run3 = runNew(members, partial, locks);
  const pinnedParty = run3.board.find(
    ([id]) => id === "daddy-polarity-main-0-p0",
  )!;
  check("the pinned member keeps slot 0", pinnedParty[1][0], "u149");
  check("the party is still filled to size", pinnedParty[1].length, PARTY_SIZE);
  ok(
    "the pinned member appears exactly once on the whole board",
    run3.board.flatMap(([, ids]) => ids).filter((id) => id === "u149").length === 1,
  );
}

console.log("\n6. fewer priests than parties flags the SHORT parties");
{
  const members = makeMembers(150, 4); // only 4 priests exist
  const dps = makeDps(members, 150);
  const run = runNew(members, dps);
  const counts = priestsPerMainParty(run.board, members, dps);
  check("four parties get a priest, six do not", counts, [
    1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  ]);
  check("seeded", run.mainFill.seededPriests, 4);
  check(
    "the six short parties are flagged, in board order",
    run.mainFill.partiesMissingPriest,
    [
      "daddy-polarity-main-0-p4",
      "daddy-polarity-main-1-p0",
      "daddy-polarity-main-1-p1",
      "daddy-polarity-main-1-p2",
      "daddy-polarity-main-1-p3",
      "daddy-polarity-main-1-p4",
    ],
  );
  check(
    "flagged through the EXISTING partiesMissing mechanism",
    Object.entries(Object.fromEntries(run.missing))
      .filter(([id]) => !isNormal(id))
      .map(([id, miss]) => [id, miss]),
    [
      ["daddy-polarity-main-0-p4", ["Priest"]],
      ["daddy-polarity-main-1-p0", ["Priest"]],
      ["daddy-polarity-main-1-p1", ["Priest"]],
      ["daddy-polarity-main-1-p2", ["Priest"]],
      ["daddy-polarity-main-1-p3", ["Priest"]],
      ["daddy-polarity-main-1-p4", ["Priest"]],
    ],
  );
  ok(
    "the short parties are still FILLED — they are flagged, not left empty",
    run.board
      .filter(([id]) => !isNormal(id))
      .every(([, ids]) => ids.length === PARTY_SIZE),
  );

  console.log("\n6b. zero priests at all");
  const noPriests = makeMembers(150, 0);
  const runNone = runNew(noPriests, makeDps(noPriests, 150));
  check("all ten flagged", runNone.mainFill.partiesMissingPriest.length, MAIN_PARTIES);
  check("none seeded", runNone.mainFill.seededPriests, 0);
}

console.log("\n7. determinism — two consecutive runs are byte-identical");
{
  const members = makeMembers(150, 24);
  const dps = makeDps(members, 120);
  const a = runNew(members, dps);
  const b = runNew(members, dps);
  check("identical boards", a.board, b.board);
  check("identical missing maps", [...a.missing], [...b.missing]);
  // And with locks in play.
  const locks = {
    "daddy-polarity-main-1-p2": { memberIds: ["u140", "u141"], lockedSlots: [0, 1] },
    "daddy-polarity-normal-2-p3": { memberIds: ["u142"], lockedSlots: [0] },
  };
  check(
    "identical with locks too",
    runNew(members, dps, locks).board,
    runNew(members, dps, locks).board,
  );
  // A re-run is stable even when the member list arrives in a different order,
  // because every ordering is total (DPS desc, then userId).
  check(
    "stable against input order",
    runNew(members.slice().reverse(), dps).board,
    a.board,
  );
}

console.log(
  "\n8. the shared ENGINE is unchanged — old vs new normal raids, byte for byte",
);
{
  // THE CONTROL IS A ZERO-PRIEST ROSTER. With no priest in the pool the new
  // normal path's pre-seed is a no-op, so what remains is the shared engine on
  // the same cohorts with the same options — and it must reproduce the OLD
  // generator's normal half exactly. That isolates the pre-seed as the ONLY
  // thing that changed about the normal raids; anything else that had drifted
  // in generate.ts or in the quota split would show up here.
  const members = makeMembers(150, 0);
  const dps = makeDps(members, 150);

  // (a) Run the OLD generator over the full roster. Take the members it left
  //     for the normal raids, and feed EXACTLY those through the NEW normal
  //     path. The two normal halves must be identical: the only thing the
  //     change touches is WHO reaches the normal pool, not what happens there.
  const old = runOld(members);
  const oldMainIds = new Set(
    old.board.filter(([id]) => !isNormal(id)).flatMap(([, ids]) => ids),
  );
  const oldNormal = old.board.filter(([id]) => isNormal(id));

  check(
    "same normal pool → identical normal raids",
    replayNewNormal(members, oldMainIds),
    oldNormal,
  );

  // (b) The same equality on a DIFFERENT roster shape, with locks, so (a) is
  //     not a one-off.
  const members2 = makeMembers(97, 0);
  const locks = {
    "daddy-polarity-normal-0-p1": { memberIds: ["u090"], lockedSlots: [0] },
    "daddy-polarity-normal-3-p4": { memberIds: ["u091", "u092"], lockedSlots: [0, 1] },
  };
  const old2 = runOld(members2, locks);
  const old2MainIds = new Set(
    old2.board.filter(([id]) => !isNormal(id)).flatMap(([, ids]) => ids),
  );
  check(
    "second roster, with locks → identical normal raids",
    replayNewNormal(members2, old2MainIds, locks),
    old2.board.filter(([id]) => isNormal(id)),
  );

  // (c) The quota split itself is the same function on the same numbers: the
  //     normal tail of polarityQuotas IS polarityNormalQuotas.
  // Both the CURRENT shape (6 x 25) and the LEGACY 8-party shape, because the
  // count is meant to be movable and the tail equality must not depend on it.
  const caps = [
    ...new Array(POLARITY_RAID_COUNT.main).fill(
      POLARITY_PARTY_COUNT.main * PARTY_SIZE,
    ),
    ...new Array(POLARITY_RAID_COUNT.normal).fill(
      POLARITY_PARTY_COUNT.normal * PARTY_SIZE,
    ),
  ];
  check("cohort capacities at the current shape", caps, [
    25, 25, 25, 25, 25, 25,
  ]);
  for (const remaining of [0, 7, 50, 90, 150, 210, 400]) {
    const full = polarityQuotas(caps, remaining);
    const mainTaken = full[0] + full[1];
    check(
      `quota tail matches at remaining=${remaining}`,
      full.slice(2),
      polarityNormalQuotas(caps.slice(2), remaining - mainTaken),
    );
  }
  const legacyCaps = [25, 25, 40, 40, 40, 40];
  for (const remaining of [0, 7, 50, 90, 150, 210, 400]) {
    const full = polarityQuotas(legacyCaps, remaining);
    check(
      `quota tail matches at the legacy 8-party shape, remaining=${remaining}`,
      full.slice(2),
      polarityNormalQuotas(legacyCaps.slice(2), remaining - full[0] - full[1]),
    );
  }

  // (d) And the new run really does put different people in the MAIN raids —
  //     otherwise the whole comparison above would be vacuous.
  const fresh = runNew(members, dps);
  const newMainIds = new Set(
    fresh.board.filter(([id]) => !isNormal(id)).flatMap(([, ids]) => ids),
  );
  ok(
    "the main raids DID change (so the normal comparison is not vacuous)",
    [...newMainIds].some((id) => !oldMainIds.has(id)),
    `old main ${[...oldMainIds].slice(0, 5).join(",")} / new main ${[...newMainIds].slice(0, 5).join(",")}`,
  );
  check(
    "nobody is lost: every pool member is placed or accounted for",
    fresh.board.flatMap(([, ids]) => ids).length,
    Math.min(members.length, BOARD_SEATS),
  );
  ok(
    "no member appears twice on the board",
    new Set(fresh.board.flatMap(([, ids]) => ids)).size ===
      fresh.board.flatMap(([, ids]) => ids).length,
  );
}

// ===========================================================================
// 9-13. THE RAID SHAPE (8 parties -> 5) AND THE BOARD-WIDE PRIEST GUARANTEE
// ===========================================================================

console.log("\n9. every raid is 5 parties, and the capacity that follows");
{
  const structure = polarityStructure("daddy");
  check("six raids", structure.length, 6);
  check(
    "every raid — main AND normal — has 5 parties",
    structure.map((s) => s.partyCount),
    [5, 5, 5, 5, 5, 5],
  );
  check("30 parties on the board", BOARD_PARTIES, 30);
  check("per-guild capacity is 150", polarityTotalCapacity(PARTY_SIZE), 150);
  check("…and that is what the seats add up to", BOARD_SEATS, 150);
  check(
    "the canonical party id list is 30 long and matches the structure",
    polarityPartyIds("daddy").length,
    BOARD_PARTIES,
  );
  check(
    "no canonical id sits at a hidden position (p5-p7)",
    polarityPartyIds("daddy").filter((id) => /-p[5-9]$/.test(id)),
    [],
  );
  check(
    "the skeleton the generator builds is the same 30",
    makeParties().length,
    BOARD_PARTIES,
  );
}

console.log(
  "\n10. a priest in EVERY party at LIVE supply — and the surplus now SEATED",
);
for (const [guild, live] of Object.entries(LIVE)) {
  const members = makeMembers(live.members, live.priests);
  const dps = makeDps(members, live.members);
  const run = runNew(members, dps);
  const counts = priestsPerParty(run.board, members, dps);
  const spare = live.priests - BOARD_PARTIES; // 5 daddy, 7 mummy

  check(`${guild}: 30 parties on the board`, counts.length, BOARD_PARTIES);
  check(
    `${guild}: every one of the 30 parties has a priest`,
    counts.filter(([, n]) => n < 1).map(([id]) => id),
    [],
  );
  check(
    `${guild}: no party flagged missing a priest`,
    [...run.mainFill.partiesMissingPriest, ...run.normalPriests.partiesMissingPriest],
    [],
  );
  check(
    `${guild}: priests seeded ONE PER PARTY first`,
    run.mainFill.seededPriests + run.normalPriests.seededPriests,
    BOARD_PARTIES,
  );

  // THE CHANGE. The one-per-party pass still leaves the same 5 (daddy) / 7
  // (mummy) priests over — that number is unchanged and still reported — but
  // they are no longer abandoned in the pool next to empty seats.
  const seated = run.board.flatMap(([, ids]) => ids);
  check(
    `${guild}: surplus priests after the one-per-party pass`,
    run.normalPriests.priestsLeftOver,
    spare,
  );
  check(`${guild}: and every one of them took an empty seat`, run.sparePriestsSeated, spare);
  check(`${guild}: surplus priests still unassigned`, run.surplusPriestCount, 0);
  // Those seats were EMPTY before this change, which is the whole complaint:
  // the roster now goes onto the board in full.
  check(
    `${guild}: the board holds the entire roster`,
    seated.length,
    Math.min(members.length, BOARD_SEATS),
  );
  check(
    `${guild}: nobody sits in the pool while a seat is open`,
    members.filter((m) => !seated.includes(m.userId)).length,
    Math.max(0, members.length - BOARD_SEATS),
  );
  // SPREAD, not stack: one extra priest each in that many DIFFERENT parties.
  check(
    `${guild}: the ${spare} second priests landed in ${spare} different parties`,
    counts.filter(([, n]) => n === 2).length,
    spare,
  );
  check(
    `${guild}: no party was given a third`,
    counts.filter(([, n]) => n > 2).map(([id]) => id),
    [],
  );
  ok(
    `${guild}: nothing is placed twice`,
    new Set(seated).size === seated.length,
  );
  ok(
    `${guild}: nobody is dropped — seated + unassigned = the roster`,
    seated.length + members.filter((m) => !seated.includes(m.userId)).length ===
      members.length,
  );
  ok(
    `${guild}: the board never exceeds capacity`,
    seated.length <= BOARD_SEATS,
    `${seated.length} > ${BOARD_SEATS}`,
  );
}

console.log(
  "\n11. NO party is given a second priest while another could take its first",
);
{
  // (a) A priest-heavy roster: far more priests than parties, and only 30
  //     non-priests to fill 150 seats. Under the OLD rule 90 priests sat in the
  //     pool while 90 seats stayed empty. Now they fill those seats — but only
  //     AFTER all 30 parties have their first.
  const members = makeMembers(150, 120);
  const dps = makeDps(members, 150);
  const run = runNew(members, dps);
  const counts = priestsPerParty(run.board, members, dps);
  ok(
    "120 priests, 30 parties → every party has at least one",
    counts.every(([, n]) => n >= 1),
    JSON.stringify(counts.filter(([, n]) => n < 1)),
  );
  check(
    "the one-per-party pass ran first and seated exactly 30",
    run.mainFill.seededPriests + run.normalPriests.seededPriests,
    BOARD_PARTIES,
  );
  check(
    "the 90 left over are reported by that pass",
    run.normalPriests.priestsLeftOver,
    120 - MAIN_PARTIES - NORMAL_PARTIES,
  );
  check(
    "— and all 90 then took an empty seat",
    [run.sparePriestsSeated, run.surplusPriestCount],
    [120 - MAIN_PARTIES - NORMAL_PARTIES, 0],
  );
  check(
    "the board is completely full",
    run.board.flatMap(([, ids]) => ids).length,
    BOARD_SEATS,
  );
  ok(
    "no party exceeds partySize",
    counts.every(([, n]) => n <= PARTY_SIZE),
    JSON.stringify(counts.filter(([, n]) => n > PARTY_SIZE)),
  );

  // (b) A LOCKED priest satisfies its party and must not be doubled up. u000
  //     and u001 are priests; pin one into a main party and one into a normal
  //     party. The roster here is 30 priests to 120 others — exactly one priest
  //     and four others per party — so "full" is a meaningful expectation.
  const exact = makeMembers(150, BOARD_PARTIES);
  const exactDps = makeDps(exact, 150);
  const locks = {
    "daddy-polarity-main-1-p3": { memberIds: ["u000"], lockedSlots: [0] },
    "daddy-polarity-normal-2-p2": { memberIds: ["u001"], lockedSlots: [0] },
  };
  const locked = runNew(exact, exactDps, locks);
  const lockedCounts = priestsPerParty(locked.board, exact, exactDps);
  ok(
    "a locked priest is not given a partner",
    lockedCounts.every(([, n]) => n === 1),
    JSON.stringify(lockedCounts.filter(([, n]) => n !== 1)),
  );
  const mainPinned = locked.board.find(
    ([id]) => id === "daddy-polarity-main-1-p3",
  )!;
  const normalPinned = locked.board.find(
    ([id]) => id === "daddy-polarity-normal-2-p2",
  )!;
  check("the locked main priest keeps slot 0", mainPinned[1][0], "u000");
  check("the locked normal priest keeps slot 0", normalPinned[1][0], "u001");
  check("both parties are still full", [mainPinned[1].length, normalPinned[1].length], [
    PARTY_SIZE,
    PARTY_SIZE,
  ]);
  check(
    "at exactly one priest per party the whole board fills, nothing spare",
    [
      locked.board.flatMap(([, ids]) => ids).length,
      locked.normalPriests.priestsLeftOver,
    ],
    [BOARD_SEATS, 0],
  );
  ok(
    "neither locked priest appears anywhere else",
    locked.board.flatMap(([, ids]) => ids).filter((id) => id === "u000")
      .length === 1 &&
      locked.board.flatMap(([, ids]) => ids).filter((id) => id === "u001")
        .length === 1,
  );
}

console.log("\n12. SHORT priest supply flags the short parties, board-wide");
{
  // 12 priests for 30 parties: the 10 main parties take theirs first, leaving
  // 2 for the 20 normal parties. 18 normal parties must be FLAGGED and still
  // FILLED with non-priests.
  const members = makeMembers(150, 12);
  const dps = makeDps(members, 150);
  const run = runNew(members, dps);

  check("all 10 main parties got one", run.mainFill.seededPriests, MAIN_PARTIES);
  check("only 2 normal parties got one", run.normalPriests.seededPriests, 2);
  check(
    "the 18 short normal parties are flagged, in board order",
    run.normalPriests.partiesMissingPriest.length,
    NORMAL_PARTIES - 2,
  );
  check(
    "the first two normal parties are the ones that got a priest",
    run.normalPriests.partiesMissingPriest.slice(0, 3),
    [
      "daddy-polarity-normal-0-p2",
      "daddy-polarity-normal-0-p3",
      "daddy-polarity-normal-0-p4",
    ],
  );
  check(
    "flagged through the EXISTING partiesMissing mechanism",
    [...run.missing]
      .filter(([id]) => isNormal(id))
      .map(([, miss]) => miss)
      .every((miss) => miss.includes(HEALER_CLASS)),
    true,
  );
  check("nothing left over", run.normalPriests.priestsLeftOver, 0);
  ok(
    "the short parties are still FILLED — flagged, not left empty",
    run.board
      .filter(([id]) => isNormal(id))
      .every(([, ids]) => ids.length === PARTY_SIZE),
    JSON.stringify(
      run.board.filter(([id]) => isNormal(id)).filter(([, ids]) => ids.length !== PARTY_SIZE),
    ),
  );
}

console.log("\n13. the HIDDEN surplus parties (positions 5-7)");
{
  // The 8-party era left 12 documents per guild behind. They are HIDDEN, not
  // deleted. Simulate them: the stored docs still carry members at positions
  // 5-7; the board is assembled from polarityStructure, so those rows are
  // never read, and their members must come back to the POOL.
  const members = makeMembers(150, 37);
  const dps = makeDps(members, 150);

  const storedDocIds: string[] = [];
  for (const spec of polarityStructure("daddy")) {
    const legacyCount = spec.kind === "normal" ? 8 : 5;
    for (let i = 0; i < legacyCount; i++) {
      storedDocIds.push(`${spec.raidId}-p${i}`);
    }
  }
  check("the collection still holds 42 rows per guild", storedDocIds.length, 42);

  const visible = new Set(polarityPartyIds("daddy"));
  const hidden = storedDocIds.filter((id) => !visible.has(id));
  check("12 of them are hidden", hidden.length, 12);
  check(
    "and they are exactly the normal raids' positions 5-7",
    hidden.every((id) => /-polarity-normal-\d+-p[5-7]$/.test(id)),
    true,
  );

  // 25 members were sitting in mummy's hidden rows. Those ids are simply not
  // on the visible board, so they are in the pool like anyone else — and the
  // generator seats them. Prove it by naming them and finding them again.
  const strandedIds = members.slice(120, 145).map((m) => m.userId);
  check("25 stranded members", strandedIds.length, 25);
  const run = runNew(members, dps);
  const seated = new Set(run.board.flatMap(([, ids]) => ids));
  const seatedStranded = strandedIds.filter((id) => seated.has(id));
  ok(
    "stranded members are treated as available, not as still-assigned",
    seatedStranded.length > 0,
    `${seatedStranded.length}/25 seated`,
  );
  ok(
    "nobody is counted twice — the board holds each member at most once",
    new Set(run.board.flatMap(([, ids]) => ids)).size ===
      run.board.flatMap(([, ids]) => ids).length,
  );
  check(
    "the board only ever addresses visible parties",
    run.board.map(([id]) => id).filter((id) => !visible.has(id)),
    [],
  );

  // AND the write paths are scoped by id rather than by `{ type: guild }`,
  // which would sweep the hidden rows in. Read the source and prove it.
  const actionsSrc = readFileSync(
    join(process.cwd(), "src", "lib", "polarity-actions.ts"),
    "utf8",
  );
  const partyWrites = actionsSrc
    .split("collection(POLARITY_PARTIES)")
    .slice(1)
    .map((seg) => seg.slice(0, 260));
  const unscoped = partyWrites.filter(
    (seg) => seg.includes(".updateMany(") && !seg.includes("polarityPartyIds"),
  );
  check(
    "no collection-wide updateMany on polarityParties",
    unscoped.length,
    0,
  );
  ok(
    "resetLockPolarity scopes its clear to the canonical ids",
    actionsSrc.includes("polarityPartyIds(guild)"),
  );
}

console.log("\n14. determinism at the LIVE shape, whole board");
{
  const members = makeMembers(LIVE.mummy.members, LIVE.mummy.priests);
  const dps = makeDps(members, 90);
  const locks = {
    "daddy-polarity-main-0-p1": { memberIds: ["u003"], lockedSlots: [0] },
    "daddy-polarity-normal-1-p4": { memberIds: ["u100", "u101"], lockedSlots: [0, 1] },
  };
  check("two consecutive runs are identical", runNew(members, dps).board, runNew(members, dps).board);
  check(
    "identical with locks too",
    runNew(members, dps, locks).board,
    runNew(members, dps, locks).board,
  );
  check(
    "and stable against input order",
    runNew(members.slice().reverse(), dps).board,
    runNew(members, dps).board,
  );
  check(
    "the missing maps match too",
    [...runNew(members, dps).missing],
    [...runNew(members, dps).missing],
  );
}

console.log("\n15. GvG is provably untouched");
{
  // (a) generate.ts — the shared engine AND the GvG builder's engine — has not
  //     been modified in the working tree. This is the strongest form of "GvG
  //     is unaffected" available: the code it runs is the committed code.
  let status = "<git failed>";
  try {
    status = execFileSync("git", ["status", "--porcelain", "--", "src/lib/generate.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch (err) {
    status = `<git failed: ${String(err)}>`;
  }
  check("src/lib/generate.ts is byte-identical to HEAD", status, "");

  // (b) The polarity generator never mutates the shared Settings object, so it
  //     cannot leak a requiredClasses change into the GvG builder. The priest
  //     rule is hardwired in polarity-generate.ts and read from nothing.
  const before = JSON.stringify(SETTINGS.requiredClasses);
  const members = makeMembers(120, 30);
  runNew(members, makeDps(members, 120));
  check("settings.requiredClasses is not mutated", JSON.stringify(SETTINGS.requiredClasses), before);

  // (c) And the hardwired rule does not depend on that setting at all: with
  //     requiredClasses EMPTY — exactly how production stores it — every party
  //     still gets its priest. This is the actual bug Conrad reported.
  const emptySettings: Settings = { ...SETTINGS, requiredClasses: [] };
  const ctx = context(members, makeParties());
  const dps = makeDps(members, 120);
  const dpsOf = (uid: string): DpsRow | null => {
    const row = dps.get(uid);
    return row ? { dps: row.dps, className: row.className || null } : null;
  };
  const mainFill = fillMainRaidsByDps(
    ctx.mainCohorts,
    ctx.pool,
    dpsOf,
    ctx.classOf,
    HEALER_CLASS,
  );
  const normalPool = ctx.pool.filter((m) => !mainFill.placed.has(m.userId));
  const isPriest = (uid: string) =>
    (dpsOf(uid)?.className ?? ctx.classOf(uid)) === HEALER_CLASS;
  fillNormalRaidPriests(
    ctx.normalCohorts,
    normalPool,
    isPriest,
    ctx.powerOf,
    ctx.classOf,
    HEALER_CLASS,
  );
  generateCohorts(
    ctx.normalCohorts,
    normalPool.filter((m) => !isPriest(m.userId)),
    ctx.powerOf,
    ctx.classOf,
    emptySettings,
    { tieBreak: "userId", partitionFirst: true, quotas: polarityNormalQuotas },
  );
  const counts = priestsPerParty(snapshot(ctx.plans), members, dps);
  check(
    "requiredClasses EMPTY → all 30 parties still get exactly one priest",
    counts.map(([, n]) => n),
    new Array(BOARD_PARTIES).fill(1),
  );
}


// ===========================================================================
// 16. THE ORDERED PRIEST RULE
//
// Conrad reversed "a party is never given a second priest" on 2026-09-20, but
// only in third place. The order is the rule:
//
//   1. every party gets its first priest;
//   2. the remaining seats fill from the non-priest ranking;
//   3. ONLY THEN may a leftover priest take a seat that is still empty.
//
// Step 1 is the one that must survive. THE INVARIANT, stated once: when a run
// ends, there must be no party that holds no priest AND still has an empty
// seat. A party without a priest is only ever acceptable when nothing could
// have been put in it — it is full of locked non-priests, or the roster had no
// priest left to give. Everything below is that one statement, checked.
// ===========================================================================

/** Parties that end a run with NO priest while a seat of theirs is still free. */
function priestOrderViolations(
  board: [string, string[]][],
  members: Member[],
  dps: Map<string, StoredDps>,
): string[] {
  const size = new Map(board.map(([id, ids]) => [id, ids.length]));
  return priestsPerParty(board, members, dps)
    .filter(([id, n]) => n === 0 && (size.get(id) ?? 0) < PARTY_SIZE)
    .map(([id]) => id);
}

/** Total priests beyond the first, board-wide. */
function secondPriests(
  board: [string, string[]][],
  members: Member[],
  dps: Map<string, StoredDps>,
): number {
  return priestsPerParty(board, members, dps).reduce(
    (t, [, n]) => t + Math.max(0, n - 1),
    0,
  );
}

console.log(
  "\n16a. step 1 holds at every supply level — first priests before second ones",
);
for (const priestCount of [0, 1, 5, 12, 29, 30, 31, 45, 60, 120, 150]) {
  const members = makeMembers(150, priestCount);
  const dps = makeDps(members, 150);
  const run = runNew(members, dps);
  const counts = priestsPerParty(run.board, members, dps);
  const seconds = secondPriests(run.board, members, dps);
  const label = `priests=${priestCount}`;

  // The one-per-party pass always takes as many priests as it can, and never
  // more than one per party — so it seats min(supply, 30), every time.
  check(
    `${label}: the one-per-party pass seated min(supply, 30)`,
    run.mainFill.seededPriests + run.normalPriests.seededPriests,
    Math.min(priestCount, BOARD_PARTIES),
  );
  check(
    `${label}: no party left priestless with a seat going spare`,
    priestOrderViolations(run.board, members, dps),
    [],
  );
  // The teeth: if ANY party got a second, then EVERY party has a first.
  ok(
    `${label}: ${seconds} second priests, and none of them jumped the queue`,
    seconds === 0 || counts.every(([, n]) => n >= 1),
    JSON.stringify(counts.filter(([, n]) => n < 1)),
  );
}

console.log(
  "\n16b. DELIBERATELY SHORT supply — fewer priests than parties, so never a second",
);
for (const priestCount of [0, 5, 12, 29]) {
  const members = makeMembers(150, priestCount);
  const dps = makeDps(members, 150);
  const run = runNew(members, dps);
  const label = `priests=${priestCount}`;
  check(`${label}: not one second priest anywhere`, secondPriests(run.board, members, dps), 0);
  check(`${label}: nothing left over to seat`, run.normalPriests.priestsLeftOver, 0);
  check(`${label}: the spare-seat pass did nothing`, run.sparePriestsSeated, 0);
  check(
    `${label}: ${BOARD_PARTIES - priestCount} parties flagged, and still FILLED`,
    [
      run.mainFill.partiesMissingPriest.length +
        run.normalPriests.partiesMissingPriest.length,
      run.board.filter(([, ids]) => ids.length !== PARTY_SIZE).length,
    ],
    [BOARD_PARTIES - priestCount, 0],
  );
}

console.log(
  "\n16c. a LOCKED-FULL party cannot be served, and does not block the others",
);
{
  // A normal party pinned full of five non-priests. It can never be given a
  // priest — there is no seat — so it must be FLAGGED, and it must not stop
  // surplus priests using the empty seats elsewhere on the board.
  const members = makeMembers(150, 45);
  const dps = makeDps(members, 150);
  const blocked = "daddy-polarity-normal-1-p2";
  const nonPriests = members.filter((m) => m.className !== HEALER_CLASS).slice(0, PARTY_SIZE);
  const locks = {
    [blocked]: {
      memberIds: nonPriests.map((m) => m.userId),
      lockedSlots: [0, 1, 2, 3, 4],
    },
  };
  const run = runNew(members, dps, locks);
  const counts = new Map(priestsPerParty(run.board, members, dps));
  check("the locked party holds no priest", counts.get(blocked), 0);
  check(
    "— and is flagged through the existing mechanism",
    (run.missing.get(blocked) ?? []).includes(HEALER_CLASS),
    true,
  );
  check(
    "— because it is FULL, not because it was skipped",
    (run.board.find(([id]) => id === blocked) ?? ["", []])[1].length,
    PARTY_SIZE,
  );
  check(
    "no OTHER party is left priestless with a free seat",
    priestOrderViolations(run.board, members, dps),
    [],
  );
  ok(
    "the other 29 parties all have a priest",
    priestsPerParty(run.board, members, dps)
      .filter(([id]) => id !== blocked)
      .every(([, n]) => n >= 1),
  );
  ok(
    "and the surplus priests still used the empty seats elsewhere",
    run.sparePriestsSeated > 0,
    `sparePriestsSeated=${run.sparePriestsSeated}`,
  );
}

console.log(
  "\n16d. a NORMAL party's FIRST priest outranks a MAIN raid's empty seat",
);
{
  // Only 45 members carry an imported DPS row, 20 of them priests, so the main
  // raids run out of eligible non-priests and end 15 seats short. The 10
  // priests the main pass could not seat must go to NORMAL parties that have
  // no priest yet — NOT into the main raids' empty seats. This is the ordering
  // that would break first if the spare-seat rule ever leaked into a fill pass.
  const members = makeMembers(150, 20);
  const dps = makeDps(members, 45);
  const run = runNew(members, dps);
  const mainSeated = run.board.filter(([id]) => !isNormal(id)).flatMap(([, ids]) => ids);
  check("main raids are 15 seats short of full", MAIN_SEATS - mainSeated.length, 15);
  check("the main pass seeded all 10 of its parties", run.mainFill.seededPriests, MAIN_PARTIES);
  check("the other 10 priests went to normal parties", run.normalPriests.seededPriests, 10);
  check("— leaving 10 normal parties flagged", run.normalPriests.partiesMissingPriest.length, 10);
  check("no priest took a main spare seat", run.mainSpare.seated.length, 0);
  check("no party holds a second priest", secondPriests(run.board, members, dps), 0);
  check(
    "the empty main seats stayed empty rather than stealing a first priest",
    run.sparePriestsSeated,
    0,
  );
}

console.log("\n16e. the main raids DO take spare priests when nothing else is left");
{
  // 60 eligible, 50 of them priests: the main raids seed 10 and then run out of
  // eligible non-priests after 10 more. Once every one of the 30 parties has a
  // priest and the normal raids are full, the leftovers may finally take the
  // main raids' empty seats — the rule is applied to BOTH halves, not
  // special-cased to the normal raids where it actually bites.
  const members = makeMembers(150, 50);
  const dps = makeDps(members, 60);
  const run = runNew(members, dps);
  ok("the main half of the spare pass ran", run.mainSpare.seated.length > 0);
  check(
    "every one of the 30 parties got its first priest before any of that",
    run.mainFill.seededPriests + run.normalPriests.seededPriests,
    BOARD_PARTIES,
  );
  check(
    "no party left priestless with a seat going spare",
    priestOrderViolations(run.board, members, dps),
    [],
  );
  ok(
    "every spare priest seated in a main raid carries an imported DPS row",
    run.mainSpare.seated.every((uid) => dps.has(uid)),
    JSON.stringify(run.mainSpare.seated.filter((uid) => !dps.has(uid))),
  );
  check(
    "the normal raids were already full, so the normal half seated nobody",
    run.normalSpare.seated.length,
    0,
  );
}

console.log("\n16f. SPREAD, not stack — including on an all-zero-power roster");
{
  // With real power figures the balance total does the spreading on its own:
  // seating a member raises their party's total, so the next one goes somewhere
  // else. With power 0 ACROSS THE ROSTER — which is how production actually
  // stores it — the total never moves, and a pure balance comparison would hand
  // the SAME party every seat it owns before looking at any other. That is why
  // seatSparePriests ranks by priest count FIRST. The control below is the
  // degenerate roster at daddy's live shape, where there are genuinely more
  // empty seats (8) than leftover priests (5) and the tie-break has to decide.
  const flat = makeMembers(LIVE.daddy.members, LIVE.daddy.priests).map((m) => ({
    ...m,
    power: 0,
  }));
  const flatDps = makeDps(flat, LIVE.daddy.members);
  const run = runNew(flat, flatDps);
  const counts = priestsPerParty(run.board, flat, flatDps);
  const extras = counts.filter(([, n]) => n > 1);
  const seconds = secondPriests(run.board, flat, flatDps);

  check("all 30 parties still have a priest", counts.filter(([, n]) => n < 1).length, 0);
  check("5 surplus priests, as at live supply", seconds, LIVE.daddy.priests - BOARD_PARTIES);
  // The non-priest fill leaves its 8 empty seats in FOUR parties (2 each) on a
  // zero-power roster. Balance alone would fill the first party's two seats,
  // then the second's, touching three parties. Priest count first touches all
  // four and leaves only one party two ahead.
  check("the 5 spread over 4 different parties, not 3", extras.length, 4);
  check(
    "at most one party ends two priests up",
    extras.filter(([, n]) => n > 2).length,
    1,
  );

  // Real-power control: the same supply with the usual power spread, where the
  // empty seats land in 8 different parties and every extra gets its own.
  const real = makeMembers(LIVE.daddy.members, LIVE.daddy.priests);
  const realDps = makeDps(real, LIVE.daddy.members);
  const realRun = runNew(real, realDps);
  const realExtras = priestsPerParty(realRun.board, real, realDps).filter(([, n]) => n > 1);
  check(
    "with real power figures every extra lands in its own party",
    realExtras.map(([, n]) => n),
    new Array(LIVE.daddy.priests - BOARD_PARTIES).fill(2),
  );
}

console.log("\n16g. determinism survives the new pass");
for (const priestCount of [37, 60, 120]) {
  const members = makeMembers(150, priestCount);
  const dps = makeDps(members, 150);
  const a = runNew(members, dps);
  const b = runNew(members, dps);
  const shuffled = runNew(members.slice().reverse(), dps);
  check(`priests=${priestCount}: two runs identical`, a.board, b.board);
  check(`priests=${priestCount}: stable against input order`, shuffled.board, a.board);
  check(
    `priests=${priestCount}: and the spare counts match`,
    [a.sparePriestsSeated, a.surplusPriestCount],
    [shuffled.sparePriestsSeated, shuffled.surplusPriestCount],
  );
}

// 17. Bard / Dancer / Alchemist (Conrad, 2026-09-23): known classes, DPS by
//     default, and NEVER counted as the party's Priest.
console.log("\n17. new classes are DPS and never priests");
for (const cls of ["Bard", "Dancer", "Alchemist"]) {
  check(`${cls}: in KNOWN_CLASSES`, (KNOWN_CLASSES as readonly string[]).includes(cls), true);
  check(`${cls}: CLASS_ROLE = dps`, CLASS_ROLE[cls], "dps");
  check(`${cls}: roleForClass = dps`, roleForClass(cls), "dps");
  check(`${cls}: DEFAULT_SETTINGS.classRoles = dps`, DEFAULT_SETTINGS.classRoles[cls], "dps");
  check(`${cls}: roleFor(default settings) = dps`, roleFor(cls, DEFAULT_SETTINGS.classRoles), "dps");
  check(`${cls}: not the healer class`, isHealer(cls), false);
}
{
  const byId = new Map([
    ["b", { className: "Bard" }],
    ["d", { className: "Dancer" }],
    ["a", { className: "Alchemist" }],
  ]);
  check(
    "a Bard/Dancer/Alchemist party does NOT have a priest",
    partyHasPriest({ memberIds: ["b", "d", "a"] }, byId),
    false,
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
