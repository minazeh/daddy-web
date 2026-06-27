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
