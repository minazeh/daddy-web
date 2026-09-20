// Polarity DPS RANKING import: parsing the pasted fixed-width ranking table,
// deduping it, and matching each IGN to a member.
//
// PURE module — no Mongo, no Next, no "server-only". Deterministic functions
// over plain data, so the whole thing is exercised standalone by
// scripts/verify-ranking-import.ts and reused by the server action
// (./ranking-actions) and the preview UI (../components/RankingImportModal).
//
// THE INPUT is what the game's ranking board prints, pasted as text:
//
//     #     DPS   Total   Dead  Class       Submitted    Member
//   ───────────────────────────────────────────────────────────
//     1   11.8M   1.40B   2.0s  Paladin     08-31 14:12  Solar
//     2   8.14M    960M   2.0s  Priest      09-08 03:08  Darasaki
//
// Conrad pastes SEVERAL of these blocks at once, concatenated, so a header row
// and a ─── rule can appear anywhere in the text, not just at the top. Both are
// stripped wherever they occur, as are blank lines. Anything else that does not
// parse becomes a per-row error with a reason — a bad row never fails the
// paste, exactly like the CSV power importer.
//
// NAME MATCHING is NOT implemented here. It is the same problem the CSV power
// importer solves, so both call the shared three-tier matcher in ./name-match.
//
// NOTHING HERE WRITES. This module only ever describes what an import would do.

import {
  canonicalName,
  matchNames,
  membersNotCovered,
  type Candidate,
  type CrossGuildHit,
  type MatchTier,
  type NameEntry,
  type RosterMember,
} from "./name-match";
import type { Guild } from "./types";

// ---------------------------------------------------------------------------
// Limits (defence in depth — also enforced in the server action). Mirrors
// MAX_CSV_CHARS / MAX_CSV_ROWS in power-import.ts.
// ---------------------------------------------------------------------------

export const MAX_RANKING_CHARS = 1_000_000;
export const MAX_RANKING_ROWS = 5_000;
/** Sanity ceiling for a DPS / Total figure. Well above any real ranking. */
export const MAX_MAGNITUDE = 1e15;
/** Sanity ceiling for the Dead column, in seconds (24h). */
export const MAX_DEAD_SECONDS = 86_400;
/** Longest Class string kept from the import. */
export const MAX_CLASS_LEN = 40;

// ---------------------------------------------------------------------------
// Number parsing — K / M / B suffixes, EXACTLY.
// ---------------------------------------------------------------------------

const MAGNITUDE_EXPONENT: Record<string, number> = { k: 3, m: 6, b: 9 };

// Non-breaking / figure / narrow spaces the board sometimes uses for alignment.
const NBSP_RE = /[   ]/g;

export interface MagnitudeParse {
  ok: boolean;
  value: number;
  reason: string | null;
}

/**
 * Parse a `11.8M` / `1.40B` / `960M` / `48200` figure into an exact integer.
 *
 * The scaling is done by SHIFTING THE DIGIT STRING, never by multiplying:
 * `11.8 * 1e6` is 11800000.000000002 in IEEE-754 and `1.40 * 1e9` is fine only
 * by luck. Shifting "118" left by 5 gives exactly 11800000, and "140" left by 7
 * gives exactly 1400000000. When a value carries more decimals than the suffix
 * can absorb (`1.2345K`), the leftover sub-unit fraction is rounded.
 */
export function parseMagnitude(raw: string, label: string): MagnitudeParse {
  const bad = (reason: string): MagnitudeParse => ({
    ok: false,
    value: 0,
    reason,
  });
  const cleaned = (raw ?? "").replace(NBSP_RE, " ").replace(/[,\s_]/g, "");
  if (cleaned === "") return bad(`${label} is blank.`);

  const m = /^\+?(\d+)(?:\.(\d+))?([kmbKMB])?$/.exec(cleaned);
  if (!m) return bad(`"${(raw ?? "").trim()}" is not a ${label} value.`);

  const intPart = m[1];
  const fracPart = m[2] ?? "";
  const exponent = m[3] ? MAGNITUDE_EXPONENT[m[3].toLowerCase()] : 0;

  const digits = intPart + fracPart;
  const shift = exponent - fracPart.length;
  let value: number;
  if (shift >= 0) {
    value = Number(digits + "0".repeat(shift));
  } else {
    value = Math.round(
      Number(`${digits.slice(0, shift) || "0"}.${digits.slice(shift)}`),
    );
  }

  if (!Number.isFinite(value)) {
    return bad(`"${(raw ?? "").trim()}" is not a ${label} value.`);
  }
  if (value > MAX_MAGNITUDE) {
    return bad(`${label} is implausibly large ("${(raw ?? "").trim()}").`);
  }
  return { ok: true, value, reason: null };
}

