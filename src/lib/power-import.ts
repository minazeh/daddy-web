// CSV power-rating import: CSV parsing, power-cell parsing, and the preview /
// apply plan.
//
// PURE module — no Mongo, no Next, no "server-only". Everything here is a
// deterministic function over plain data so the exact same code can be unit
// tested standalone and reused by the server action (src/lib/power-import-actions.ts)
// and the preview UI (src/components/PowerImportModal.tsx).
//
// NAME MATCHING LIVES IN ./name-match. It used to live here, and was extracted
// so the Polarity DPS ranking importer (./ranking-import) could reuse the exact
// same three-tier engine — exact / suggested / unmatched — instead of copying
// it. Everything this module used to export from that half is re-exported
// below, so this file's public surface is unchanged. The extraction is pinned
// by scripts/verify-power-import.ts, whose expected digest was captured from
// the pre-extraction code.
//
// Power ratings are hand-maintained data: this module only ever DESCRIBES what
// an import would do. Nothing here writes.

import { normalizePower, type Guild } from "./types";
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

// The matcher's surface, re-exported so existing callers (the server action,
// the preview modal, the verification script) import it from here exactly as
// they always did.
export {
  canonicalName,
  foldName,
  prefixBeforeSeparator,
  diceSimilarity,
  matchNames,
  MAX_CANDIDATES,
  MIN_CONTAINMENT_LEN,
  SUGGEST_THRESHOLD,
} from "./name-match";
export type {
  Candidate,
  CrossGuildHit,
  MatchTier,
  NameEntry,
  RosterMember,
} from "./name-match";

// ---------------------------------------------------------------------------
// Limits (defence in depth — also enforced in the server action).
// ---------------------------------------------------------------------------

export const MAX_CSV_CHARS = 1_000_000;
export const MAX_CSV_ROWS = 5_000;

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180-ish): quoted fields, "" escapes, CRLF/LF/CR, BOM,
// blank trailing lines, and , ; or TAB as the delimiter.
// ---------------------------------------------------------------------------

export interface CsvRecord {
  /** 1-based line number in the source file where this record starts. */
  line: number;
  cells: string[];
}

const DELIMITERS = [",", ";", "\t"] as const;

/** Pick the delimiter that appears most often in the first line (outside quotes). */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  let best = ",";
  let bestCount = -1;
  for (const d of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === d && !inQuotes) {
        count++;
      }
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse CSV text into records. Strips a leading UTF-8 BOM. Records that are
 * entirely empty (a blank line, or a line of only empty cells) are dropped, so
 * trailing newlines and stray blank rows cost nothing.
 */
export function parseCsv(text: string, delimiter?: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = delimiter ?? detectDelimiter(src);

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  let line = 1; // line the cursor is on
  let recordLine = 1; // line the current record started on

  const endRecord = () => {
    cells.push(cur);
    cur = "";
    // Drop records with no content at all (blank line / all-empty cells).
    if (cells.some((c) => c.trim() !== "")) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
    recordLine = line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      cells.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\r") {
      if (src[i + 1] === "\n") i++; // CRLF counts as one terminator
      line++;
      endRecord();
      continue;
    }
    if (ch === "\n") {
      line++;
      endRecord();
      continue;
    }
    cur += ch;
  }
  // Final record (a file with no trailing newline).
  if (cur !== "" || cells.length > 0) endRecord();

  return records;
}

// ---------------------------------------------------------------------------
// Header resolution
// ---------------------------------------------------------------------------

const IGN_HEADERS = [
  "ign",
  "name",
  "displayname",
  "display name",
  "member",
  "character",
  "char",
];
const POWER_HEADERS = [
  "power",
  "power rating",
  "powerrating",
  "rating",
  "score",
  "gs",
  "gearscore",
];

function headerKey(s: string): string {
  return s.replace(/^﻿/, "").trim().toLowerCase();
}

export interface HeaderResolution {
  ok: boolean;
  nameIndex: number;
  powerIndex: number;
  /** true when the first record was consumed as a header row. */
  hasHeader: boolean;
  message?: string;
}

/**
 * Locate the IGN + Power columns. Falls back to a headerless two-column file
 * (name, number) so a bare paste still works; anything else is a hard error
 * with an explicit message (better than silently importing the wrong column).
 */
export function resolveHeader(first: CsvRecord | undefined): HeaderResolution {
  const fail = (message: string): HeaderResolution => ({
    ok: false,
    nameIndex: -1,
    powerIndex: -1,
    hasHeader: false,
    message,
  });
  if (!first) return fail("The file is empty.");

  const keys = first.cells.map(headerKey);
  const nameIndex = keys.findIndex((k) => IGN_HEADERS.indexOf(k) >= 0);
  const powerIndex = keys.findIndex((k) => POWER_HEADERS.indexOf(k) >= 0);
  if (nameIndex >= 0 && powerIndex >= 0 && nameIndex !== powerIndex) {
    return { ok: true, nameIndex, powerIndex, hasHeader: true };
  }

  // Headerless fallback: exactly two columns and the second one is a number.
  if (first.cells.length === 2 && parsePowerCell(first.cells[1]).ok) {
    return { ok: true, nameIndex: 0, powerIndex: 1, hasHeader: false };
  }

  return fail(
    'Could not find an "IGN" and a "Power" column. Expected a header row like ' +
      "`IGN,Power`.",
  );
}

