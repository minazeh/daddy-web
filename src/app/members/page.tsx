import { getMembersForManagement, getParties } from "@/lib/data";
import { isMongoConfigured } from "@/lib/mongo";
import { MembersDashboard } from "@/components/MembersDashboard";
import { DEFAULT_GUILD, isGuild, type Guild } from "@/lib/types";

// Member management page. Same per-guild pattern (one guild via `?guild=`).
// Shows ACTIVE members (joined with power) + DEPARTED members (memberMeta rows
// whose userId is no longer in `members`), for the selected guild. Stat cards +
// a member grid; clicking a member opens an editable Power Rating modal.
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

  const [managed, parties] = await Promise.all([
    getMembersForManagement(guild),
    getParties(guild),
  ]);

  // Real, non-fabricated derived stats for the cards.
  const partiesFilled = parties.filter((p) => p.memberIds.length > 0).length;
  const membersAssigned = new Set(parties.flatMap((p) => p.memberIds)).size;

  return (
    <MembersDashboard
      key={guild}
      guild={guild}
      members={managed}
      partiesFilled={partiesFilled}
      membersAssigned={membersAssigned}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
