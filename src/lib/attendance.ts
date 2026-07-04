import type { Guild } from "./types";

// GvG attendance domain model + PURE derivations. No I/O here — this module is
// imported by BOTH server code (attendance-data.ts) and client components (the
// member modal computes histories in the browser), so it must stay isomorphic
// and deterministic (SSR output === first client render, byte for byte).
//
// Source collection: `gvg_attendance` (owned/written by the Discord bot; STRICTLY
// read-only here). One completed doc per fired capture window:
//
//   { status:'completed', schedule:{ day, time /*HH:MM GMT+7*/, guild, durationMin,
//     label }, startedAt, endsAt, completedAt, rosterAvailable,
//     expected?: { daddy?: [{userId,displayName}], mummy?: [...] },   // roster
//       // snapshot taken at capture START, per targeted guild. NEWER docs only —
//       // may be ABSENT on older docs; treat those as "no roster data".
//     vcs: [{ channelId, label, guild }],
//     result: [{ channelId, label, guild, count, flaggedCount,
//                members: [{ userId, username, displayName, onRoster, flagged,
//                            firstSeenAt, lastSeenAt }] }] }
//
// Conrad's confirmed derivation rules:
//   PRESENT (session, guild)  = distinct members across that guild's VCs in result.
//   ABSENT  (session, guild)  = expected[guild] minus present. A session WITHOUT
//     an expected[guild] snapshot has no roster data: it is EXCLUDED from every
//     rate denominator and never counts anyone absent.
//   MEMBER RATE (since joined) = (# sessions present) / (# sessions where the
//     member appears in expected[theirGuild]). Members only appear in `expected`
//     from when they joined the roster, so the denominator is naturally
//     "since joined". Shown as "8/10 · 80%".

export type GuildTarget = Guild | "both";

export interface ExpectedMember {
  userId: string;
  displayName: string;
}

// One attendee record inside a VC result (serialized; dates are ISO strings).
export interface AttendanceMemberRec {
  userId: string;
  username: string;
  displayName: string;
  onRoster: boolean | null; // null ⇒ roster store was down during that capture
  flagged: boolean; // true ⇒ not on that VC's guild roster (wrong-VC / off-roster)
  firstSeenAt: string; // ISO
  lastSeenAt: string; // ISO
}

export interface AttendanceVcResult {
  channelId: string;
  label: string;
  guild: Guild;
  count: number;
  flaggedCount: number;
  members: AttendanceMemberRec[];
}

// A COMPLETED capture session, serialized client-safe (no ObjectId, no Date).
export interface AttendanceSession {
  id: string;
  guildTarget: GuildTarget; // schedule.guild — which guild(s) this window checked
  day: string;
  time: string; // "HH:MM" GMT+7 (bot timezone)
  label: string | null;
  durationMin: number;
  startedAt: string; // ISO
  completedAt: string; // ISO
  rosterAvailable: boolean;
  // Roster snapshot at capture start, keyed by guild. `null` ⇒ the doc predates
  // the snapshot feature (or carried no usable snapshot) — "no roster data".
  expected: Partial<Record<Guild, ExpectedMember[]>> | null;
  result: AttendanceVcResult[];
}

// ---- basic scoping helpers ----

export function sessionTargetsGuild(s: AttendanceSession, g: Guild): boolean {
  return s.guildTarget === g || s.guildTarget === "both";
}

// Sessions relevant to ONE guild, oldest → newest (chronological, deterministic:
// startedAt then id as a unique tiebreaker).
export function sessionsForGuild(
  sessions: AttendanceSession[],
  g: Guild,
): AttendanceSession[] {
  return sessions
    .filter((s) => sessionTargetsGuild(s, g))
    .sort((a, b) => {
      const t = a.startedAt.localeCompare(b.startedAt);
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });
}

// The expected-roster snapshot for a guild, or null when this session carries
// no snapshot for it (older doc / roster store down at capture start).
export function expectedFor(
  s: AttendanceSession,
  g: Guild,
): ExpectedMember[] | null {
  const arr = s.expected?.[g];
  return Array.isArray(arr) ? arr : null;
}

// ---- present / seen ----

export interface PresentRec {
  userId: string;
  displayName: string;
  username: string;
  flagged: boolean; // flagged in at least one VC they were seen in
  vcLabels: string[]; // every VC label they were seen in (this scope)
}