// ---------------------------------------------------------------------------
// Power cell parsing
// ---------------------------------------------------------------------------

export interface PowerParse {
  ok: boolean;
  /** Clamped through normalizePower (non-negative int, capped 1,000,000). */
  value: number;
  /** Set when the clamp changed the value the file actually contained. */
  note: string | null;
  reason: string | null;
}

const NBSP_RE = /[   ]/g;

export function parsePowerCell(raw: string): PowerParse {
  const bad = (reason: string): PowerParse => ({
    ok: false,
    value: 0,
    note: null,
    reason,
  });
  const cleaned = (raw ?? "")
    .replace(NBSP_RE, " ")
    .replace(/[,\s_]/g, "")
    .trim();
  if (cleaned === "") return bad("Power is blank.");
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) {
    return bad(`"${raw.trim()}" is not a number.`);
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return bad(`"${raw.trim()}" is not a number.`);
  if (n < 0) return bad("Power cannot be negative.");

  const value = normalizePower(n);
  let note: string | null = null;
  if (n > 1_000_000) note = "Capped at 1,000,000.";
  else if (!Number.isInteger(n)) note = `Rounded down from ${n}.`;
  return { ok: true, value, note, reason: null };
}

export interface PreviewRow {
  /** 1-based index among DATA rows (header excluded). */
  rowNumber: number;
  /** 1-based source line, for pointing at the file. */
  line: number;
  rawName: string;
  rawPower: string;
  /** Normalized power; null on an error row. */
  power: number | null;
  /** Clamp note (capped / rounded), if any. */
  note: string | null;
  tier: MatchTier;
  /** Pre-selected target. Set for `exact` and for `suggested`; null otherwise. */
  userId: string | null;
  candidates: Candidate[];
  /** Why this row is an error, or why the match is only a suggestion. */
  reason: string | null;
  /** Set when the IGN belongs to the other guild's roster. */
  crossGuild: CrossGuildHit | null;
}

export interface PreviewCounts {
  total: number;
  exact: number;
  suggested: number;
  unmatched: number;
  error: number;
  /** Subset of `unmatched` that resolved to the OTHER guild. */
  crossGuild: number;
}

export interface ImportPreview {
  ok: boolean;
  message?: string;
  guild: Guild;
  rows: PreviewRow[];
  /** The target guild's ACTIVE roster — backs the manual-pick dropdown. */
  roster: RosterMember[];
  counts: PreviewCounts;
}

/**
 * CATEGORY 1 — "in the CSV, went nowhere". Rows carrying a power value that no
 * member of this guild claimed: unmatched rows (including the cross-guild ones)
 * plus malformed rows. These are the ones worth chasing in the source sheet.
 */
export function unresolvedRows(rows: PreviewRow[]): PreviewRow[] {
  return rows.filter((r) => r.tier === "unmatched" || r.tier === "error");
}

/**
 * CATEGORY 2 — "in the guild, absent from the CSV". Informational: these
 * members simply keep the power they already had. `covered` is the set of
 * userIds the user has actually confirmed, so this stays accurate as
 * suggestions are accepted or skipped.
 */
export function membersNotInCsv(
  roster: RosterMember[],
  covered: Set<string>,
): RosterMember[] {
  return membersNotCovered(roster, covered);
}

/** Tab-separated dump of the unresolved rows, for pasting back into a sheet. */
export function unresolvedAsTsv(rows: PreviewRow[]): string {
  const header = ["Row", "IGN", "Power", "Problem"].join("\t");
  const body = unresolvedRows(rows).map((r) =>
    [
      r.rowNumber,
      r.rawName,
      r.rawPower,
      r.crossGuild
        ? `Matches ${r.crossGuild.guildLabel} member "${r.crossGuild.displayName}" — not imported`
        : (r.reason ?? ""),
    ].join("\t"),
  );
  return [header, ...body].join("\n");
}

/**
 * Build the preview for one guild's roster. PURE — the caller supplies the
 * roster; this never touches a database.
 *
 * Two halves: the CSV-SPECIFIC half (delimiter, header, power cell, duplicate
 * IGN) lives here; the name matching is delegated to `matchNames` in
 * ./name-match, which the polarity DPS ranking importer calls the same way.
 *
 * `otherRoster` is the OTHER guild's active roster. It is used for REPORTING
 * ONLY: a CSV row that resolves there is flagged with an explicit reason
 * instead of a bare "not found", and is still never importable — the two
 * guilds are separate and an import targets exactly one of them.
 */