/** Parse the `Dead` column (`2.0s`, `0s`, `-`, blank) into seconds. */
export function parseDeadSeconds(raw: string): MagnitudeParse {
  const cleaned = (raw ?? "").replace(NBSP_RE, " ").replace(/\s/g, "");
  if (cleaned === "" || cleaned === "-") {
    return { ok: true, value: 0, reason: null };
  }
  const m = /^(\d+(?:\.\d+)?)s?$/i.exec(cleaned);
  if (!m) {
    return { ok: false, value: 0, reason: `"${raw.trim()}" is not a Dead time.` };
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value > MAX_DEAD_SECONDS) {
    return { ok: false, value: 0, reason: `"${raw.trim()}" is not a Dead time.` };
  }
  return { ok: true, value, reason: null };
}

/**
 * Resolve the year for a `MM-DD HH:MM` stamp, which the board prints WITHOUT
 * one.
 *
 * ASSUMPTION, not a fact from the data: a ranking paste is recent, so a stamp
 * is read as the MOST RECENT occurrence of that month/day AT OR BEFORE the
 * import time. A stamp that would be in the future relative to `now` is
 * therefore rolled back one year — a 12-28 row pasted on 01-03 is last
 * December, not next December. Everything is computed in UTC so the result does
 * not depend on the server's timezone.
 *
 * Returns null when no candidate year yields a real date (02-30, or 02-29 in
 * three consecutive non-leap years).
 */
