// Shared domain types for the Daddy Poring member dashboard.
// The `members` collection is owned/written by the Discord bot (read-only here).
// The `parties` collection is owned by this web app (read + write).
//
// IMPORTANT: Daddy and Mummy are two SEPARATE GUILDS, not "main/sub" of one
// thing. Their members and parties are entirely independent and must never be
// combined or shown together. The dashboard shows exactly ONE guild at a time.
//
// The bot's member contract is UNCHANGED — members still carry isMain / isSub:
//   Daddy guild  <-> isMain === true
//   Mummy guild  <-> isSub  === true
// Only the `parties.type` enum (owned by this app) uses the guild names.

export type Guild = "daddy" | "mummy";

export const GUILDS: Guild[] = ["daddy", "mummy"];
export const DEFAULT_GUILD: Guild = "daddy";

export function isGuild(v: unknown): v is Guild {
  return v === "daddy" || v === "mummy";
}

// Human-facing label for a guild.
export const GUILD_LABEL: Record<Guild, string> = {
  daddy: "Daddy",
  mummy: "Mummy",
};

// Mirrors the `members` doc written by the Discord bot.
// (`_id` is omitted — we never expose Mongo ObjectIds to the client.)
export interface Member {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isMain: boolean; // Daddy guild membership
  isSub: boolean; // Mummy guild membership
  className: string | null;
  classRoleId: string | null;
  updatedAt: string; // ISO string (serialized from Mongo Date)
}

// Web-owned `memberMeta` collection — the source of truth for manual POWER
// ratings + the HISTORICAL roster. Power and "departed" history must NOT live in
// `members` (the bot's sync would wipe them). On load we upsert meta for every
// current member: refresh the cached fields + lastSeenAt, set power=0 for NEW
// members, and NEVER overwrite an existing member's power.
export interface MemberMeta {
  userId: string;
  power: number; // manual rating, non-negative int, default 0
  displayName: string;
  username: string;
  className: string | null;
  classRoleId: string | null;
  isMain: boolean;
  isSub: boolean;
  avatarUrl: string | null;
  lastSeenAt: string; // ISO — last time seen in the live `members` collection
  updatedAt: string; // ISO
}

// A member as shown on the /members management page: the cached roster fields +
// power + whether they're currently active (present in `members`) or departed
// (a memberMeta row whose userId is no longer in `members`).
export interface ManagedMember extends MemberMeta {
  active: boolean;
}

// Clamp arbitrary input to a valid power value (non-negative integer).
export function normalizePower(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1_000_000); // sane upper bound
}

// Each guild has a FIXED, pre-created field structure (no manual add):
//   Main Field: 12 parties, Sub Field: 18 parties.
// A party is identified by (type, field, position). Parties are seeded
// idempotently with a deterministic partyId `${type}-${field}-${position}`.
export type Field = "main" | "sub";

export const FIELDS: Field[] = ["main", "sub"];
export const FIELD_LABEL: Record<Field, string> = {
  main: "Main Field",
  sub: "Sub Field",
};

// Exact party counts per field (fixed structure).
export const FIELD_SIZE: Record<Field, number> = {
  main: 12,
  sub: 18,
};

// Cards per row in the grid layout.
export const CARDS_PER_ROW = 5;

// Mirrors the `parties` doc owned by this app. `type` is the guild the party
// belongs to and `field` is which of that guild's two fields it's in; a party
// is identified by (type, field, position). The layout is grid-driven by
// (field, position), so x/y are retained for back-compat only (not used for
// placement anymore). `lockedSlots` holds slot indexes that can't be
// overwritten by a drop.
export interface Party {
  partyId: string; // deterministic: `${type}-${field}-${position}`
  type: Guild;
  field: Field;
  name: string;
  memberIds: string[]; // assigned userIds, max 5
  position: number; // index within (type, field): 0-based
  x: number; // legacy canvas x (unused for layout)
  y: number; // legacy canvas y (unused for layout)
  lockedSlots: number[]; // slot indexes that are locked
  updatedAt: string; // ISO string
}

export const MAX_PARTY_SLOTS = 5;

// Deterministic id for a party at (type, field, position).
export function partyIdFor(
  type: Guild,
  field: Field,
  position: number,
): string {
  return `${type}-${field}-${position}`;
}

// ---- Raid Groups (the layer ABOVE parties) ----
// A raid group holds PARTIES (Members → Parties → Raid Groups). Scoped per guild
// AND per field: a Main raid group holds only Main parties, a Sub raid group
// only Sub parties — never cross fields. A party belongs to AT MOST ONE raid
// group within its (type, field). Raid groups are MANUAL (created on demand,
// not pre-seeded). Web-owned collection `raidGroups`.
export interface RaidGroup {
  raidGroupId: string; // uuid
  type: Guild;
  field: Field;
  name: string;
  partyIds: string[]; // assigned party ids (no cap)
  position: number; // ordering within (type, field)
  updatedAt: string; // ISO string
}

// ---- Roles (for the roster auto-fill / Generate) ----
// Maps a member's `className` (from the members collection) to a comp role.
// EASY TO EDIT: add/move class names here. Anything not listed (or null/unknown
// className) is treated as generic DPS/flex and NEVER counts as a Priest.
export type Role = "tank" | "healer" | "dps";

export const CLASS_ROLE: Record<string, Role> = {
  Knight: "tank",
  Priest: "healer",
  Assassin: "dps",
  Hunter: "dps",
  Gunslinger: "dps",
  Blacksmith: "dps",
  Wizard: "dps",
  Druid: "dps",
};

// The class that satisfies the "a Priest in every party" hard rule.
export const HEALER_CLASS = "Priest";

// Resolve a className to a role. Unknown/null -> generic DPS (flex), never healer.
export function roleForClass(className: string | null): Role {
  if (!className) return "dps";
  return CLASS_ROLE[className] ?? "dps";
}

// Is this member a Priest (the healer that satisfies the hard rule)?
export function isHealer(className: string | null): boolean {
  return className === HEALER_CLASS;
}

// SINGLE SOURCE OF TRUTH for Priest-presence. A party "has a Priest" if ANY of
// its CURRENT members — locked OR unlocked — is a Priest. Computed LIVE from the
// party's actual `memberIds` (look up each member's className), never from a
// flag stored at Generate time. Reused by the card badge, the toolbar shortage
// count, and the Generate hard rule so all three agree.
export function partyHasPriest(
  party: Pick<Party, "memberIds">,
  membersById: Map<string, Pick<Member, "className">>,
): boolean {
  return party.memberIds.some((id) =>
    isHealer(membersById.get(id)?.className ?? null),
  );
}