export function buildPreview(
  guild: Guild,
  csvText: string,
  roster: RosterMember[],
  otherRoster: RosterMember[] = [],
): ImportPreview {
  const empty: ImportPreview = {
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
    },
  };

  if (typeof csvText !== "string" || csvText.trim() === "") {
    return { ...empty, message: "No CSV content." };
  }
  if (csvText.length > MAX_CSV_CHARS) {
    return {
      ...empty,
      message: `File is too large (${csvText.length} characters, limit ${MAX_CSV_CHARS}).`,
    };
  }

  const records = parseCsv(csvText);
  const header = resolveHeader(records[0]);
  if (!header.ok) return { ...empty, message: header.message };

  const dataRecords = header.hasHeader ? records.slice(1) : records;
  if (dataRecords.length === 0) {
    return { ...empty, message: "The file has a header but no data rows." };
  }
  if (dataRecords.length > MAX_CSV_ROWS) {
    return {
      ...empty,
      message: `Too many rows (${dataRecords.length}, limit ${MAX_CSV_ROWS}).`,
    };
  }

  // ---- pass 1: parse cells; malformed rows never reach the matcher -------
  const rows: PreviewRow[] = [];
  const toMatch: NameEntry<number>[] = [];
  // canonical IGN -> the row number that first used it (duplicate detection).
  const seenIgn = new Map<string, number>();

  dataRecords.forEach((rec, i) => {
    const rowNumber = i + 1;
    const rawName = (rec.cells[header.nameIndex] ?? "").trim();
    const rawPower = (rec.cells[header.powerIndex] ?? "").trim();

    const base: PreviewRow = {
      rowNumber,
      line: rec.line,
      rawName,
      rawPower,
      power: null,
      note: null,
      tier: "error",
      userId: null,
      candidates: [],
      reason: null,
      crossGuild: null,
    };

    if (rawName === "") {
      rows.push({ ...base, reason: "IGN is blank." });
      return;
    }
    const power = parsePowerCell(rawPower);
    if (!power.ok) {
      rows.push({ ...base, reason: power.reason });
      return;
    }

    const canon = canonicalName(rawName);
    const dupOf = seenIgn.get(canon);
    if (dupOf !== undefined) {
      rows.push({
        ...base,
        power: power.value,
        note: power.note,
        reason: `Duplicate IGN — already imported on row ${dupOf}.`,
      });
      return;
    }
    seenIgn.set(canon, rowNumber);

    rows.push({
      ...base,
      power: power.value,
      note: power.note,
      tier: "unmatched",
    });
    toMatch.push({ key: rowNumber, rawName });
  });

  // ---- pass 2: SHARED name matching --------------------------------------
  const matches = matchNames(guild, toMatch, roster, otherRoster);
  for (const row of rows) {
    const m = matches.get(row.rowNumber);
    if (!m) continue; // an error row — never matched
    row.tier = m.tier;
    row.userId = m.userId;
    row.candidates = m.candidates;
    row.reason = m.reason;
    row.crossGuild = m.crossGuild;
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
    },
  };
}

// ---------------------------------------------------------------------------
// Apply — the decision list the UI sends back, and the report it gets.
// ---------------------------------------------------------------------------

/** One confirmed row: "set THIS member's power to THIS value". */
export interface ImportDecision {
  rowNumber: number;
  userId: string;
  power: number;
}

export type SkipReason =
  | "not-in-guild"
  | "unknown-member"
  | "duplicate-target"
  | "no-meta-row"
  | "invalid";

export interface SkippedDecision {
  rowNumber: number;
  userId: string;
  displayName: string | null;
  reason: SkipReason;
  detail: string;
}

export interface AppliedChange {
  userId: string;
  displayName: string;
  from: number;
  to: number;
}

export interface ApplyReport {
  ok: boolean;
  message?: string;
  guild: Guild;
  /** Power actually changed. */
  updated: number;
  /** Target already had this exact power — no write needed. */
  unchanged: number;
  /** Rejected server-side; every one carries a reason. */
  skipped: number;
  /** Roster members with no confirmed row — their power was left as-is. */
  untouched: number;
  changes: AppliedChange[];
  skippedRows: SkippedDecision[];
}

/**
 * Validate the decision list against the guild roster. PURE — the caller does
 * the writing. Enforces, server-side and independently of the UI:
 *   - every target exists AND belongs to the guild being imported (Daddy and
 *     Mummy are separate guilds and must never be crossed);
 *   - power goes through normalizePower;
 *   - one target per import (a second row for the same member is skipped, the
 *     first one wins, and the skip is reported).
 */
export function planApply(
  guild: Guild,
  decisions: ImportDecision[],
  roster: RosterMember[],
  otherGuildIds: Set<string>,
): {
  writes: { userId: string; power: number; from: number; displayName: string }[];
  unchanged: AppliedChange[];
  skipped: SkippedDecision[];
} {
  const byId = new Map(roster.map((m) => [m.userId, m]));
  const writes: {
    userId: string;
    power: number;
    from: number;
    displayName: string;
  }[] = [];
  const unchanged: AppliedChange[] = [];
  const skipped: SkippedDecision[] = [];
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

    const power = normalizePower(d.power);
    if (power === member.power) {
      unchanged.push({
        userId,
        displayName: member.displayName,
        from: member.power,
        to: power,
      });
      continue;
    }
    writes.push({
      userId,
      power,
      from: member.power,
      displayName: member.displayName,
    });
  }

  return { writes, unchanged, skipped };
}
