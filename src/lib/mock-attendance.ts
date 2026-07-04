import type {
  AttendanceMemberRec,
  AttendanceSession,
  ExpectedMember,
  GuildTarget,
} from "./attendance";
import type { Guild } from "./types";

// Local-dev fallback GvG attendance sessions, used ONLY when MONGODB_URI is
// unset (same contract as mock.ts). Never written back; never sent to Atlas.
//
// The scenario deliberately exercises every edge the derivations must handle:
//   - session A predates the roster-snapshot feature (`expected` ABSENT) — it
//     must be EXCLUDED from all rate denominators and never count anyone absent;
//   - m5 joins the roster at session D, m6 at session F → their denominators
//     start there ("since joined");
//   - m6 attends session E BEFORE joining the roster → present-uncounted;
//   - s2 (a Mummy member) sits in the Daddy VC in session C → flagged wrong-VC.
//
// Expected since-joined rates over the counted Daddy sessions (B..F):
//   m1 5/5 100% · m2 4/5 80% · m3 3/5 60% · m4 3/5 60% · m5 3/3 100% · m6 1/1 100%

const DADDY_VC = { channelId: "vc-daddy-1", label: "Daddy War Room", guild: "daddy" as Guild };
const MUMMY_VC = { channelId: "vc-mummy-1", label: "Mummy War Room", guild: "mummy" as Guild };

const NAMES: Record<string, { username: string; displayName: string }> = {
  m1: { username: "poring_lord", displayName: "Poring Lord" },
  m2: { username: "holy_mum", displayName: "Holy Mum" },
  m3: { username: "boom_boom", displayName: "Boom Boom" },
  m4: { username: "sneaky", displayName: "Sneaky" },
  m5: { username: "tinker", displayName: "Tinker" },
  m6: { username: "songbird", displayName: "Songbird" },
  s1: { username: "lil_poring", displayName: "Lil Poring" },
  s2: { username: "acolyte_jo", displayName: "Acolyte Jo" },
  s3: { username: "sparkles", displayName: "Sparkles" },
  s4: { username: "shadowfoot", displayName: "Shadowfoot" },
};

function expectedList(ids: string[]): ExpectedMember[] {
  return ids.map((id) => ({ userId: id, displayName: NAMES[id].displayName }));
}

function rec(
  id: string,
  startIso: string,
  flagged = false,
): AttendanceMemberRec {
  return {
    userId: id,
    username: NAMES[id].username,
    displayName: NAMES[id].displayName,
    onRoster: !flagged,
    flagged,
    firstSeenAt: startIso,
    lastSeenAt: startIso,
  };
}

function vcResult(
  vc: { channelId: string; label: string; guild: Guild },
  startIso: string,
  presentIds: string[],
  flaggedIds: string[] = [],
) {
  const members = [
    ...presentIds.map((id) => rec(id, startIso)),
    ...flaggedIds.map((id) => rec(id, startIso, true)),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    ...vc,
    count: members.length,
    flaggedCount: flaggedIds.length,
    members,
  };
}

function session(opts: {
  id: string;
  target: GuildTarget;
  date: string; // "YYYY-MM-DD" — window starts 21:00 GMT+7 (= 14:00 UTC)
  label: string;
  expected: Partial<Record<Guild, ExpectedMember[]>> | null;
  daddyPresent?: string[];
  daddyFlagged?: string[];
  mummyPresent?: string[];
  mummyFlagged?: string[];
}): AttendanceSession {
  const startedAt = `${opts.date}T14:00:00.000Z`; // 21:00 GMT+7
  const completedAt = `${opts.date}T15:00:00.000Z`;
  const result = [];
  if (opts.target !== "mummy") {
    result.push(
      vcResult(DADDY_VC, startedAt, opts.daddyPresent ?? [], opts.daddyFlagged),
    );
  }
  if (opts.target !== "daddy") {
    result.push(
      vcResult(MUMMY_VC, startedAt, opts.mummyPresent ?? [], opts.mummyFlagged),
    );
  }
  return {
    id: opts.id,
    guildTarget: opts.target,
    day: "Friday",
    time: "21:00",
    label: opts.label,
    durationMin: 60,
    startedAt,
    completedAt,
    rosterAvailable: true,
    expected: opts.expected,
    result,
  };
}

export const MOCK_ATTENDANCE: AttendanceSession[] = [
  // A — legacy doc, NO `expected` snapshot (pre-snapshot bot version).
  session({
    id: "gvg-mock-a",
    target: "daddy",
    date: "2026-05-22",
    label: "GvG Night",
    expected: null,
    daddyPresent: ["m1", "m2", "m3"],
  }),
  // B — first snapshot: roster is m1..m4. m4 absent.
  session({
    id: "gvg-mock-b",
    target: "daddy",
    date: "2026-05-29",
    label: "GvG Night",
    expected: { daddy: expectedList(["m1", "m2", "m3", "m4"]) },
    daddyPresent: ["m1", "m2", "m3"],
  }),
  // C — m3 absent; s2 (Mummy member) flagged in the Daddy VC (wrong VC).
  session({
    id: "gvg-mock-c",
    target: "daddy",
    date: "2026-06-05",
    label: "GvG Night",
    expected: { daddy: expectedList(["m1", "m2", "m3", "m4"]) },
    daddyPresent: ["m1", "m2", "m4"],
    daddyFlagged: ["s2"],
  }),
  // D — m5 JOINS the roster here (since-joined denominator starts). m2 absent.
  session({
    id: "gvg-mock-d",
    target: "daddy",
    date: "2026-06-12",
    label: "GvG Night",
    expected: { daddy: expectedList(["m1", "m2", "m3", "m4", "m5"]) },
    daddyPresent: ["m1", "m3", "m4", "m5"],
  }),
  // E — m6 attends BEFORE joining the roster (present-uncounted). m4 absent.
  session({
    id: "gvg-mock-e",
    target: "daddy",
    date: "2026-06-19",
    label: "GvG Night",
    expected: { daddy: expectedList(["m1", "m2", "m3", "m4", "m5"]) },
    daddyPresent: ["m1", "m2", "m3", "m5", "m6"],
  }),
  // F — m6 now ON the roster; m3 absent. Latest Daddy session.
  session({
    id: "gvg-mock-f",
    target: "daddy",
    date: "2026-06-26",
    label: "GvG Night",
    expected: { daddy: expectedList(["m1", "m2", "m3", "m4", "m5", "m6"]) },
    daddyPresent: ["m1", "m2", "m4", "m5", "m6"],
  }),
  // Mummy — one legacy doc without a snapshot…
  session({
    id: "gvg-mock-m1",
    target: "mummy",
    date: "2026-06-12",
    label: "Mummy GvG",
    expected: null,
    mummyPresent: ["s1", "s2"],
  }),
  // …and one with. s3 absent; s4 attends while not on the snapshot.
  session({
    id: "gvg-mock-m2",
    target: "mummy",
    date: "2026-06-19",
    label: "Mummy GvG",
    expected: { mummy: expectedList(["s1", "s2", "s3"]) },
    mummyPresent: ["s1", "s2", "s4"],
  }),
];
