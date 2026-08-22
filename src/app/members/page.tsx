import { getMembersForManagement, getParties, getSettings } from "@/lib/data";
import { getAttendanceSessions } from "@/lib/attendance-data";
import { buildAttendanceDigest } from "@/lib/attendance";
import { isMongoConfigured } from "@/lib/mongo";
import { MembersDashboard } from "@/components/MembersDashboard";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Member management page. Same per-guild pattern (one guild via `?guild=`).
// Two-pane: a LEFT member list (search + sort) and a RIGHT analytics dashboard,
// both over ACTIVE members (joined with power) + DEPARTED members (memberMeta
// rows whose userId is no longer in `members`) for the selected guild. Clicking
// a member opens an editable Power Rating modal.
//
// `getMembersForManagement` is a PURE READ: live roster fields joined with the
// stored power ratings. It no longer upserts memberMeta on load — that sync is
// the `syncRoster` action behind the Sync roster button.
//
// Attendance is AGGREGATED HERE, on the server. The raw `gvg_attendance` docs
// are 1.29 MB; passing them into the client dashboard made this route's RSC
// payload 891 KB against ~60 KB everywhere else. `buildAttendanceDigest`
// derives exactly what the dashboard renders and ships that instead — same
// pattern /attendance already uses.

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  const [managed, parties, settings, attendanceSessions] = await Promise.all([
    getMembersForManagement(guild),
    getParties(guild),
    getSettings(),
    // Completed GvG sessions for this guild (bot-owned, read-only) — backs the
    // per-member attendance history + since-joined rate in the detail modal.
    getAttendanceSessions(guild),
  ]);

  // `assignedMemberIds` = userIds currently sitting in a party (for Assigned vs
  // Bench). `partyCount` backs the Priest-coverage denominator.
  const assignedMemberIds = [...new Set(parties.flatMap((p) => p.memberIds))];

  // Per-member histories + the latest trend point, derived once here for every
  // member the dashboard can show (active AND departed — the modal opens on
  // both), and packed for the wire.
  const attendance = buildAttendanceDigest(
    attendanceSessions,
    guild,
    managed.map((m) => m.userId),
  );

  return (
    <MembersDashboard
      key={guild}
      guild={guild}
      members={managed}
      partyCount={parties.length}
      assignedMemberIds={assignedMemberIds}
      settings={settings}
      attendance={attendance}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
