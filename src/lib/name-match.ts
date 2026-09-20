// SHARED in-game-name → member matcher.
//
// EXTRACTED VERBATIM from power-import.ts so a second importer — the Polarity
// DPS ranking paste (ranking-import.ts) — can reuse the exact same matching
// engine instead of growing a parallel copy of it. The two importers read
// completely different FORMATS (RFC-4180 CSV vs a fixed-width ranking table)
// but they have the identical MATCHING problem, and that problem is the hard
// half. power-import.ts re-exports everything here, so its public surface is
// unchanged and its callers did not need touching.
//
// Behaviour is pinned by scripts/verify-power-import.ts, which was written and
// run against the pre-extraction code: the digest in that file is what the old
// power-import.ts produced, and it must keep matching.
//
// PURE — no Mongo, no Next, no "server-only". Deterministic functions over
// plain data.
//
// WHY NAME MATCHING AT ALL: an import's join key is the in-game name (IGN), and
// IGN is not stored anywhere in the database. What we have is
// `members.displayName`, which the bot's membersync writes as the Discord
// server NICKNAME (falling back to username). Guild onboarding tells members to
// set their nickname to their IGN, so displayName is the de-facto IGN — but it
// is human-typed, so it drifts: homoglyphs (ApoIIo / Kıte / Skÿlash / O1teen),
// decoration after a separator ("Oppades | Gem"), trailing punctuation
// ("Juls."), and outright spelling drift.
//
// THREE TIERS, and the tier decides how much trust the row gets:
//   exact     — canonical key equality (NFKC + zero-width strip + whitespace
//               collapse + case fold). Auto-selected.
//   suggested — an aggressive fold (diacritics, confusables, punctuation),
//               a separator prefix on either side, a username hit, containment,
//               or bigram similarity. NEVER auto-applied; needs confirmation.
//   unmatched — no candidate above threshold. The user picks or skips.
// A fourth tier, `error`, belongs to the CALLER: a row that is malformed never
// reaches the matcher at all.

import { GUILD_LABEL, type Guild } from "./types";

// Score at/above which a fuzzy candidate is worth pre-selecting as a suggestion.
export const SUGGEST_THRESHOLD = 0.5;
// Shortest needle allowed for the "one name contains the other" heuristic.
export const MIN_CONTAINMENT_LEN = 3;
// How many candidates to surface per row.
export const MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

// Zero-width / invisible formatting characters + soft hyphen.
const INVISIBLE_RE = /[­​-‏⁠-⁤﻿]/g;

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

/** The subset of a member an importer needs. Always ONE guild's roster. */
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
 * An imported row that resolves to a member of the OTHER guild. Reported
 * explicitly rather than as a bare "not found": the row is data that went
 * nowhere, and the reason ("that's a Mummy member, you're importing Daddy") is
 * the actionable part. Never importable — imports never cross guilds.
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

/** What the matcher decided about one name. `error` is never returned here. */
export interface NameMatch {
  tier: "exact" | "suggested" | "unmatched";
  /** Pre-selected target. Set for `exact` and for `suggested`; null otherwise. */
  userId: string | null;
  candidates: Candidate[];
  /** Why the match is only a suggestion, or why there is none. */
  reason: string | null;
  /** Set when the IGN belongs to the other guild's roster. */
  crossGuild: CrossGuildHit | null;
  /** The tier-1 key, exposed so callers can dedupe on it. */
  canon: string;
  /** The tier-2 key. */
  fold: string;
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

/** One name awaiting a match, tagged with whatever key the caller wants back. */
export interface NameEntry<K> {
  key: K;
  rawName: string;
}

/**
 * Match a batch of IGNs against ONE guild's roster. PURE — the caller supplies
 * the roster; this never touches a database.
 *
 * TWO PASSES, and the order matters. Pass 1 resolves every canonical-exact hit
 * and CLAIMS those userIds; pass 2 then scores fuzzy candidates for everything
 * left, and may never offer a claimed member. That is why this takes the whole
 * batch rather than one name at a time: a fuzzy row must not steal the member
 * that a later row matches exactly. Pass-2 rows are independent of each other,
 * so their relative order does not affect the result.
 *
 * `otherRoster` is the OTHER guild's active roster. It is used for REPORTING
 * ONLY: a row that resolves there is flagged with an explicit reason instead of
 * a bare "not found", and is still never importable — the two guilds are
 * separate and an import targets exactly one of them.
 *
 * Callers pass only rows that already parsed: blank/malformed/duplicate rows
 * are the caller's `error` tier and never reach here.
 */
export function matchNames<K>(
  guild: Guild,
  entries: NameEntry<K>[],
  roster: RosterMember[],
  otherRoster: RosterMember[] = [],
): Map<K, NameMatch> {
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
  const crossGuildHit = (canon: string, fold: string): CrossGuildHit | null => {
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

  // ---- pass 1: exact matching -------------------------------------------
  interface Draft extends NameMatch {
    key: K;
    prefixFold: string | null;
  }

  const drafts: Draft[] = [];
  // userIds claimed by an EXACT match; a fuzzy suggestion may not steal them.
  const claimed = new Set<string>();

  for (const entry of entries) {
    const rawName = entry.rawName;
    const canon = canonicalName(rawName);
    const prefix = prefixBeforeSeparator(rawName);
    const draft: Draft = {
      key: entry.key,
      tier: "unmatched",
      userId: null,
      candidates: [],
      reason: null,
      crossGuild: null,
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
  }

  // ---- pass 2: candidates for everything not exactly matched ------------
  for (const draft of drafts) {
    if (draft.tier === "exact") continue;
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
    // c) the IMPORTED name carries decoration after a separator.
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
    const crossWins = draft.crossGuild !== null && (!best || best.score < 0.9);

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

  const out = new Map<K, NameMatch>();
  for (const d of drafts) {
    out.set(d.key, {
      tier: d.tier,
      userId: d.userId,
      candidates: d.candidates,
      reason: d.reason,
      crossGuild: d.crossGuild,
      canon: d.canon,
      fold: d.fold,
    });
  }
  return out;
}

/**
 * CATEGORY 2 of every importer's preview — "in the guild, absent from the
 * import". Informational: these members simply keep what they already had.
 * `covered` is the set of userIds the user has actually confirmed, so this
 * stays accurate as suggestions are accepted or skipped.
 */
export function membersNotCovered(
  roster: RosterMember[],
  covered: Set<string>,
): RosterMember[] {
  return roster.filter((m) => !covered.has(m.userId));
}