export function inferSubmittedAt(
  month: number,
  day: number,
  hour: number,
  minute: number,
  now: Date,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const year = now.getUTCFullYear();
  let best: Date | null = null;
  for (const y of [year, year - 1, year - 2]) {
    const d = new Date(Date.UTC(y, month - 1, day, hour, minute));
    // Date.UTC rolls 02-30 over into March — reject rather than accept a date
    // the paste did not contain.
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue;
    if (d.getTime() > now.getTime()) continue;
    if (best === null || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Line classification — headers and rules are stripped wherever they appear.
// ---------------------------------------------------------------------------

export type LineKind = "blank" | "rule" | "header" | "data";

// A separator rule: box-drawing, dashes, underscores, equals, pipes, dots.
const RULE_RE =
  /^[\s─-╿‐-―=_~*+|.\-]+$/;

/**
 * Classify one source line. Order matters: a blank line is blank, a line made
 * only of rule characters is a rule, a line naming the columns is a header, and
 * everything else is offered to the row parser (which may still reject it).
 */
export function classifyLine(line: string): LineKind {
  if (line.trim() === "") return "blank";
  if (RULE_RE.test(line)) return "rule";
  const t = line.toLowerCase();
  if (
    t.includes("dps") &&
    (t.includes("member") || t.includes("submitted") || t.includes("total"))
  ) {
    return "header";
  }
  return "data";
}

// rank  DPS  Total  Dead  Class  MM-DD HH:MM  Member
//
// The Class group is LAZY and the Member group runs to end-of-line, so:
//   - a class name containing a space still parses;
//   - a MEMBER NAME CONTAINING SPACES survives intact. The row is anchored on
//     the `MM-DD HH:MM` stamp and everything after it is the IGN, trimmed. The
//     row is never split on whitespace blindly.
const ROW_RE =
  /^\s*(\d{1,6})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*?)\s+(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\s+(\S.*?)\s*$/;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One successfully parsed ranking row, before dedupe and matching. */
export interface ParsedRankingRow {
  line: number;
  rank: number;
  dps: number;
  total: number;
  deadSeconds: number;
  className: string;
  /** Epoch ms — the inferred absolute time of the `Submitted` stamp. */
  submittedAtMs: number;
  memberName: string;
  rawDps: string;
  rawTotal: string;
  rawDead: string;
  rawSubmitted: string;
}

/** A source line that looked like data but did not parse. */
export interface RankingLineError {
  line: number;
  raw: string;
  reason: string;
}

export interface ParsedRanking {
  rows: ParsedRankingRow[];
  errors: RankingLineError[];
  /** Header / rule / blank lines dropped, for the "we read N lines" readout. */
  skipped: number;
}

/**
 * Parse the whole pasted text. Never throws and never fails as a whole: a line
 * that does not parse lands in `errors` with a reason and the rest continues.
 */
export function parseRankingText(text: string, now: Date): ParsedRanking {
  const rows: ParsedRankingRow[] = [];
  const errors: RankingLineError[] = [];
  let skipped = 0;

  const lines = (text ?? "").split(/\r\n|\n|\r/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const kind = classifyLine(raw);
    if (kind !== "data") {
      if (kind !== "blank") skipped++;
      return;
    }

    const m = ROW_RE.exec(raw);
    if (!m) {
      errors.push({
        line: lineNo,
        raw: raw.trim(),
        reason:
          "Does not look like a ranking row (expected: rank, DPS, Total, Dead, Class, MM-DD HH:MM, Member).",
      });
      return;
    }

    const [
      ,
      rawRank,
      rawDps,
      rawTotal,
      rawDead,
      rawClass,
      rawMonth,
      rawDay,
      rawHour,
      rawMinute,
      rawMember,
    ] = m;

    const dps = parseMagnitude(rawDps, "DPS");
    if (!dps.ok) {
      errors.push({ line: lineNo, raw: raw.trim(), reason: dps.reason! });
      return;
    }
    const total = parseMagnitude(rawTotal, "Total");
    if (!total.ok) {
      errors.push({ line: lineNo, raw: raw.trim(), reason: total.reason! });
      return;
    }
    const dead = parseDeadSeconds(rawDead);
    if (!dead.ok) {
      errors.push({ line: lineNo, raw: raw.trim(), reason: dead.reason! });
      return;
    }

    const rawSubmitted = `${rawMonth}-${rawDay} ${rawHour}:${rawMinute}`;
    const submittedAt = inferSubmittedAt(
      Number(rawMonth),
      Number(rawDay),
      Number(rawHour),
      Number(rawMinute),
      now,
    );
    if (!submittedAt) {
      errors.push({
        line: lineNo,
        raw: raw.trim(),
        reason: `"${rawSubmitted}" is not a real date.`,
      });
      return;
    }

    const memberName = rawMember.trim();
    if (memberName === "") {
      errors.push({ line: lineNo, raw: raw.trim(), reason: "Member is blank." });
      return;
    }

    rows.push({
      line: lineNo,
      rank: Number(rawRank),
      dps: dps.value,
      total: total.value,
      deadSeconds: dead.value,
      className: rawClass.trim().slice(0, MAX_CLASS_LEN),
      submittedAtMs: submittedAt.getTime(),
      memberName,
      rawDps,
      rawTotal,
      rawDead,
      rawSubmitted,
    });
  });

  return { rows, errors, skipped };
}

// ---------------------------------------------------------------------------
// Dedupe across blocks
// ---------------------------------------------------------------------------

export interface DedupedRankingRow extends ParsedRankingRow {
  /** How many other rows for this IGN this one beat. */
  supersededCount: number;
  /** The `Submitted` stamps this row won against, newest first. */
  supersededBy: string[];
}

/**
 * Collapse repeated IGNs down to one row each.
 *
 * CONRAD'S RULE: the LATEST `Submitted` wins, even when its DPS is LOWER than
 * an earlier entry — a newer run is a truer statement of where the member is
 * now. Ties on the timestamp fall to the higher DPS, then to the better rank,
 * then to first-seen order, so the outcome is fully deterministic.
 *
 * Rows are keyed on the canonical IGN (the matcher's tier-1 key), so "Solar"
 * and "  solar " are the same member here, exactly as they are to the matcher.
 * The surviving rows come back in first-appearance order.
 */
export function dedupeRankingRows(
  rows: ParsedRankingRow[],
): DedupedRankingRow[] {
  const order: string[] = [];
  const groups = new Map<string, ParsedRankingRow[]>();
  for (const row of rows) {
    const key = canonicalName(row.memberName);
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
      order.push(key);
    }
  }

  const out: DedupedRankingRow[] = [];
  for (const key of order) {
    const list = groups.get(key)!;
    const sorted = list
      .map((row, index) => ({ row, index }))
      .sort(
        (a, b) =>
          b.row.submittedAtMs - a.row.submittedAtMs ||
          b.row.dps - a.row.dps ||
          a.row.rank - b.row.rank ||
          a.index - b.index,
      );
    const winner = sorted[0].row;
    out.push({
      ...winner,
      supersededCount: sorted.length - 1,
      supersededBy: sorted.slice(1).map((s) => s.row.rawSubmitted),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** What is currently stored for a member, so the preview can show a delta. */
export interface StoredDps {
  dps: number;
  total: number;
  deadSeconds: number;
  className: string;
  submittedAt: string;
}

export interface RankingPreviewRow {
  /** 1-based index among the rows that survived parse + dedupe. */
  rowNumber: number;
  /** 1-based source line, for pointing at the paste. */
  line: number;
  rawName: string;
  rank: number | null;
  dps: number | null;
  total: number | null;
  deadSeconds: number | null;
  className: string | null;
  /** ISO string; null on an error row. */
  submittedAt: string | null;
  rawDps: string;
  rawTotal: string;
  rawDead: string;
  rawSubmitted: string;
  /** How many duplicate entries for this IGN this row superseded. */
  supersededCount: number;
  /** Set when this row won a dedupe, or when it is worth flagging. */
  note: string | null;
  tier: MatchTier;
  userId: string | null;
  candidates: Candidate[];
  reason: string | null;
  crossGuild: CrossGuildHit | null;
  /** The member's currently stored DPS row, when there is one. */
  current: StoredDps | null;
}

export interface RankingPreviewCounts {
  total: number;
  exact: number;
  suggested: number;
  unmatched: number;
  error: number;
  crossGuild: number;
  /** Duplicate entries collapsed away by the latest-Submitted rule. */
  duplicatesCollapsed: number;
}

export interface RankingPreview {
  ok: boolean;
  message?: string;
  guild: Guild;
  rows: RankingPreviewRow[];
  /** The target guild's ACTIVE roster — backs the manual-pick dropdown. */
  roster: RosterMember[];
  counts: RankingPreviewCounts;
  /** Header / rule lines dropped while reading the paste. */
  skippedLines: number;
}

/** "In the paste, went nowhere" — unmatched plus malformed. */
export function unresolvedRankingRows(
  rows: RankingPreviewRow[],
): RankingPreviewRow[] {
  return rows.filter((r) => r.tier === "unmatched" || r.tier === "error");
}

/** "In the guild, absent from the paste." Shares the CSV importer's helper. */
export function membersNotInRanking(
  roster: RosterMember[],
  covered: Set<string>,
): RosterMember[] {
  return membersNotCovered(roster, covered);
}

/** Tab-separated dump of the unresolved rows, for pasting back into a sheet. */
export function unresolvedRankingAsTsv(rows: RankingPreviewRow[]): string {
  const header = ["Row", "Member", "DPS", "Submitted", "Problem"].join("\t");
  const body = unresolvedRankingRows(rows).map((r) =>
    [
      r.rowNumber,
      r.rawName,
      r.rawDps,
      r.rawSubmitted,
      r.crossGuild
        ? `Matches ${r.crossGuild.guildLabel} member "${r.crossGuild.displayName}" — not imported`
        : (r.reason ?? ""),
    ].join("\t"),
  );
  return [header, ...body].join("\n");
}

/**
 * Build the preview for one guild's roster. PURE — the caller supplies the
 * roster and the clock; this never touches a database and never writes.
 *
 * `now` is injected rather than read from the environment so the year inference
 * is testable and so a preview and its apply agree on the same clock.
 */
export function buildRankingPreview(
  guild: Guild,
  text: string,
  roster: RosterMember[],
  otherRoster: RosterMember[] = [],
  now: Date = new Date(),
  current: Map<string, StoredDps> = new Map(),
): RankingPreview {
  const empty: RankingPreview = {
    ok: false,
    guild,
    rows: [],
    roster,
    counts: {
      total: 0,
      exact: 0,
      suggested: 0,
      unmatched: 0,
      error: 0,
      crossGuild: 0,
      duplicatesCollapsed: 0,
    },
    skippedLines: 0,
  };

  if (typeof text !== "string" || text.trim() === "") {
    return { ...empty, message: "Nothing pasted." };
  }
  if (text.length > MAX_RANKING_CHARS) {
    return {
      ...empty,
      message: `That paste is too large (${text.length} characters, limit ${MAX_RANKING_CHARS}).`,
    };
  }

  const parsed = parseRankingText(text, now);
  if (parsed.rows.length + parsed.errors.length === 0) {
    return {
      ...empty,
      skippedLines: parsed.skipped,
      message:
        "No ranking rows found. Expected lines like `1   11.8M   1.40B   2.0s  Paladin     08-31 14:12  Solar`.",
    };
  }
  if (parsed.rows.length + parsed.errors.length > MAX_RANKING_ROWS) {
    return {
      ...empty,
      skippedLines: parsed.skipped,
      message: `Too many rows (${parsed.rows.length + parsed.errors.length}, limit ${MAX_RANKING_ROWS}).`,
    };
  }

  const deduped = dedupeRankingRows(parsed.rows);

  // Error rows keep their source order alongside the survivors, so nothing is
  // hidden: the preview lists every line the paste contained.
  const rows: RankingPreviewRow[] = [];
  const toMatch: NameEntry<number>[] = [];

  const ordered: (
    | { kind: "row"; row: DedupedRankingRow }
    | { kind: "error"; err: RankingLineError }
  )[] = [
    ...deduped.map((row) => ({ kind: "row" as const, row })),
    ...parsed.errors.map((err) => ({ kind: "error" as const, err })),
  ].sort((a, b) => {
    const al = a.kind === "row" ? a.row.line : a.err.line;
    const bl = b.kind === "row" ? b.row.line : b.err.line;
    return al - bl;
  });

  ordered.forEach((item, i) => {
    const rowNumber = i + 1;
    if (item.kind === "error") {
      rows.push({
        rowNumber,
        line: item.err.line,
        rawName: item.err.raw,
        rank: null,
        dps: null,
        total: null,
        deadSeconds: null,
        className: null,
        submittedAt: null,
        rawDps: "",
        rawTotal: "",
        rawDead: "",
        rawSubmitted: "",
        supersededCount: 0,
        note: null,
        tier: "error",
        userId: null,
        candidates: [],
        reason: item.err.reason,
        crossGuild: null,
        current: null,
      });
      return;
    }

    const row = item.row;
    rows.push({
      rowNumber,
      line: row.line,
      rawName: row.memberName,
      rank: row.rank,
      dps: row.dps,
      total: row.total,
      deadSeconds: row.deadSeconds,
      className: row.className,
      submittedAt: new Date(row.submittedAtMs).toISOString(),
      rawDps: row.rawDps,
      rawTotal: row.rawTotal,
      rawDead: row.rawDead,
      rawSubmitted: row.rawSubmitted,
      supersededCount: row.supersededCount,
      note:
        row.supersededCount > 0
          ? `Kept the latest of ${row.supersededCount + 1} entries (${row.rawSubmitted}); superseded ${row.supersededBy.join(", ")}.`
          : null,
      tier: "unmatched",
      userId: null,
      candidates: [],
      reason: null,
      crossGuild: null,
      current: null,
    });
    toMatch.push({ key: rowNumber, rawName: row.memberName });
  });

  // ---- SHARED name matching ----------------------------------------------
  const matches = matchNames(guild, toMatch, roster, otherRoster);
  for (const row of rows) {
    const m = matches.get(row.rowNumber);
    if (!m) continue; // an error row — never matched
    row.tier = m.tier;
    row.userId = m.userId;
    row.candidates = m.candidates;
    row.reason = m.reason;
    row.crossGuild = m.crossGuild;
    if (m.userId) row.current = current.get(m.userId) ?? null;
  }

  return {
    ok: true,
    guild,
    rows,
    roster,
    counts: {
      total: rows.length,
      exact: rows.filter((r) => r.tier === "exact").length,
      suggested: rows.filter((r) => r.tier === "suggested").length,
      unmatched: rows.filter((r) => r.tier === "unmatched").length,
      error: rows.filter((r) => r.tier === "error").length,
      crossGuild: rows.filter((r) => r.crossGuild !== null).length,
      duplicatesCollapsed: parsed.rows.length - deduped.length,
    },
    skippedLines: parsed.skipped,
  };
}

// ---------------------------------------------------------------------------
// Apply — the decision list the UI sends back, and the report it gets.
// ---------------------------------------------------------------------------

/** One confirmed row: "record THIS ranking entry against THIS member". */
export interface RankingDecision {
  rowNumber: number;
  userId: string;
  dps: number;
  total: number;
  deadSeconds: number;
  className: string;
  /** ISO string. */
  submittedAt: string;
}

export type RankingSkipReason =
  | "not-in-guild"
  | "unknown-member"
  | "duplicate-target"
  | "invalid";

export interface SkippedRankingDecision {
  rowNumber: number;
  userId: string;
  displayName: string | null;
  reason: RankingSkipReason;
  detail: string;
}

export interface RankingChange {
  userId: string;
  displayName: string;
  fromDps: number | null;
  toDps: number;
  className: string;
  submittedAt: string;
}

export interface RankingWrite {
  userId: string;
  displayName: string;
  dps: number;
  total: number;
  deadSeconds: number;
  className: string;
  submittedAt: string;
  fromDps: number | null;
}

export interface RankingApplyReport {
  ok: boolean;
  message?: string;
  guild: Guild;
  /** Rows actually written. */
  updated: number;
  /** The stored row was already identical — no write needed. */
  unchanged: number;
  /** Rejected server-side; every one carries a reason. */
  skipped: number;
  /** Roster members with no confirmed row — their stored DPS was left as-is. */
  untouched: number;
  changes: RankingChange[];
  skippedRows: SkippedRankingDecision[];
}

/** Clamp an arbitrary DPS/Total figure to a non-negative integer in range. */
export function normalizeMagnitude(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_MAGNITUDE);
}

/** Clamp the Dead column to a non-negative number of seconds in range. */
export function normalizeDeadSeconds(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_DEAD_SECONDS);
}

/**
 * Validate the decision list against the guild roster. PURE — the caller does
 * the writing. Enforces, server-side and independently of the UI:
 *   - every target exists AND belongs to the guild being imported (Daddy and
 *     Mummy are separate guilds and must never be crossed);
 *   - every figure goes through the normalizers;
 *   - one target per import (a second row for the same member is skipped, the
 *     first one wins, and the skip is reported).
 */
export function planRankingApply(
  guild: Guild,
  decisions: RankingDecision[],
  roster: RosterMember[],
  otherGuildIds: Set<string>,
  current: Map<string, StoredDps> = new Map(),
): {
  writes: RankingWrite[];
  unchanged: RankingChange[];
  skipped: SkippedRankingDecision[];
} {
  const byId = new Map(roster.map((m) => [m.userId, m]));
  const writes: RankingWrite[] = [];
  const unchanged: RankingChange[] = [];
  const skipped: SkippedRankingDecision[] = [];
  const takenBy = new Map<string, number>();

  for (const d of decisions) {
    const rowNumber = Number(d?.rowNumber);
    const userId = typeof d?.userId === "string" ? d.userId : "";
    if (!userId) {
      skipped.push({
        rowNumber: Number.isFinite(rowNumber) ? rowNumber : 0,
        userId: "",
        displayName: null,
        reason: "invalid",
        detail: "No member selected.",
      });
      continue;
    }

    const member = byId.get(userId);
    if (!member) {
      const crossGuild = otherGuildIds.has(userId);
      skipped.push({
        rowNumber,
        userId,
        displayName: null,
        reason: crossGuild ? "not-in-guild" : "unknown-member",
        detail: crossGuild
          ? "Belongs to the other guild — imports never cross guilds."
          : "Not on this guild's active roster.",
      });
      continue;
    }

    const first = takenBy.get(userId);
    if (first !== undefined) {
      skipped.push({
        rowNumber,
        userId,
        displayName: member.displayName,
        reason: "duplicate-target",
        detail: `Already set by row ${first}.`,
      });
      continue;
    }
    takenBy.set(userId, rowNumber);

    const submittedAtMs = Date.parse(String(d.submittedAt));
    if (!Number.isFinite(submittedAtMs)) {
      skipped.push({
        rowNumber,
        userId,
        displayName: member.displayName,
        reason: "invalid",
        detail: "Submitted time is not a valid date.",
      });
      continue;
    }

    const dps = normalizeMagnitude(d.dps);
    const total = normalizeMagnitude(d.total);
    const deadSeconds = normalizeDeadSeconds(d.deadSeconds);
    const className = String(d.className ?? "")
      .trim()
      .slice(0, MAX_CLASS_LEN);
    const submittedAt = new Date(submittedAtMs).toISOString();

    const prev = current.get(userId) ?? null;
    if (
      prev &&
      prev.dps === dps &&
      prev.total === total &&
      prev.deadSeconds === deadSeconds &&
      prev.className === className &&
      prev.submittedAt === submittedAt
    ) {
      unchanged.push({
        userId,
        displayName: member.displayName,
        fromDps: prev.dps,
        toDps: dps,
        className,
        submittedAt,
      });
      continue;
    }

    writes.push({
      userId,
      displayName: member.displayName,
      dps,
      total,
      deadSeconds,
      className,
      submittedAt,
      fromDps: prev ? prev.dps : null,
    });
  }

  return { writes, unchanged, skipped };
}
