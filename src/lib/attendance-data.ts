import "server-only";
import { getDb, isMongoConfigured } from "./mongo";
import { MOCK_ATTENDANCE } from "./mock-attendance";
import {
  sessionsForGuild,
  type AttendanceMemberRec,
  type AttendanceSession,
  type AttendanceVcResult,
  type ExpectedMember,
  type GuildTarget,
} from "./attendance";
import type { Guild } from "./types";

// Server-side reader for the bot-owned `gvg_attendance` collection.
// STRICTLY READ-ONLY: this app never writes, updates, or indexes it — the
// Discord bot owns the collection end to end. We read COMPLETED docs only.
//
// Serialization is defensive throughout: `expected` may be ABSENT on older docs
// (pre-snapshot bot versions) → null ("no roster data" — excluded from rate
// denominators); `result` arrays are normalized field by field so one malformed
// doc can't take a page down.

const ATTENDANCE = "gvg_attendance";

// Attendance before this instant is hidden from the dashboard (bot records are
// untouched — this is a reversible read filter). July 7, 2026 00:00 GMT+7 (the
// bot's GvG timezone) = 2026-07-06T17:00:00Z. Change/remove this to adjust/undo.
export const ATTENDANCE_CUTOFF_ISO = "2026-07-06T17:00:00.000Z";

// Loose doc shape as written by the bot (dates are Mongo Dates; _id ObjectId).
interface AttendanceDoc {
  _id: { toString(): string };
  status?: string;
  schedule?: {
    day?: string;
    time?: string;
    guild?: string;
    durationMin?: number;
    label?: string | null;
  };
  startedAt?: Date | string;
  completedAt?: Date | string;
  rosterAvailable?: boolean;
  expected?: Record<string, unknown>;
  result?: unknown;
}

function toIso(v: Date | string | undefined): string {
  if (!v) return new Date(0).toISOString();
  return typeof v === "string" ? v : v.toISOString();
}

function toGuildTarget(v: unknown): GuildTarget {
  return v === "daddy" || v === "mummy" || v === "both" ? v : "both";
}

function serializeExpectedList(v: unknown): ExpectedMember[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter(
      (e): e is { userId: unknown; displayName?: unknown } =>
        typeof e === "object" && e !== null && "userId" in e,
    )
    .map((e) => ({
      userId: String(e.userId),
      displayName: String(e.displayName ?? e.userId),
    }));
}

// `expected` → the serialized snapshot, or null when the doc predates the
// feature / carries no usable per-guild list ("no roster data").
function serializeExpected(
  v: Record<string, unknown> | undefined,
): AttendanceSession["expected"] {
  if (!v || typeof v !== "object") return null;
  const out: Partial<Record<Guild, ExpectedMember[]>> = {};
  const daddy = serializeExpectedList(v.daddy);
  const mummy = serializeExpectedList(v.mummy);
  if (daddy) out.daddy = daddy;
  if (mummy) out.mummy = mummy;
  return daddy || mummy ? out : null;
}

function serializeMemberRec(m: Record<string, unknown>): AttendanceMemberRec {
  return {
    userId: String(m.userId ?? ""),
    username: String(m.username ?? ""),
    displayName: String(m.displayName ?? m.username ?? m.userId ?? "?"),
    onRoster: typeof m.onRoster === "boolean" ? m.onRoster : null,
    flagged: Boolean(m.flagged),
    firstSeenAt: toIso(m.firstSeenAt as Date | string | undefined),
    lastSeenAt: toIso(m.lastSeenAt as Date | string | undefined),
  };
}

function serializeResult(v: unknown): AttendanceVcResult[] {
  if (!Array.isArray(v)) return [];
  const out: AttendanceVcResult[] = [];
  for (const vc of v) {
    if (typeof vc !== "object" || vc === null) continue;
    const r = vc as Record<string, unknown>;
    const guild = r.guild === "mummy" ? "mummy" : "daddy";
    const members = Array.isArray(r.members)
      ? r.members
          .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
          .map(serializeMemberRec)
          .filter((m) => m.userId !== "")
      : [];
    out.push({
      channelId: String(r.channelId ?? ""),
      label: String(r.label ?? "Voice channel"),
      guild,
      count: typeof r.count === "number" ? r.count : members.length,
      flaggedCount:
        typeof r.flaggedCount === "number"
          ? r.flaggedCount
          : members.filter((m) => m.flagged).length,
      members,
    });
  }
  return out;
}

function serializeSession(d: AttendanceDoc): AttendanceSession {
  const s = d.schedule ?? {};
  return {
    id: String(d._id),
    guildTarget: toGuildTarget(s.guild),
    day: String(s.day ?? ""),
    time: String(s.time ?? ""),
    label: s.label ?? null,
    durationMin: typeof s.durationMin === "number" ? s.durationMin : 0,
    startedAt: toIso(d.startedAt),
    completedAt: toIso(d.completedAt),
    rosterAvailable: Boolean(d.rosterAvailable),
    expected: serializeExpected(d.expected),
    result: serializeResult(d.result),
  };
}

// COMPLETED sessions relevant to ONE guild (schedule.guild === guild or 'both'),
// oldest → newest. Mock mode serves the synthetic fixture (never writes).
export async function getAttendanceSessions(
  guild: Guild,
): Promise<AttendanceSession[]> {
  if (!isMongoConfigured) {
    return sessionsForGuild(MOCK_ATTENDANCE, guild).filter(
      (s) => s.startedAt >= ATTENDANCE_CUTOFF_ISO,
    );
  }
  const db = await getDb();
  const docs = await db
    .collection<AttendanceDoc>(ATTENDANCE)
    .find({
      status: "completed",
      "schedule.guild": { $in: [guild, "both"] },
    })
    .sort({ startedAt: 1, _id: 1 })
    .toArray();
  // Re-scope + re-sort through the shared helper so Mongo and mock paths agree.
  // The cutoff filter runs on the serialized ISO string (source of truth — the
  // Mongo field may be stored as a Date or a string, so a query-level type
  // comparison would be unreliable) and is applied identically to both paths.
  return sessionsForGuild(docs.map(serializeSession), guild).filter(
    (s) => s.startedAt >= ATTENDANCE_CUTOFF_ISO,
  );
}
