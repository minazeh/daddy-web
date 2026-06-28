import { getMembersForManagement, getParties, getSettings } from "@/lib/data";
import { isMongoConfigured } from "@/lib/mongo";
import { MembersDashboard } from "@/components/MembersDashboard";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Member management page. Same per-guild pattern (one guild via `?guild=`).
// Two-pane: a LEFT member list (search + sort) and a RIGHT analytics dashboard,
// both over ACTIVE members (joined with power) + DEPARTED members (memberMeta
// rows whose userId is no longer in `members`) for the selected guild. Clicking
// a member opens an editable Power Rating modal.
//
// `getMembersForManagement` upserts memberMeta for every current member on load
// (refresh cached fields + lastSeenAt; power=0 for new; never overwrite power).

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ guild?: string }>;
}) {
  const { guild: guildParam } = await searchParams;
  const guild: Guild = isGuild(guildParam) ? guildParam : DEFAULT_GUILD;

  const [managed, parties, settings] = await Promise.all([
    getMembersForManagement(guild),
    getParties(guild),
    getSettings(),
  ]);

  // `assignedMemberIds` = userIds currently sitting in a party (for Assigned vs
  // Bench). `partyCount` backs the Priest-coverage denominator.
  const assignedMemberIds = [...new Set(parties.flatMap((p) => p.memberIds))];

  return (
    <MembersDashboard
      key={guild}
      guild={guild}
      members={managed}
      partyCount={parties.length}
      assignedMemberIds={assignedMemberIds}
      settings={settings}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
