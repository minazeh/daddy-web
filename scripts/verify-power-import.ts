// BEHAVIOUR PIN for the CSV power importer (src/lib/power-import.ts).
//
// WHY THIS EXISTS: the three-tier IGN matcher was about to be extracted into a
// shared module (src/lib/name-match.ts) so the polarity DPS ranking importer
// could reuse it instead of copying it. An extraction is only safe if the CSV
// importer's behaviour is provably identical afterwards, and there was no test
// of it at all. So this file was written and run FIRST, against the
// pre-refactor code, and the EXPECTED block below is the digest that run
// produced. Post-refactor the digest must still match, byte for byte.
//
// It pins, deliberately, every path the matcher can take:
//   exact (canonical), fold/homoglyph, fold/diacritic, member-side separator
//   prefix, CSV-side separator prefix, Discord username, containment, bigram
//   similarity, ambiguous duplicate display names, cross-guild reporting,
//   unmatched, and all four malformed-row reasons — plus the clamp notes, the
//   headerless two-column fallback, and planApply's skip reasons.
//
// Run (compiles to a temp dir outside the repo, then executes):
//   node_modules/.bin/tsc src/lib/types.ts src/lib/power-import.ts \
//     scripts/verify-power-import.ts --outDir "$TMP/power-import-verify" \
//     --module commonjs --target es2020 --moduleResolution node --strict --skipLibCheck
//   node "$TMP/power-import-verify/scripts/verify-power-import.js"

import {
  buildPreview,
  planApply,
  unresolvedAsTsv,
  type ImportDecision,
  type PreviewRow,
  type RosterMember,
} from "../src/lib/power-import";

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

function member(
  userId: string,
  displayName: string,
  username: string,
  className: string | null,
  power: number,
): RosterMember {
  return { userId, displayName, username, className, power };
}

// ---------------------------------------------------------------------------
// Fixture — one roster member per matching path, plus a cross-guild roster.
// ---------------------------------------------------------------------------

const DADDY: RosterMember[] = [
  member("d1", "Solar", "solar", "Paladin", 100),
  member("d2", "DuckyO", "duckyo", "Hunter", 200),
  member("d3", "Apollo", "apollo", "Wizard", 300), // homoglyph target (ApoIIo)
  member("d4", "Skylash", "skylash", "Hunter", 400), // diacritic target (Skÿlash)
  member("d5", "Oppades | Gem", "oppades", "Monk", 500), // member-side separator
  member("d6", "Mintz", "mintz", "Assassin", 600), // CSV-side separator
  member("d7", "Q", "quixote", "Knight", 700), // username hit
  member("d8", "MournWrath", "mournwrath", "Blacksmith", 800), // containment
  member("d9", "Darasaki", "darasaki", "Priest", 900), // bigram similarity
  member("d10", "Twin", "twin_a", "Druid", 10), // ambiguous pair
  member("d11", "Twin", "twin_b", "Druid", 20), // ambiguous pair
  member("d12", "Capper", "capper", "Monk", 30), // clamp note
  member("d13", "Rounder", "rounder", "Monk", 40), // round-down note
  member("d14", "Untouched", "untouched", "Monk", 50), // never in the CSV
];

const MUMMY: RosterMember[] = [member("s1", "MummyOnly", "mummyonly", "Knight", 60)];

const CSV = [
  "IGN,Power",
  "Solar,1000", // exact
  "  duckyo  ,2000", // exact after canonicalisation (case + whitespace)
  "ApoIIo,3000", // fold: capital-I homoglyphs for ll
  "Skÿlash,4000", // fold: diacritic
  "Oppades,5000", // member name carries " | Gem"
  "Mintz | Guildie,6000", // CSV name carries the decoration
  "quixote,7000", // Discord username
  "Mourn,8000", // containment (Mourn ⊂ MournWrath)
  "Darasakii,9000", // bigram similarity
  "Twin,1234", // two members share this display name
  "MummyOnly,4321", // belongs to the OTHER guild
  "ZZZNobody,5555", // no candidate at all
  "Capper,2000000", // clamped to 1,000,000
  "Rounder,123.7", // rounded down to 123
  ",500", // blank IGN
  "NoPower,", // blank power
  "BadNum,abc", // not a number
  "Negative,-5", // negative
  "Solar,111", // duplicate IGN
].join("\n");

// ---------------------------------------------------------------------------
// Preview — the full digest, one line per row.
// ---------------------------------------------------------------------------

const preview = buildPreview("daddy", CSV, DADDY, MUMMY);

function digest(r: PreviewRow): string {
  const cands = r.candidates
    .map((c) => `${c.userId}@${c.score.toFixed(2)}:${c.reason}`)
    .join("|");
  return [
    r.rowNumber,
    r.line,
    r.rawName,
    r.power,
    r.note ?? "-",
    r.tier,
    r.userId ?? "-",
    cands || "-",
    r.reason ?? "-",
    r.crossGuild ? `${r.crossGuild.userId}/${r.crossGuild.via}` : "-",
  ].join(" ; ");
}

console.log("preview — header resolution + counts");
check("ok", preview.ok, true);
check("counts", preview.counts, {
  total: 19,
  exact: 4,
  suggested: 8,
  unmatched: 2,
  error: 5,
  crossGuild: 1,
});

