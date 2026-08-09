// CSV power-rating import: parsing, name normalization and member matching.
//
// PURE module — no Mongo, no Next, no "server-only". Everything here is a
// deterministic function over plain data so the exact same code can be unit
// tested standalone and reused by the server action (src/lib/power-import-actions.ts)
// and the preview UI (src/components/PowerImportModal.tsx).
//
// WHY NAME MATCHING AT ALL: the CSV's join key is the in-game name (IGN), and
// IGN is not stored anywhere in the database. What we have is `members.displayName`,
// which the bot's membersync writes as the Discord server NICKNAME (falling back
// to username). Guild onboarding tells members to set their nickname to their
// IGN, so displayName is the de-facto IGN — but it is human-typed, so it drifts:
// homoglyphs (ApoIIo / Kıte / Skÿlash / O1teen), decoration after a separator
// ("Oppades | Gem"), trailing punctuation ("Juls."), and outright spelling drift.
//
// THREE TIERS, and the tier decides how much trust the row gets:
//   exact     — canonical key equality (NFKC + zero-width strip + whitespace
//               collapse + case fold). Auto-selected.
//   suggested — an aggressive fold (diacritics, confusables, punctuation),
//               a separator prefix on either side, a username hit, containment,
//               or bigram similarity. NEVER auto-applied; needs confirmation.
//   unmatched — no candidate above threshold. The user picks or skips.
// Anything malformed is `error` and carries a per-row reason (a bad row never
// fails the whole file).
//
// Power ratings are hand-maintained data: this module only ever DESCRIBES what
// an import would do. Nothing here writes.

import { GUILD_LABEL, normalizePower, type Guild } from "./types";

// ---------------------------------------------------------------------------
// Limits (defence in depth — also enforced in the server action).
// ---------------------------------------------------------------------------

export const MAX_CSV_CHARS = 1_000_000;
export const MAX_CSV_ROWS = 5_000;

// Score at/above which a fuzzy candidate is worth pre-selecting as a suggestion.
export const SUGGEST_THRESHOLD = 0.5;
// Shortest needle allowed for the "one name contains the other" heuristic.
export const MIN_CONTAINMENT_LEN = 3;
// How many candidates to surface per row.
export const MAX_CANDIDATES = 5;

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

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

// Zero-width / invisible formatting characters + soft hyphen.
const INVISIBLE_RE = /[­​-‏⁠⁡⁢⁣⁤﻿]/g;

/**
 * TIER-1 key. Conservative: NFKC, strip invisibles, collapse whitespace, trim,
 * case fold. Two names equal under this are treated as the same person and the
 * row is auto-selected.
 */
