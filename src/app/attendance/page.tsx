import { getAttendanceSessions } from "@/lib/attendance-data";
import { isMongoConfigured } from "@/lib/mongo";
import { TopNav } from "@/components/TopNav";
import {
  AttendanceTrendChart,
  RateLeaderboard,
} from "@/components/AttendanceCharts";
import {
  expectedFor,
  fmtDateTime,
  guildLeaderboard,
  guildTrend,
  latestSessionSummary,
  sessionDisplayLabel,
} from "@/lib/attendance";
import { DEFAULT_GUILD, GUILD_LABEL, isGuild, type Guild } from "@/lib/types";

// GvG attendance OVERVIEW for ONE guild (same `?guild=` pattern as every other
// page): trend of present counts per session, the latest session at a glance,
// and the per-member leaderboard by since-joined attendance rate.
//
// Data is the bot-owned `gvg_attendance` collection (completed docs, READ-ONLY).
// Sessions without an `expected` roster snapshot (older docs) contribute to the
// trend's present counts but are excluded from every rate denominator and never
// count anyone absent — they're labeled "no roster data" instead.
//
// Fully a SERVER component: the charts are deterministic inline SVG/CSS, so the
// page ships no client JS and cannot hydration-mismatch.

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  const sessions = await getAttendanceSessions(guild);
  const trend = guildTrend(sessions, guild);
  const leaderboard = guildLeaderboard(sessions, guild);
  const latest = latestSessionSummary(sessions, guild);
  const noRosterCount = sessions.filter(
    (s) => expectedFor(s, guild) === null,
  ).length;
  const avgPresent =
    trend.length > 0
      ? Math.round(
          (trend.reduce((s, t) => s + t.present, 0) / trend.length) * 10,
        ) / 10
      : 0;

  return (
    <div className="flex h-screen w-full flex-col bg-[#0a0a16] text-slate-100">
      <TopNav guild={guild} active="attendance" />

      {!isMongoConfigured && (
        <div className="shrink-0 border-b border-amber-400/40 bg-amber-950/80 px-4 py-1.5 text-center text-xs text-amber-200">
          <strong>Not configured.</strong> Mock data (in-memory) — set{" "}
          <code>MONGODB_URI</code> in <code>.env.local</code> to read real
          sessions.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1100px] space-y-6 p-6">
          <h2 className="text-sm font-bold text-slate-100">
            GvG Attendance — {GUILD_LABEL[guild]}
          </h2>

          {/* At-a-glance stats */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Sessions tracked"
              value={sessions.length}
              hint={
                noRosterCount > 0
                  ? `${noRosterCount} without roster data`
                  : "all with roster snapshots"
              }
            />
            <Stat
              label="Latest present"
              value={latest ? latest.present : "—"}
              hint={
                latest
                  ? latest.expected !== null
                    ? `of ${latest.expected} expected`
                    : "no roster data"
                  : "no sessions yet"
              }
            />
            <Stat
              label="Avg present / session"
              value={sessions.length > 0 ? avgPresent : "—"}
            />
            <Stat
              label="Tracked members"
              value={leaderboard.length}
              hint="appeared on a roster snapshot"
            />
          </div>

          {/* Trend */}
          <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
            <h3 className="mb-1 text-sm font-bold text-slate-100">
              Attendance over time
            </h3>
            <p className="mb-3 text-[11px] text-slate-500">
              Distinct members present across {GUILD_LABEL[guild]} voice
              channels, per completed session. Hover a point for details.
            </p>
            {trend.length > 0 ? (
              <AttendanceTrendChart points={trend} />
            ) : (
              <EmptyNote />
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Latest session at a glance */}
            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <h3 className="mb-3 text-sm font-bold text-slate-100">
                Latest session
              </h3>
              {latest ? (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-semibold text-slate-200">
                      {sessionDisplayLabel(latest.session)}
                    </span>
                    <span className="text-slate-500">
                      {fmtDateTime(latest.session.startedAt)} GMT+7 ·{" "}
                      {latest.session.durationMin} min
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-4">
                    <span className="text-slate-300">
                      <span className="text-lg font-bold text-slate-100">
                        {latest.present}
                      </span>{" "}
                      present
                      {latest.expected !== null && (
                        <span className="text-slate-500">
                          {" "}
                          / {latest.expected} expected
                        </span>
                      )}
                    </span>
                    {latest.flaggedCount > 0 && (
                      <span className="text-amber-300">
                        ⚠ {latest.flaggedCount} flagged (wrong VC / off-roster)
                      </span>
                    )}
                  </div>

                  <ul className="space-y-1">
                    {latest.vcs.map((vc) => (
                      <li
                        key={vc.label}
                        className="flex items-center justify-between rounded border border-indigo-500/15 bg-indigo-950/20 px-2 py-1"
                      >
                        <span className="truncate text-slate-300">
                          {vc.label}
                        </span>
                        <span className="shrink-0 tabular-nums text-slate-400">
                          {vc.count} present
                          {vc.flaggedCount > 0 && (
                            <span className="text-amber-300">
                              {" "}
                              · ⚠ {vc.flaggedCount}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                    {latest.vcs.length === 0 && (
                      <li className="text-slate-500">
                        No {GUILD_LABEL[guild]} voice channels in this session.
                      </li>
                    )}
                  </ul>

                  {latest.absent === null ? (
                    <p className="text-slate-500">
                      No roster snapshot for this session — absentees can’t be
                      determined.
                    </p>
                  ) : latest.absent.length === 0 ? (
                    <p className="text-emerald-300/90">
                      Full house — nobody on the roster missed it. 🎉
                    </p>
                  ) : (
                    <div>
                      <div className="mb-1 font-semibold text-red-300/90">
                        Absent ({latest.absent.length})
                      </div>
                      <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                        {latest.absent.map((m) => (
                          <span
                            key={m.userId}
                            className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-200/90 ring-1 ring-red-400/30"
                          >
                            {m.displayName}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <EmptyNote />
              )}
            </section>

            {/* Leaderboard */}
            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <h3 className="mb-1 text-sm font-bold text-slate-100">
                Attendance leaderboard
              </h3>
              <p className="mb-3 text-[11px] text-slate-500">
                Since-joined rate: sessions present / sessions on the roster
                snapshot. Sessions without roster data don’t count.
              </p>
              {leaderboard.length > 0 ? (
                <div className="max-h-[420px] overflow-y-auto pr-1">
                  <RateLeaderboard rows={leaderboard} />
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  No roster snapshots yet — the leaderboard fills in once the
                  bot records sessions with an expected roster.
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-indigo-400/30 bg-gradient-to-b from-[#161634] to-[#10101f] p-4">
      <div className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-slate-100">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function EmptyNote() {
  return (
    <p className="text-xs text-slate-500">
      No completed GvG sessions yet. The bot writes one after each scheduled
      capture window — check back after the next GvG.
    </p>
  );
}