function collect(
  vcs: AttendanceVcResult[],
): Map<string, PresentRec> {
  const map = new Map<string, PresentRec>();
  for (const vc of vcs) {
    for (const m of vc.members) {
      const prev = map.get(m.userId);
      if (prev) {
        prev.flagged = prev.flagged || m.flagged;
        if (!prev.vcLabels.includes(vc.label)) prev.vcLabels.push(vc.label);
      } else {
        map.set(m.userId, {
          userId: m.userId,
          displayName: m.displayName,
          username: m.username,
          flagged: m.flagged,
          vcLabels: [vc.label],
        });
      }
    }
  }
  return map;
}

// PRESENT for (session, guild): distinct members across that guild's VCs.
export function presentMembers(
  s: AttendanceSession,
  g: Guild,
): Map<string, PresentRec> {
  return collect(s.result.filter((vc) => vc.guild === g));
}

// Everyone seen in ANY VC of the session (both guilds) — used to surface
// "seen in <other VC>" info on a member's history row.
export function seenMembers(s: AttendanceSession): Map<string, PresentRec> {
  return collect(s.result);
}

// ---- member history + since-joined rate ----

export type MemberSessionStatus =
  | "present" // expected + present → counts 1/1
  | "absent" // expected + not present → counts 0/1
  | "present-uncounted" // present but NOT in the snapshot (not on roster yet /
  //                       filler) or session has no snapshot — excluded from rate
  | "no-data"; // session has no roster snapshot and member wasn't seen — excluded

export interface MemberSessionRow {
  sessionId: string;
  date: string; // ISO startedAt
  sessionLabel: string; // schedule label or "day time" fallback
  vcLabel: string | null; // where they were seen (any VC, either guild), or null
  status: MemberSessionStatus;
  counted: boolean; // participates in the rate denominator
  flagged: boolean; // ⚠ seen flagged (wrong-VC / off-roster) somewhere this session
}

export interface MemberAttendance {
  rows: MemberSessionRow[]; // chronological, oldest → newest
  presentCount: number; // numerator
  expectedCount: number; // denominator (sessions with the member in expected[g])
  ratePct: number | null; // null when expectedCount === 0 (no roster data yet)
}

export function sessionDisplayLabel(s: AttendanceSession): string {
  return s.label ?? `${s.day} ${s.time}`;
}

// Session-by-session record + since-joined rate for ONE member in ONE guild.
// `sessions` must already be scoped to the guild (sessionsForGuild).
//   - expected + present        → "present"            (1/1)
//   - expected + not present    → "absent"             (0/1)
//   - present, not in snapshot  → "present-uncounted"  (excluded)
//   - present, no snapshot      → "present-uncounted"  (excluded)
//   - no snapshot, not seen     → "no-data" row        (excluded)
//   - has snapshot, not in it, not seen → NO row (before they joined / after left)
export function memberAttendance(
  sessions: AttendanceSession[],
  g: Guild,
  userId: string,
): MemberAttendance {
  const rows: MemberSessionRow[] = [];
  let presentCount = 0;
  let expectedCount = 0;

  for (const s of sessions) {
    const snap = expectedFor(s, g);
    const expectedIn = snap?.some((e) => e.userId === userId) ?? false;
    const present = presentMembers(s, g).has(userId);
    const seen = seenMembers(s).get(userId);

    let status: MemberSessionStatus;
    let counted = false;
    if (snap === null) {
      if (!present && !seen) {
        status = "no-data";
      } else {
        status = "present-uncounted";
      }
    } else if (expectedIn) {
      counted = true;
      expectedCount++;
      if (present) {
        presentCount++;
        status = "present";
      } else {
        status = "absent";
      }
    } else if (present || seen) {
      status = "present-uncounted";
    } else {
      continue; // not on the snapshot and not seen — before joined / after left
    }

    rows.push({
      sessionId: s.id,
      date: s.startedAt,
      sessionLabel: sessionDisplayLabel(s),
      vcLabel: seen ? seen.vcLabels.join(", ") : null,
      status,
      counted,
      flagged: Boolean(seen?.flagged),
    });
  }

  return {
    rows,
    presentCount,
    expectedCount,
    ratePct:
      expectedCount > 0
        ? Math.round((presentCount / expectedCount) * 100)
        : null,
  };
}

// "8/10 · 80%" (or a placeholder when the member has no counted sessions yet).
export function formatRate(a: {
  presentCount: number;
  expectedCount: number;
  ratePct: number | null;
}): string {
  if (a.ratePct === null) return "no roster data";
  return `${a.presentCount}/${a.expectedCount} · ${a.ratePct}%`;
}

