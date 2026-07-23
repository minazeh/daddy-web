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
// `power` is NOT from the bot's `members` collection — it lives in the
// web-owned `memberMeta`. It's joined in at read time (the builder page enriches
// members via getPowerMap); default 0 when unrated. Optional so plain reads that
// don't need power can omit it.
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
  power?: number; // joined from memberMeta (default 0 when unrated)
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
  // The raid leader: a Discord userId that MUST be a member of one of this raid
  // group's parties (the eligible set = raidGroupMemberIds). null/absent = no
  // leader. Each raid group has its own single leader. Web app writes it; the
  // Discord bot reads it (read-only) to crown the leader in /guildroster.
  leaderId?: string | null;
  updatedAt: string; // ISO string
}

// The eligible-leader member set for a raid group: the DEDUPED UNION of the
// memberIds across every party assigned to the raid group, in party order then
// slot order (deterministic). The raid leader MUST be one of these userIds.
// Reused by the leader select (UI) and by server-side validation so both agree.
export function raidGroupMemberIds(
  raid: Pick<RaidGroup, "partyIds">,
  partiesById: Map<string, Pick<Party, "memberIds">>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const partyId of raid.partyIds) {
    const p = partiesById.get(partyId);
    if (!p) continue;
    for (const id of p.memberIds) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
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
// flag stored at Generate time. (Legacy helper — the settings-driven
// `missingRequiredClasses` below supersedes it.)
export function partyHasPriest(
  party: Pick<Party, "memberIds">,
  membersById: Map<string, Pick<Member, "className">>,
): boolean {
  return party.memberIds.some((id) =>
    isHealer(membersById.get(id)?.className ?? null),
  );
}

// ---- Settings (web-owned, single GLOBAL doc) ----
// Turns the formerly-hardcoded comp rules into editable config:
//   requiredClasses — every party must contain >= min of each className.
//   classRoles      — className → comp role (Tank/Healer/DPS).
//   partySize       — slots per party (was MAX_PARTY_SLOTS = 5).
//   mainPartyCount / subPartyCount — parties seeded per field (was 12 / 18).

// The 8 known classes (the editable Settings UI offers exactly these).
export const KNOWN_CLASSES = [
  "Assassin",
  "Hunter",
  "Knight",
  "Priest",
  "Gunslinger",
  "Blacksmith",
  "Wizard",
  "Druid",
] as const;

export const ROLES: Role[] = ["tank", "healer", "dps"];

// DEFAULT class→role map (seeds settings.classRoles; preserves old behavior).
export const DEFAULT_CLASS_ROLE: Record<string, Role> = { ...CLASS_ROLE };

// Resolve a className to a role using a classRoles map (from settings).
// Unknown/null className → generic "dps" (flex).
export function roleFor(
  className: string | null,
  classRoles: Record<string, Role>,
): Role {
  if (!className) return "dps";
  return classRoles[className] ?? "dps";
}

export interface RequiredClass {
  className: string;
  min: number; // >= 1
}

export interface Settings {
  requiredClasses: RequiredClass[];
  classRoles: Record<string, Role>;
  partySize: number;
  mainPartyCount: number;
  subPartyCount: number;
  updatedAt: string; // ISO
}

// DEFAULTS that preserve today's behavior exactly.
export const DEFAULT_SETTINGS: Omit<Settings, "updatedAt"> = {
  requiredClasses: [{ className: "Priest", min: 1 }],
  classRoles: { ...CLASS_ROLE },
  partySize: 5,
  mainPartyCount: 12,
  subPartyCount: 18,
};

// Bounds for validation (UI + server action).
export const PARTY_SIZE_MIN = 1;
export const PARTY_SIZE_MAX = 10;
export const PARTY_COUNT_MIN = 0;
export const PARTY_COUNT_MAX = 60;

// Validate + normalize a full settings object against bounds + invariants.
// The SUM of requiredClasses mins must be <= partySize (can't require more than
// fits a party). Returns the normalized settings or an error message.
export function validateSettings(
  s: Settings,
): { ok: true; settings: Settings } | { ok: false; error: string } {
  const partySize = Math.round(Number(s.partySize));
  if (
    !Number.isInteger(partySize) ||
    partySize < PARTY_SIZE_MIN ||
    partySize > PARTY_SIZE_MAX
  ) {
    return {
      ok: false,
      error: `Party size must be ${PARTY_SIZE_MIN}–${PARTY_SIZE_MAX}.`,
    };
  }
  const mainPartyCount = Math.round(Number(s.mainPartyCount));
  const subPartyCount = Math.round(Number(s.subPartyCount));
  for (const [label, v] of [
    ["Main", mainPartyCount],
    ["Sub", subPartyCount],
  ] as const) {
    if (!Number.isInteger(v) || v < PARTY_COUNT_MIN || v > PARTY_COUNT_MAX) {
      return {
        ok: false,
        error: `${label} party count must be ${PARTY_COUNT_MIN}–${PARTY_COUNT_MAX}.`,
      };
    }
  }
  // classRoles: only known classes, valid roles (default dps).
  const classRoles: Record<string, Role> = {};
  for (const cls of KNOWN_CLASSES) {
    const r = s.classRoles?.[cls];
    classRoles[cls] = r === "tank" || r === "healer" || r === "dps" ? r : "dps";
  }
  // requiredClasses: known classes, min >= 1, no dupes, sum(mins) <= partySize.
  const seen = new Set<string>();
  const requiredClasses: RequiredClass[] = [];
  let minSum = 0;
  for (const rc of s.requiredClasses ?? []) {
    if (!(KNOWN_CLASSES as readonly string[]).includes(rc.className)) {
      return { ok: false, error: `Unknown class "${rc.className}".` };
    }
    if (seen.has(rc.className)) {
      return { ok: false, error: `Duplicate required class "${rc.className}".` };
    }
    const min = Math.round(Number(rc.min));
    if (!Number.isInteger(min) || min < 1) {
      return { ok: false, error: `Min for "${rc.className}" must be >= 1.` };
    }
    seen.add(rc.className);
    requiredClasses.push({ className: rc.className, min });
    minSum += min;
  }
  if (minSum > partySize) {
    return {
      ok: false,
      error: `Required classes need ${minSum} slots but party size is ${partySize}.`,
    };
  }
  return {
    ok: true,
    settings: {
      requiredClasses,
      classRoles,
      partySize,
      mainPartyCount,
      subPartyCount,
      updatedAt: new Date().toISOString(),
    },
  };
}

// SINGLE SOURCE OF TRUTH for composition checking. Returns the list of required
// classNames a party is MISSING (has fewer than `min` of). Empty = meets all.
// Computed LIVE from the party's actual memberIds (locked OR unlocked), so
// manual drags/locks update it immediately. Reused by the card badge, the
// toolbar count, and Generate's hard rule so all three agree.
export function missingRequiredClasses(
  party: Pick<Party, "memberIds">,
  membersById: Map<string, Pick<Member, "className">>,
  requiredClasses: RequiredClass[],
): string[] {
  const counts = new Map<string, number>();
  for (const id of party.memberIds) {
    const cls = membersById.get(id)?.className ?? null;
    if (cls) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return requiredClasses
    .filter((rc) => (counts.get(rc.className) ?? 0) < rc.min)
    .map((rc) => rc.className);
}

// Convenience: does the party meet ALL required-class minimums?
export function partyMeetsRequirements(
  party: Pick<Party, "memberIds">,
  membersById: Map<string, Pick<Member, "className">>,
  requiredClasses: RequiredClass[],
): boolean {
  return missingRequiredClasses(party, membersById, requiredClasses).length === 0;
}