export function canonicalName(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Letters that survive NFKC/NFD but read as another letter.
const LETTER_CONFUSABLES: [RegExp, string][] = [
  [/[ıİ]/g, "i"], // ı dotless i, İ dotted capital I
  [/[łŁŀĿ]/g, "l"], // ł Ł ŀ Ŀ
  [/[øØǿǾ]/g, "o"], // ø Ø ǿ Ǿ
  [/[đĐðÐ]/g, "d"], // đ Đ ð Ð
  [/[æÆ]/g, "ae"],
  [/[œŒ]/g, "oe"],
  [/[þÞ]/g, "th"],
  [/[ß]/g, "ss"],
  [/[ħĦ]/g, "h"],
  [/[ŧŦ]/g, "t"],
];

// Punctuation + whitespace to drop entirely in the aggressive fold.
// ASCII punctuation ranges + general punctuation + CJK/fullwidth punctuation.
// (Deliberately NOT \p{...} — the tsconfig target predates property escapes.)
const FOLD_STRIP_RE =
  /[\s!-\/:-@\[-`{-~ -⁯　-〿！-／：-＠［-｀｛-･]/g;

// Combining marks left over after NFD.
const COMBINING_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃰]/g;

/**
 * TIER-2 key. Everything canonicalName does, plus: letter confusables,
 * diacritic strip (NFD + combining-mark removal), all punctuation/whitespace
 * removed, and the two confusable digit/letter classes folded —
 *   i l 1 | ! ¡  -> "1"      (ApoIIo == Apollo, Kıte == Kite)
 *   o 0 ° º      -> "0"      (O1teen == 01teen)
 * Non-Latin scripts (CJK etc.) pass through untouched.
 * A fold hit is only ever a SUGGESTION — it is never auto-applied.
 */
export function foldName(s: string): string {
  let t = canonicalName(s);
  for (const [re, to] of LETTER_CONFUSABLES) t = t.replace(re, to);
  t = t.normalize("NFD").replace(COMBINING_RE, "").normalize("NFC");
  t = t.replace(FOLD_STRIP_RE, "");
  t = t.replace(/[il|!¡]/g, "1");
  t = t.replace(/[o°º]/g, "0");
  return t;
}

// A separator that introduces decoration: "Oppades | Gem", "MinROO/Mintz",
// "笑熙熙 - Hoontar", "Madame~". A bare hyphen only counts when it is spaced,
// so a hyphenated name ("Dr-Beast") is left alone.
const SEPARATOR_RE = /\s*[|/\\~,;:•·–—]\s*|\s+[-]\s+|\s*[([{【「]\s*/;

/** The part of a name before its first decoration separator, or null. */
export function prefixBeforeSeparator(s: string): string | null {
  const src = (s ?? "").trim();
  const m = SEPARATOR_RE.exec(src);
  if (!m || m.index <= 0) return null;
  const head = src.slice(0, m.index).trim();
  if (!head || head === src) return null;
  if (head.length < 2) return null;
  return head;
}

/** Sørensen–Dice coefficient over character bigrams of two folded strings. */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = bigrams.get(g) ?? 0;
    if (n > 0) {
      bigrams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** The subset of a member the importer needs. Always ONE guild's roster. */
export interface RosterMember {
  userId: string;
  displayName: string;
  username: string;
  className: string | null;
  power: number;
}

export type MatchTier = "exact" | "suggested" | "unmatched" | "error";

export interface Candidate {
  userId: string;
  displayName: string;
  /** 0–1; 1 is a fold-exact hit. */
  score: number;
  /** Human-readable why, shown next to the candidate. */
  reason: string;
}

/**
 * A CSV row that resolves to a member of the OTHER guild. Reported explicitly
 * rather than as a bare "not found": the row is data that went nowhere, and the
 * reason ("that's a Mummy member, you're importing Daddy") is the actionable
 * part. Never importable — imports never cross guilds.
 */
export interface CrossGuildHit {
  userId: string;
  displayName: string;
  /** The guild the hit belongs to (i.e. NOT the one being imported). */
  guild: Guild;
  guildLabel: string;
  /** "exact" = canonical name equality, "fold" = matched after folding. */
  via: "exact" | "fold";
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
  return roster.filter((m) => !covered.has(m.userId));
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

interface MemberKeys {
  member: RosterMember;
  canon: string;
  fold: string;
  prefixFold: string | null;
  usernameFold: string;
}

function pushMulti<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Build the preview for one guild's roster. PURE — the caller supplies the
 * roster; this never touches a database.
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

  // ---- index the roster -------------------------------------------------
  const keyed: MemberKeys[] = roster.map((member) => {
    const prefix = prefixBeforeSeparator(member.displayName);
    return {
      member,
      canon: canonicalName(member.displayName),
      fold: foldName(member.displayName),
      prefixFold: prefix ? foldName(prefix) : null,
      usernameFold: foldName(member.username),
    };
  });

  const byCanon = new Map<string, MemberKeys[]>();
  const byFold = new Map<string, MemberKeys[]>();
  const byPrefixFold = new Map<string, MemberKeys[]>();
  const byUsernameFold = new Map<string, MemberKeys[]>();
  for (const k of keyed) {
    pushMulti(byCanon, k.canon, k);
    pushMulti(byFold, k.fold, k);
    if (k.prefixFold) pushMulti(byPrefixFold, k.prefixFold, k);
    if (k.usernameFold) pushMulti(byUsernameFold, k.usernameFold, k);
  }

  // The OTHER guild, indexed for reporting only (never an import target).
  const otherGuild: Guild = guild === "daddy" ? "mummy" : "daddy";
  const otherByCanon = new Map<string, RosterMember>();
  const otherByFold = new Map<string, RosterMember>();
  for (const m of otherRoster) {
    const c = canonicalName(m.displayName);
    const f = foldName(m.displayName);
    if (c && !otherByCanon.has(c)) otherByCanon.set(c, m);
    if (f && !otherByFold.has(f)) otherByFold.set(f, m);
  }
  const crossGuildHit = (
    canon: string,
    fold: string,
  ): CrossGuildHit | null => {
    const exact = otherByCanon.get(canon);
    if (exact) {
      return {
        userId: exact.userId,
        displayName: exact.displayName,
        guild: otherGuild,
        guildLabel: GUILD_LABEL[otherGuild],
        via: "exact",
      };
    }
    const folded = fold ? otherByFold.get(fold) : undefined;
    if (folded) {
      return {
        userId: folded.userId,
        displayName: folded.displayName,
        guild: otherGuild,
        guildLabel: GUILD_LABEL[otherGuild],
        via: "fold",
      };
    }
    return null;
  };

  // ---- pass 1: parse cells + exact matching -----------------------------
  interface Draft extends PreviewRow {
    canon: string;
    fold: string;
    prefixFold: string | null;
  }

  const drafts: Draft[] = [];
  // canonical IGN -> the row number that first used it (duplicate detection).
  const seenIgn = new Map<string, number>();
  // userIds claimed by an EXACT match; a fuzzy suggestion may not steal them.
  const claimed = new Set<string>();

  dataRecords.forEach((rec, i) => {
    const rowNumber = i + 1;
    const rawName = (rec.cells[header.nameIndex] ?? "").trim();
    const rawPower = (rec.cells[header.powerIndex] ?? "").trim();

    const base: Draft = {
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
      canon: "",
      fold: "",
      prefixFold: null,
    };

    if (rawName === "") {
      drafts.push({ ...base, reason: "IGN is blank." });
      return;
    }
    const power = parsePowerCell(rawPower);
    if (!power.ok) {
      drafts.push({ ...base, reason: power.reason });
      return;
    }

    const canon = canonicalName(rawName);
    const dupOf = seenIgn.get(canon);
    if (dupOf !== undefined) {
      drafts.push({
        ...base,
        power: power.value,
        note: power.note,
        reason: `Duplicate IGN — already imported on row ${dupOf}.`,
      });
      return;
    }
    seenIgn.set(canon, rowNumber);

    const prefix = prefixBeforeSeparator(rawName);
    const draft: Draft = {
      ...base,
      power: power.value,
      note: power.note,
      tier: "unmatched",
      canon,
      fold: foldName(rawName),
      prefixFold: prefix ? foldName(prefix) : null,
    };

    const hits = byCanon.get(canon);
    if (hits && hits.length === 1) {
      draft.tier = "exact";
      draft.userId = hits[0].member.userId;
      claimed.add(hits[0].member.userId);
    } else if (hits && hits.length > 1) {
      // Two roster members share a display name — never guess.
      draft.tier = "suggested";
      draft.reason = `${hits.length} members share this name — pick one.`;
      draft.candidates = hits.map((h) => ({
        userId: h.member.userId,
        displayName: h.member.displayName,
        score: 1,
        reason: "exact name (ambiguous)",
      }));
    }
    drafts.push(draft);
  });

  // ---- pass 2: candidates for everything not exactly matched ------------
  for (const draft of drafts) {
    if (draft.tier === "error" || draft.tier === "exact") continue;
    if (draft.candidates.length > 0) continue; // ambiguous rows keep their list

    const scored = new Map<string, Candidate>();
    const offer = (k: MemberKeys, score: number, reason: string) => {
      if (claimed.has(k.member.userId)) return; // taken by an exact match
      const prev = scored.get(k.member.userId);
      if (!prev || score > prev.score) {
        scored.set(k.member.userId, {
          userId: k.member.userId,
          displayName: k.member.displayName,
          score,
          reason,
        });
      }
    };

    // a) aggressive fold equality — homoglyphs, diacritics, punctuation.
    for (const k of byFold.get(draft.fold) ?? []) {
      offer(k, 0.97, "same name after homoglyph/diacritic folding");
    }
    // b) the MEMBER's name carries decoration after a separator.
    for (const k of byPrefixFold.get(draft.fold) ?? []) {
      offer(k, 0.92, "member name has extra text after a separator");
    }
    // c) the CSV name carries decoration after a separator.
    if (draft.prefixFold) {
      for (const k of byFold.get(draft.prefixFold) ?? []) {
        offer(k, 0.92, "CSV name has extra text after a separator");
      }
    }
    // d) Discord username (membersync falls back to it when there's no nickname).
    for (const k of byUsernameFold.get(draft.fold) ?? []) {
      offer(k, 0.85, "matches the Discord username");
    }
    // e/f) containment + bigram similarity across the remaining roster.
    for (const k of keyed) {
      if (claimed.has(k.member.userId)) continue;
      const a = draft.fold;
      const b = k.fold;
      if (!a || !b) continue;
      if (
        a !== b &&
        ((a.length >= MIN_CONTAINMENT_LEN && b.indexOf(a) >= 0) ||
          (b.length >= MIN_CONTAINMENT_LEN && a.indexOf(b) >= 0))
      ) {
        offer(k, 0.8, "one name contains the other");
      }
      // Fold-equal pairs are already offered above with a far more useful
      // reason ("same name after homoglyph/diacritic folding"); scoring them
      // again at dice=1.0 would just relabel them "100% similar".
      if (a === b) continue;
      const sim = diceSimilarity(a, b);
      if (sim >= SUGGEST_THRESHOLD) {
        offer(k, sim, `${Math.round(sim * 100)}% similar`);
      }
    }

    const candidates = Array.from(scored.values()).sort((x, y) =>
      y.score !== x.score
        ? y.score - x.score
        : x.displayName.localeCompare(y.displayName) ||
          x.userId.localeCompare(y.userId),
    );
    draft.candidates = candidates.slice(0, MAX_CANDIDATES);
    draft.crossGuild = crossGuildHit(draft.canon, draft.fold);

    const best = draft.candidates[0];
    // A cross-guild hit beats a merely-fuzzy in-guild candidate: an IGN that is
    // literally another guild's member is far more likely to be exactly that
    // than a 60%-similar name on this roster. A strong in-guild hit (fold /
    // separator-prefix level, >= 0.9) still wins, since this IS the guild being
    // imported.
    const crossWins =
      draft.crossGuild !== null && (!best || best.score < 0.9);

    if (crossWins && draft.crossGuild) {
      draft.tier = "unmatched";
      draft.userId = null;
      draft.reason =
        `Matches ${draft.crossGuild.guildLabel} member "${draft.crossGuild.displayName}" — ` +
        `not imported (you are importing ${GUILD_LABEL[guild]}).`;
    } else if (best && best.score >= SUGGEST_THRESHOLD) {
      draft.tier = "suggested";
      draft.userId = best.userId;
      draft.reason = `Not an exact name match — ${best.reason}. Confirm before applying.`;
    } else {
      draft.tier = "unmatched";
      draft.userId = null;
      draft.reason =
        draft.candidates.length > 0
          ? "No confident match — pick a member or skip."
          : "No member of this guild found — pick a member or skip.";
    }
  }

  const rows: PreviewRow[] = drafts.map((d) => ({
    rowNumber: d.rowNumber,
    line: d.line,
    rawName: d.rawName,
    rawPower: d.rawPower,
    power: d.power,
    note: d.note,
    tier: d.tier,
    userId: d.userId,
    candidates: d.candidates,
    reason: d.reason,
    crossGuild: d.crossGuild,
  }));

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
