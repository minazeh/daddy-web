import type { Member, MemberMeta, Party, RaidGroup } from "./types";

// Local-dev fallback data, used ONLY when MONGODB_URI is unset so the
// dashboard renders something to drag around without a live database.
// The real path reads from Mongo (see data.ts). This is never written back.

const now = new Date().toISOString();

export const MOCK_MEMBERS: Member[] = [
  { userId: "m1", username: "poring_lord", displayName: "Poring Lord", avatarUrl: null, isMain: true, isSub: false, className: "Lord Knight", classRoleId: null, updatedAt: now },
  { userId: "m2", username: "holy_mum", displayName: "Holy Mum", avatarUrl: null, isMain: true, isSub: false, className: "High Priest", classRoleId: null, updatedAt: now },
  { userId: "m3", username: "boom_boom", displayName: "Boom Boom", avatarUrl: null, isMain: true, isSub: false, className: "High Wizard", classRoleId: null, updatedAt: now },
  { userId: "m4", username: "sneaky", displayName: "Sneaky", avatarUrl: null, isMain: true, isSub: false, className: "Assassin Cross", classRoleId: null, updatedAt: now },
  { userId: "m5", username: "tinker", displayName: "Tinker", avatarUrl: null, isMain: true, isSub: false, className: "Whitesmith", classRoleId: null, updatedAt: now },
  { userId: "m6", username: "songbird", displayName: "Songbird", avatarUrl: null, isMain: true, isSub: false, className: "Clown", classRoleId: null, updatedAt: now },
  { userId: "s1", username: "lil_poring", displayName: "Lil Poring", avatarUrl: null, isMain: false, isSub: true, className: "Knight", classRoleId: null, updatedAt: now },
  { userId: "s2", username: "acolyte_jo", displayName: "Acolyte Jo", avatarUrl: null, isMain: false, isSub: true, className: "Priest", classRoleId: null, updatedAt: now },
  { userId: "s3", username: "sparkles", displayName: "Sparkles", avatarUrl: null, isMain: false, isSub: true, className: "Wizard", classRoleId: null, updatedAt: now },
  { userId: "s4", username: "shadowfoot", displayName: "Shadowfoot", avatarUrl: null, isMain: false, isSub: true, className: "Rogue", classRoleId: null, updatedAt: now },
];

// Mock assignments keyed on canonical ids (`${type}-${field}-${position}`) so
// ensureGuildParties folds them onto the seeded blank parties in mock mode.
export const MOCK_PARTIES: Party[] = [
  { partyId: "daddy-main-0", type: "daddy", field: "main", name: "Main 1", memberIds: ["m1", "m2"], position: 0, x: 0, y: 0, lockedSlots: [], updatedAt: now },
  { partyId: "daddy-sub-0", type: "daddy", field: "sub", name: "Sub 1", memberIds: ["m3"], position: 0, x: 0, y: 0, lockedSlots: [], updatedAt: now },
  { partyId: "mummy-main-0", type: "mummy", field: "main", name: "Main 1", memberIds: ["s1"], position: 0, x: 0, y: 0, lockedSlots: [], updatedAt: now },
];

// Mutable in-memory raid-group store for mock mode (no DB). Persists for the
// life of the server process so create/assign/move/delete are visible during
// local dev without MONGODB_URI. Cached on globalThis so HMR doesn't reset it.
declare global {
  var _mockRaidGroups: RaidGroup[] | undefined;
  var _mockMemberMeta: Map<string, MemberMeta> | undefined;
}
export const MOCK_RAID_GROUPS: RaidGroup[] =
  globalThis._mockRaidGroups ?? (globalThis._mockRaidGroups = []);

// Mutable in-memory memberMeta store for mock mode (power + departed history).
// Keyed by userId, globalThis-cached so HMR + power edits persist for the
// process lifetime without a DB. Seeded once from MOCK_MEMBERS with power 0.
export const MOCK_MEMBER_META: Map<string, MemberMeta> =
  globalThis._mockMemberMeta ??
  (globalThis._mockMemberMeta = new Map(
    MOCK_MEMBERS.map((m) => [
      m.userId,
      {
        userId: m.userId,
        power: 0,
        displayName: m.displayName,
        username: m.username,
        className: m.className,
        classRoleId: m.classRoleId,
        isMain: m.isMain,
        isSub: m.isSub,
        avatarUrl: m.avatarUrl,
        lastSeenAt: now,
        updatedAt: now,
      },
    ]),
  ));
