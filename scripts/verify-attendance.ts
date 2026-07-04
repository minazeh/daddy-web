// Verification harness for the GvG attendance derivations (src/lib/attendance.ts)
// against the synthetic fixture (src/lib/mock-attendance.ts). Asserts the exact
// rate math Conrad confirmed:
//   - present = distinct members across the guild's VCs;
//   - absent  = expected minus present (sessions WITHOUT `expected` never count
//     anyone absent and are excluded from every denominator);
//   - member rate is SINCE JOINED (denominator = sessions where the member is in
//     expected[guild]) — sessions before they joined the roster are excluded.
//
// Run (compiles to a temp dir outside the repo, then executes):
//   node_modules/.bin/tsc src/lib/attendance.ts src/lib/mock-attendance.ts \
//     scripts/verify-attendance.ts --outDir "$TMP/attendance-verify" \
//     --module commonjs --target es2020 --moduleResolution node --strict --skipLibCheck
//   node "$TMP/attendance-verify/scripts/verify-attendance.js"

import {
  expectedFor,
  formatRate,
  guildLeaderboard,
  guildTrend,
  latestSessionSummary,
  memberAttendance,
  presentMembers,
  sessionsForGuild,
} from "../src/lib/attendance";
import { MOCK_ATTENDANCE } from "../src/lib/mock-attendance";

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

const daddy = sessionsForGuild(MOCK_ATTENDANCE, "daddy");
const mummy = sessionsForGuild(MOCK_ATTENDANCE, "mummy");

console.log("scoping");
check("daddy session count", daddy.length, 6);
check("mummy session count", mummy.length, 2);
check("chronological order", daddy.map((s) => s.id), [
  "gvg-mock-a", "gvg-mock-b", "gvg-mock-c", "gvg-mock-d", "gvg-mock-e", "gvg-mock-f",
]);

console.log("present = distinct members across the guild's VCs");
// Session C: m1, m2, m4 on-roster + s2 flagged wrong-VC → 4 distinct present.
check("C present size (incl. flagged wrong-VC attendee)",
  presentMembers(daddy[2], "daddy").size, 4);
check("C flagged rec", presentMembers(daddy[2], "daddy").get("s2")?.flagged, true);

console.log("missing `expected` → no roster data (never absent, no denominator)");
check("A has no snapshot", expectedFor(daddy[0], "daddy"), null);
check("B has snapshot of 4", expectedFor(daddy[1], "daddy")?.length, 4);

console.log("since-joined rates (counted sessions = B..F only)");
const rates: Record<string, [number, number, number | null]> = {
  m1: [5, 5, 100], // present every counted session
  m2: [4, 5, 80],  // absent D
  m3: [3, 5, 60],  // absent C, F
  m4: [3, 5, 60],  // absent B, E
  m5: [3, 3, 100], // joined roster at D → denominator starts at D
  m6: [1, 1, 100], // joined roster at F; attended E BEFORE joining (uncounted)
};
for (const [id, [p, x, r]] of Object.entries(rates)) {
  const a = memberAttendance(daddy, "daddy", id);
  check(`${id} present/expected/rate`, [a.presentCount, a.expectedCount, a.ratePct], [p, x, r]);
}
check("m1 rate label", formatRate(memberAttendance(daddy, "daddy", "m1")), "5/5 · 100%");

console.log("member history rows");
const m6 = memberAttendance(daddy, "daddy", "m6");
check("m6 rows: A no-data, E uncounted, F present",
  m6.rows.map((r) => [r.sessionId, r.status, r.counted]),
  [
    ["gvg-mock-a", "no-data", false],
    ["gvg-mock-e", "present-uncounted", false],
    ["gvg-mock-f", "present", true],
  ]);
const m5 = memberAttendance(daddy, "daddy", "m5");
check("m5 rows skip pre-join snapshot sessions (B, C)",
  m5.rows.map((r) => r.sessionId),
  ["gvg-mock-a", "gvg-mock-d", "gvg-mock-e", "gvg-mock-f"]);
check("m5 A row is no-data (legacy session, not seen)", m5.rows[0].status, "no-data");
const m2 = memberAttendance(daddy, "daddy", "m2");
check("m2 D row is absent + counted",
  m2.rows.filter((r) => r.sessionId === "gvg-mock-d").map((r) => [r.status, r.counted]),
  [["absent", true]]);
check("m2 A row is present-uncounted (legacy session, seen)",
  m2.rows[0].status, "present-uncounted");

console.log("wrong-VC flag surfaces on the flagged member's history");
const s2daddy = memberAttendance(daddy, "daddy", "s2");
check("s2 C row: present-uncounted + flagged + VC label",
  s2daddy.rows.map((r) => [r.sessionId, r.status, r.flagged, r.vcLabel]),
  [
    ["gvg-mock-a", "no-data", false, null],
    ["gvg-mock-c", "present-uncounted", true, "Daddy War Room"],
  ]);

console.log("trend");
check("daddy trend presents", guildTrend(daddy, "daddy").map((t) => t.present),
  [3, 3, 4, 4, 5, 5]);
check("daddy trend expecteds", guildTrend(daddy, "daddy").map((t) => t.expected),
  [null, 4, 4, 5, 5, 6]);

console.log("leaderboard (rate desc, expected desc, name)");
check("daddy leaderboard",
  guildLeaderboard(daddy, "daddy").map((r) => [r.userId, r.ratePct, `${r.presentCount}/${r.expectedCount}`]),
  [
    ["m1", 100, "5/5"],
    ["m5", 100, "3/3"],
    ["m6", 100, "1/1"],
    ["m2", 80, "4/5"],
    ["m3", 60, "3/5"], // Boom Boom before Sneaky on the 60% tie
    ["m4", 60, "3/5"],
  ]);
check("mummy leaderboard universe = snapshot members only (never s4)",
  guildLeaderboard(mummy, "mummy").map((r) => r.userId).sort(),
  ["s1", "s2", "s3"]);
check("s3 is 0/1 · 0% (expected, never present)",
  guildLeaderboard(mummy, "mummy").find((r) => r.userId === "s3")?.ratePct, 0);

console.log("latest session summary");
const latest = latestSessionSummary(daddy, "daddy");
check("latest is F", latest?.session.id, "gvg-mock-f");
check("latest present/expected", [latest?.present, latest?.expected], [5, 6]);
check("latest absent = expected minus present", latest?.absent?.map((m) => m.userId), ["m3"]);
const latestLegacy = latestSessionSummary([daddy[0]], "daddy");
check("legacy latest: expected/absent are null (never 'everyone absent')",
  [latestLegacy?.expected, latestLegacy?.absent], [null, null]);
check("empty guild → null summary", latestSessionSummary([], "daddy"), null);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