// ---- guild overview: trend, leaderboard, latest session ----

export interface TrendPoint {
  sessionId: string;
  date: string; // ISO startedAt
  sessionLabel: string;
  present: number; // distinct members across the guild's VCs
  expected: number | null; // snapshot size, or null (no roster data)
}

// Present count per session over time (chronological). Input pre-scoped.
export function guildTrend(
  sessions: AttendanceSession[],
  g: Guild,
): TrendPoint[] {
  return sessions.map((s) => {
    const snap = expectedFor(s, g);
    return {
      sessionId: s.id,
      date: s.startedAt,
      sessionLabel: sessionDisplayLabel(s),
      present: presentMembers(s, g).size,
      expected: snap ? snap.length : null,
    };
  });
}

export interface LeaderboardRow {
  userId: string;
  displayName: string;
  presentCount: number;
  expectedCount: number;
  ratePct: number; // expectedCount is always > 0 here
}

// Per-member leaderboard by since-joined rate. Universe = every member that
// appears in ANY expected[g] snapshot (names refreshed from the newest snapshot
// they appear in). Deterministic order: rate desc, expected desc, name, userId.
export function guildLeaderboard(
  sessions: AttendanceSession[],
  g: Guild,
): LeaderboardRow[] {
  const names = new Map<string, string>();
  for (const s of sessions) {
    // sessions are chronological, so later snapshots overwrite → newest name.
    for (const e of expectedFor(s, g) ?? []) {
      names.set(e.userId, e.displayName);
    }
  }
  const rows: LeaderboardRow[] = [];
  for (const [userId, displayName] of names) {
    const a = memberAttendance(sessions, g, userId);
    if (a.expectedCount === 0 || a.ratePct === null) continue; // unreachable, defensive
    rows.push({
      userId,
      displayName,
      presentCount: a.presentCount,
      expectedCount: a.expectedCount,
      ratePct: a.ratePct,
    });
  }
  rows.sort((a, b) => {
    if (a.ratePct !== b.ratePct) return b.ratePct - a.ratePct;
    if (a.expectedCount !== b.expectedCount)
      return b.expectedCount - a.expectedCount;
    const n = a.displayName.localeCompare(b.displayName);
    return n !== 0 ? n : a.userId.localeCompare(b.userId);
  });
  return rows;
}

export interface SessionSummary {
  session: AttendanceSession;
  present: number;
  expected: number | null; // null ⇒ no roster snapshot
  absent: ExpectedMember[] | null; // expected minus present; null ⇒ no snapshot
  flaggedCount: number; // flagged attendees across the guild's VCs
  vcs: { label: string; count: number; flaggedCount: number }[];
}

// The most recent session at a glance (or null when none yet). Input pre-scoped
// + chronological, so the latest is simply the last element.
export function latestSessionSummary(
  sessions: AttendanceSession[],
  g: Guild,
): SessionSummary | null {
  const s = sessions[sessions.length - 1];
  if (!s) return null;
  const present = presentMembers(s, g);
  const snap = expectedFor(s, g);
  const absent = snap
    ? snap
        .filter((e) => !present.has(e.userId))
        .sort((a, b) => {
          const n = a.displayName.localeCompare(b.displayName);
          return n !== 0 ? n : a.userId.localeCompare(b.userId);
        })
    : null;
  const guildVcs = s.result.filter((vc) => vc.guild === g);
  return {
    session: s,
    present: present.size,
    expected: snap ? snap.length : null,
    absent,
    flaggedCount: guildVcs.reduce((n, vc) => n + vc.flaggedCount, 0),
    vcs: guildVcs.map((vc) => ({
      label: vc.label,
      count: vc.count,
      flaggedCount: vc.flaggedCount,
    })),
  };
}

// ---- deterministic date formatting (GMT+7, the bot's GvG timezone) ----
// NEVER use toLocaleString in shared components: the server and the browser can
// sit in different timezones/locales, which would make SSR HTML differ from the
// first client render (hydration mismatch). These helpers are pure UTC math on
// the ISO string shifted to GMT+7, identical everywhere.

const GVG_TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function shifted(iso: string): Date {
  return new Date(new Date(iso).getTime() + GVG_TZ_OFFSET_MS);
}

// "Jun 14"
export function fmtDateShort(iso: string): string {
  const d = shifted(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// "Jun 14, 21:03" (GMT+7)
export function fmtDateTime(iso: string): string {
  const d = shifted(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm}`;
}