console.log("preview — per-row digest (the behaviour pin)");
const EXPECTED_ROWS: string[] = [
  "1 ; 2 ; Solar ; 1000 ; - ; exact ; d1 ; - ; - ; -",
  "2 ; 3 ; duckyo ; 2000 ; - ; exact ; d2 ; - ; - ; -",
  "3 ; 4 ; ApoIIo ; 3000 ; - ; suggested ; d3 ; d3@0.97:same name after homoglyph/diacritic folding ; Not an exact name match — same name after homoglyph/diacritic folding. Confirm before applying. ; -",
  "4 ; 5 ; Skÿlash ; 4000 ; - ; suggested ; d4 ; d4@0.97:same name after homoglyph/diacritic folding ; Not an exact name match — same name after homoglyph/diacritic folding. Confirm before applying. ; -",
  "5 ; 6 ; Oppades ; 5000 ; - ; suggested ; d5 ; d5@0.92:member name has extra text after a separator ; Not an exact name match — member name has extra text after a separator. Confirm before applying. ; -",
  "6 ; 7 ; Mintz | Guildie ; 6000 ; - ; suggested ; d6 ; d6@0.92:CSV name has extra text after a separator ; Not an exact name match — CSV name has extra text after a separator. Confirm before applying. ; -",
  "7 ; 8 ; quixote ; 7000 ; - ; suggested ; d7 ; d7@0.85:matches the Discord username ; Not an exact name match — matches the Discord username. Confirm before applying. ; -",
  "8 ; 9 ; Mourn ; 8000 ; - ; suggested ; d8 ; d8@0.80:one name contains the other ; Not an exact name match — one name contains the other. Confirm before applying. ; -",
  "9 ; 10 ; Darasakii ; 9000 ; - ; suggested ; d9 ; d9@0.93:93% similar ; Not an exact name match — 93% similar. Confirm before applying. ; -",
  "10 ; 11 ; Twin ; 1234 ; - ; suggested ; - ; d10@1.00:exact name (ambiguous)|d11@1.00:exact name (ambiguous) ; 2 members share this name — pick one. ; -",
  "11 ; 12 ; MummyOnly ; 4321 ; - ; unmatched ; - ; - ; Matches Mummy member \"MummyOnly\" — not imported (you are importing Daddy). ; s1/exact",
  "12 ; 13 ; ZZZNobody ; 5555 ; - ; unmatched ; - ; - ; No member of this guild found — pick a member or skip. ; -",
  "13 ; 14 ; Capper ; 1000000 ; Capped at 1,000,000. ; exact ; d12 ; - ; - ; -",
  "14 ; 15 ; Rounder ; 123 ; Rounded down from 123.7. ; exact ; d13 ; - ; - ; -",
  "15 ; 16 ;  ;  ; - ; error ; - ; - ; IGN is blank. ; -",
  "16 ; 17 ; NoPower ;  ; - ; error ; - ; - ; Power is blank. ; -",
  "17 ; 18 ; BadNum ;  ; - ; error ; - ; - ; \"abc\" is not a number. ; -",
  "18 ; 19 ; Negative ;  ; - ; error ; - ; - ; Power cannot be negative. ; -",
  "19 ; 20 ; Solar ; 111 ; - ; error ; - ; - ; Duplicate IGN — already imported on row 1. ; -",
];
check("row digests", preview.rows.map(digest), EXPECTED_ROWS);

console.log("preview — unresolved TSV export");
check(
  "unresolvedAsTsv",
  unresolvedAsTsv(preview.rows).split("\n").length,
  8, // header + 2 unmatched + 5 malformed
);

console.log("preview — headerless two-column fallback");
const bare = buildPreview("daddy", "Solar,1000\nDuckyO,2000", DADDY, MUMMY);
check("bare ok", bare.ok, true);
check("bare counts", [bare.counts.total, bare.counts.exact], [2, 2]);
check("bare row 1 line", bare.rows[0].line, 1);

console.log("preview — hard failures");
check("empty text", buildPreview("daddy", "", DADDY, MUMMY).message, "No CSV content.");
check(
  "unrecognised header",
  buildPreview("daddy", "a,b,c\n1,2,3", DADDY, MUMMY).message,
  'Could not find an "IGN" and a "Power" column. Expected a header row like `IGN,Power`.',
);
check(
  "header only",
  buildPreview("daddy", "IGN,Power", DADDY, MUMMY).message,
  "The file has a header but no data rows.",
);

console.log("preview — delimiters");
check(
  "semicolon",
  buildPreview("daddy", "IGN;Power\nSolar;77", DADDY, MUMMY).rows[0].power,
  77,
);
check(
  "tab",
  buildPreview("daddy", "IGN\tPower\nSolar\t88", DADDY, MUMMY).rows[0].power,
  88,
);

// ---------------------------------------------------------------------------
// planApply — the server-side validation gate.
// ---------------------------------------------------------------------------

console.log("planApply");
const decisions: ImportDecision[] = [
  { rowNumber: 1, userId: "d1", power: 1000 }, // real change
  { rowNumber: 2, userId: "d2", power: 200 }, // already 200 -> unchanged
  { rowNumber: 3, userId: "d1", power: 999 }, // duplicate target
  { rowNumber: 4, userId: "s1", power: 5 }, // other guild
  { rowNumber: 5, userId: "nope", power: 5 }, // unknown member
  { rowNumber: 6, userId: "", power: 5 }, // no selection
];
const plan = planApply("daddy", decisions, DADDY, new Set(MUMMY.map((m) => m.userId)));
check(
  "writes",
  plan.writes.map((w) => [w.userId, w.from, w.power]),
  [["d1", 100, 1000]],
);
check(
  "unchanged",
  plan.unchanged.map((u) => u.userId),
  ["d2"],
);
check(
  "skipped",
  plan.skipped.map((s) => [s.rowNumber, s.userId, s.reason]),
  [
    [3, "d1", "duplicate-target"],
    [4, "s1", "not-in-guild"],
    [5, "nope", "unknown-member"],
    [6, "", "invalid"],
  ],
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
