"use client";

import { useMemo, useRef, useState } from "react";
import {
  applyRankingImport,
  previewRankingImport,
} from "@/lib/ranking-actions";
import {
  membersNotInRanking,
  unresolvedRankingAsTsv,
  type RankingApplyReport,
  type RankingDecision,
  type RankingPreview,
  type RankingPreviewRow,
} from "@/lib/ranking-import";
import type { RosterMember } from "@/lib/name-match";
import { GUILD_LABEL, type Guild } from "@/lib/types";

// Polarity DPS ranking importer — PREVIEW, then APPLY. Nothing is written until
// the user presses Apply, and only the rows they confirmed are sent.
//
// The input is the ranking board PASTED AS TEXT. Several blocks at once is the
// normal case, each with its own header and ─── rule; the parser strips those
// wherever they appear.
//
// The preview splits the paste into the same five explicit buckets the CSV
// power importer uses, so nothing is ever silently dropped:
//   1. Exact matches            — auto-selected, untickable per row.
//   2. Needs review             — a suggestion; NOT selected until confirmed.
//   3. In the paste, no member  — the loud one. Data that went nowhere, incl.
//                                 rows that are really the other guild's members.
//   4. Malformed rows           — per-row reason, never fails the paste.
//   5. In guild, not in paste   — informational; their stored DPS is untouched.
//
// This writes to the web-owned `polarityDps` collection ONLY. It never touches
// `memberMeta.power`, so the leaderboard, the GvG builder and Siege are
// unaffected by anything done here.

type Phase = "input" | "preview" | "done";

const SKIP = "";

const PLACEHOLDER = [
  "  #     DPS   Total   Dead  Class       Submitted    Member",
  "───────────────────────────────────────────────────────────",
  "  1   11.8M   1.40B   2.0s  Paladin     08-31 14:12  Solar",
  "  2   8.14M    960M   2.0s  Priest      09-08 03:08  Darasaki",
].join("\n");

/** Decode an uploaded file, honouring a UTF-8/UTF-16 BOM. */
async function decodeFile(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  return new TextDecoder("utf-8").decode(buf);
}

/** RFC 4180 quoting for the downloadable "unresolved" report. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function unresolvedAsCsv(rows: RankingPreviewRow[]): string {
  const header = ["Row", "Member", "DPS", "Submitted", "Problem"]
    .map(csvCell)
    .join(",");
  const body = rows.map((r) =>
    [
      r.rowNumber,
      r.rawName,
      r.rawDps,
      r.rawSubmitted,
      r.crossGuild
        ? `Matches ${r.crossGuild.guildLabel} member "${r.crossGuild.displayName}" — not imported`
        : (r.reason ?? ""),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...body].join("\r\n");
}

/** 11800000 → "11.8M". Display only — the stored value is the exact integer. */
function fmtDps(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "bad" | "muted";
}) {
  const cls =
    tone === "ok"
      ? "border-emerald-400/40 text-emerald-300"
      : tone === "warn"
        ? "border-amber-400/50 text-amber-300"
        : tone === "bad"
          ? "border-red-400/50 text-red-300"
          : "border-indigo-400/30 text-slate-300";
  return (
    <span
      className={`rounded-lg border bg-indigo-950/30 px-2.5 py-1 text-xs ${cls}`}
    >
      <span className="font-bold tabular-nums">{value}</span>{" "}
      <span className="text-slate-400">{label}</span>
    </span>
  );
}

function RosterSelect({
  value,
  roster,
  row,
  onChange,
}: {
  value: string;
  roster: RosterMember[];
  row: RankingPreviewRow;
  onChange: (v: string) => void;
}) {
  const candidateIds = new Set(row.candidates.map((c) => c.userId));
  const rest = roster.filter((m) => !candidateIds.has(m.userId));
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full max-w-[260px] rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2 py-1 text-xs text-slate-100"
    >
      <option value={SKIP}>— skip this row —</option>
      {row.candidates.length > 0 && (
        <optgroup label="Suggested">
          {row.candidates.map((c) => (
            <option key={c.userId} value={c.userId}>
              {c.displayName} ({Math.round(c.score * 100)}% · {c.reason})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="All members">
        {rest.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.displayName}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export function RankingImportModal({
  guild,
  onClose,
  onApplied,
}: {
  guild: Guild;
  onClose: () => void;
  onApplied: (updated: number) => void;
}) {
  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<RankingPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [report, setReport] = useState<RankingApplyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showNotInPaste, setShowNotInPaste] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const rowsByTier = useMemo(() => {
    const rows = preview?.rows ?? [];
    return {
      exact: rows.filter((r) => r.tier === "exact"),
      suggested: rows.filter((r) => r.tier === "suggested"),
      unmatched: rows.filter((r) => r.tier === "unmatched"),
      error: rows.filter((r) => r.tier === "error"),
    };
  }, [preview]);

  // Live: which members a confirmed row currently targets.
  const covered = useMemo(() => {
    const set = new Set<string>();
    for (const v of Object.values(choices)) if (v) set.add(v);
    return set;
  }, [choices]);

  const notInPaste = useMemo(
    () => membersNotInRanking(preview?.roster ?? [], covered),
    [preview, covered],
  );

  const selectedCount = covered.size;

  async function handleFile(file: File | null) {
    if (!file) return;
    setError(null);
    if (file.size > 2_000_000) {
      setError("That file is larger than 2 MB.");
      return;
    }
    try {
      setText(await decodeFile(file));
      setFileName(file.name);
    } catch {
      setError("Could not read that file.");
    }
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await previewRankingImport(guild, text);
      if (!result.ok) {
        setError(result.message ?? "Could not read that ranking.");
        return;
      }
      const next: Record<number, string> = {};
      for (const r of result.rows) {
        // Exact matches are pre-selected. Suggestions are NOT — they require an
        // explicit confirmation, which is the whole point of the tier.
        next[r.rowNumber] = r.tier === "exact" ? (r.userId ?? SKIP) : SKIP;
      }
      setPreview(result);
      setChoices(next);
      setPhase("preview");
    } catch {
      setError("The preview failed. Check the server logs.");
    } finally {
      setBusy(false);
    }
  }

  function acceptAllSuggestions() {
    setChoices((prev) => {
      const next = { ...prev };
      for (const r of rowsByTier.suggested) {
        if (r.userId) next[r.rowNumber] = r.userId;
      }
      return next;
    });
  }

  async function runApply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const decisions: RankingDecision[] = preview.rows
        .filter(
          (r) =>
            r.dps !== null && r.submittedAt !== null && choices[r.rowNumber],
        )
        .map((r) => ({
          rowNumber: r.rowNumber,
          userId: choices[r.rowNumber],
          dps: r.dps as number,
          total: r.total ?? 0,
          deadSeconds: r.deadSeconds ?? 0,
          className: r.className ?? "",
          submittedAt: r.submittedAt as string,
        }));
      if (decisions.length === 0) {
        setError("Nothing selected to apply.");
        return;
      }
      const result = await applyRankingImport(guild, decisions);
      if (!result.ok) {
        setError(result.message ?? "The import failed.");
        return;
      }
      setReport(result);
      onApplied(result.updated);
      setPhase("done");
    } catch {
      setError("The import failed. Check the server logs.");
    } finally {
      setBusy(false);
    }
  }

  async function copyUnresolved() {
    const rows = [...rowsByTier.unmatched, ...rowsByTier.error];
    try {
      await navigator.clipboard.writeText(unresolvedRankingAsTsv(rows));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard blocked — use Download instead.");
    }
  }

  function downloadUnresolved() {
    const rows = [...rowsByTier.unmatched, ...rowsByTier.error];
    const blob = new Blob([unresolvedAsCsv(rows)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${guild}-dps-import-unresolved.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="neon-edge my-4 w-full max-w-4xl rounded-2xl border border-indigo-400/40 bg-gradient-to-b from-[#161634] to-[#10101f] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-100">
              Import DPS ranking — {GUILD_LABEL[guild]}
            </h2>
            <p className="text-xs text-slate-400">
              Paste the ranking board — several blocks at once is fine, headers
              and rule lines are ignored. The Member column is matched against
              each member&apos;s Discord display name. This feeds the two{" "}
              <strong>Polarity main raids</strong> only; it does not touch power
              ratings. Nothing is saved until you press Apply.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 rounded px-2 py-1 text-slate-400 hover:text-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-400/50 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        {/* ---------------- STEP 1: input ---------------- */}
        {phase === "input" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-indigo-400/30 bg-indigo-950/20 p-4">
              <label className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                Paste the ranking
              </label>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setFileName(null);
                }}
                rows={14}
                spellCheck={false}
                placeholder={PLACEHOLDER}
                className="mt-2 w-full rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2.5 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Duplicates across blocks are collapsed to the{" "}
                <strong>latest Submitted</strong> entry, even when its DPS is
                lower.
              </p>
            </div>

            <div className="rounded-xl border border-indigo-400/30 bg-indigo-950/20 p-4">
              <label className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                …or load a .txt
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.csv,text/plain"
                  onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-gradient-to-r file:from-indigo-600 file:to-fuchsia-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
                />
                {fileName && (
                  <span className="text-xs text-slate-400">
                    {fileName} · {text.length.toLocaleString()} chars
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-indigo-400/30 bg-indigo-950/50 px-4 py-1.5 text-sm text-indigo-100 hover:bg-indigo-900/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={runPreview}
                disabled={busy || text.trim() === ""}
                className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-4 py-1.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
              >
                {busy ? "Reading…" : "Preview"}
              </button>
            </div>
          </div>
        )}

        {/* ---------------- STEP 2: preview ---------------- */}
        {phase === "preview" && preview && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Pill label="rows" value={preview.counts.total} tone="muted" />
              <Pill label="exact" value={preview.counts.exact} tone="ok" />
              <Pill
                label="need review"
                value={preview.counts.suggested}
                tone="warn"
              />
              <Pill
                label="no member here"
                value={preview.counts.unmatched}
                tone="bad"
              />
              <Pill label="malformed" value={preview.counts.error} tone="bad" />
              <Pill
                label="dupes collapsed"
                value={preview.counts.duplicatesCollapsed}
                tone="muted"
              />
              <span className="ml-auto text-xs text-slate-400">
                <span className="font-bold text-slate-100 tabular-nums">
                  {selectedCount}
                </span>{" "}
                selected to apply
              </span>
            </div>

            {/* --- 1. exact --- */}
            <section className="rounded-xl border border-emerald-400/30 bg-[#10101f] p-4">
              <h3 className="mb-2 text-sm font-bold text-emerald-200">
                Exact matches ({rowsByTier.exact.length})
              </h3>
              <p className="mb-2 text-[11px] text-slate-500">
                Name matched exactly. Pre-selected — untick any row to leave that
                member alone.
              </p>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {rowsByTier.exact.map((r) => (
                      <tr
                        key={r.rowNumber}
                        className="border-t border-indigo-500/10"
                      >
                        <td className="w-8 py-1">
                          <input
                            type="checkbox"
                            checked={choices[r.rowNumber] === r.userId}
                            onChange={(e) =>
                              setChoices((p) => ({
                                ...p,
                                [r.rowNumber]: e.target.checked
                                  ? (r.userId ?? SKIP)
                                  : SKIP,
                              }))
                            }
                          />
                        </td>
                        <td className="py-1 text-slate-200">{r.rawName}</td>
                        <td className="py-1 text-slate-500">{r.className}</td>
                        <td className="py-1 text-right tabular-nums text-slate-400">
                          {r.current ? `${fmtDps(r.current.dps)} → ` : ""}
                          <span className="font-semibold text-indigo-300">
                            {fmtDps(r.dps)}
                          </span>
                        </td>
                        <td className="py-1 pl-2 tabular-nums text-slate-500">
                          {r.rawSubmitted}
                        </td>
                        <td className="py-1 pl-2 text-amber-300/80">
                          {r.note ? "deduped" : ""}
                        </td>
                      </tr>
                    ))}
                    {rowsByTier.exact.length === 0 && (
                      <tr>
                        <td className="py-2 text-slate-500">None.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* --- 2. suggested --- */}
            {rowsByTier.suggested.length > 0 && (
              <section className="rounded-xl border border-amber-400/40 bg-[#10101f] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-bold text-amber-200">
                    Needs review ({rowsByTier.suggested.length})
                  </h3>
                  <button
                    type="button"
                    onClick={acceptAllSuggestions}
                    className="ml-auto rounded-md border border-amber-400/40 bg-amber-950/30 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-900/40"
                  >
                    Accept all suggestions
                  </button>
                </div>
                <p className="mb-2 text-[11px] text-slate-500">
                  Close but not identical. Nothing here is applied until you pick
                  a member.
                </p>
                <div className="space-y-2">
                  {rowsByTier.suggested.map((r) => (
                    <div
                      key={r.rowNumber}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-950/20 p-2 text-xs"
                    >
                      <span className="w-8 shrink-0 text-slate-600 tabular-nums">
                        {r.rowNumber}
                      </span>
                      <span className="min-w-0 font-medium text-slate-100">
                        {r.rawName}
                      </span>
                      <span className="tabular-nums text-slate-400">
                        {fmtDps(r.dps)} · {r.className}
                      </span>
                      <RosterSelect
                        value={choices[r.rowNumber] ?? SKIP}
                        roster={preview.roster}
                        row={r}
                        onChange={(v) =>
                          setChoices((p) => ({ ...p, [r.rowNumber]: v }))
                        }
                      />
                      <span className="w-full text-[11px] text-amber-300/70">
                        {r.reason}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* --- 3. in the paste, no member in this guild (the loud one) --- */}
            <section className="rounded-xl border-2 border-red-400/50 bg-red-950/10 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-red-200">
                  In the paste, no {GUILD_LABEL[guild]} member (
                  {rowsByTier.unmatched.length})
                </h3>
                {(rowsByTier.unmatched.length > 0 ||
                  rowsByTier.error.length > 0) && (
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={copyUnresolved}
                      className="rounded-md border border-red-400/40 bg-red-950/40 px-2.5 py-1 text-[11px] font-medium text-red-100 hover:bg-red-900/50"
                    >
                      {copied ? "Copied ✓" : "Copy list"}
                    </button>
                    <button
                      type="button"
                      onClick={downloadUnresolved}
                      className="rounded-md border border-red-400/40 bg-red-950/40 px-2.5 py-1 text-[11px] font-medium text-red-100 hover:bg-red-900/50"
                    >
                      Download .csv
                    </button>
                  </div>
                )}
              </div>
              <p className="mb-2 text-[11px] text-slate-400">
                These rows carry a DPS figure that went nowhere. Fix the name in
                the game, or pick the right member here.
              </p>
              {rowsByTier.unmatched.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Every row found a member. 🎉
                </p>
              ) : (
                <div className="space-y-2">
                  {rowsByTier.unmatched.map((r) => (
                    <div
                      key={r.rowNumber}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/20 bg-[#10101f] p-2 text-xs"
                    >
                      <span className="w-8 shrink-0 text-slate-600 tabular-nums">
                        {r.rowNumber}
                      </span>
                      <span className="min-w-0 font-medium text-slate-100">
                        {r.rawName}
                      </span>
                      <span className="tabular-nums text-slate-400">
                        {fmtDps(r.dps)} · {r.className}
                      </span>
                      <RosterSelect
                        value={choices[r.rowNumber] ?? SKIP}
                        roster={preview.roster}
                        row={r}
                        onChange={(v) =>
                          setChoices((p) => ({ ...p, [r.rowNumber]: v }))
                        }
                      />
                      {r.crossGuild ? (
                        <span className="w-full text-[11px] font-medium text-fuchsia-300">
                          Matches the {r.crossGuild.guildLabel} member “
                          {r.crossGuild.displayName}” — not imported, you are
                          importing {GUILD_LABEL[guild]}.
                        </span>
                      ) : (
                        <span className="w-full text-[11px] text-slate-500">
                          {r.reason}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* --- 4. malformed --- */}
            {rowsByTier.error.length > 0 && (
              <section className="rounded-xl border border-red-400/40 bg-[#10101f] p-4">
                <h3 className="mb-2 text-sm font-bold text-red-200">
                  Malformed rows ({rowsByTier.error.length})
                </h3>
                <p className="mb-2 text-[11px] text-slate-500">
                  A bad row never fails the paste — the rest still imported.
                </p>
                <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                  {rowsByTier.error.map((r) => (
                    <li key={r.rowNumber} className="flex flex-wrap gap-2">
                      <span className="w-12 shrink-0 text-slate-600 tabular-nums">
                        L{r.line}
                      </span>
                      <span className="font-mono text-slate-300">
                        {r.rawName || "(blank)"}
                      </span>
                      <span className="text-red-300/80">{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* --- 5. in guild, absent from the paste (informational) --- */}
            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <button
                type="button"
                onClick={() => setShowNotInPaste((v) => !v)}
                className="flex w-full items-center gap-2 text-left"
              >
                <h3 className="text-sm font-bold text-slate-200">
                  In {GUILD_LABEL[guild]}, not in the paste ({notInPaste.length})
                </h3>
                <span className="ml-auto text-xs text-slate-500">
                  {showNotInPaste ? "hide" : "show"}
                </span>
              </button>
              <p className="mt-1 text-[11px] text-slate-500">
                Nothing happens to these members — they keep whatever DPS row
                they already had. A member who has never been imported cannot
                enter a main raid.
              </p>
              {showNotInPaste && (
                <ul className="mt-2 grid max-h-48 grid-cols-2 gap-x-4 overflow-y-auto text-xs sm:grid-cols-3">
                  {notInPaste.map((m) => (
                    <li key={m.userId} className="flex gap-1.5 py-0.5">
                      <span className="truncate text-slate-300">
                        {m.displayName}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-indigo-500/20 pt-3">
              <button
                type="button"
                onClick={() => {
                  setPhase("input");
                  setPreview(null);
                  setError(null);
                }}
                className="rounded-md border border-indigo-400/30 bg-indigo-950/50 px-4 py-1.5 text-sm text-indigo-100 hover:bg-indigo-900/60"
              >
                Back
              </button>
              <button
                type="button"
                onClick={runApply}
                disabled={busy || selectedCount === 0}
                className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-4 py-1.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500 disabled:opacity-40"
              >
                {busy ? "Applying…" : `Apply ${selectedCount} row(s)`}
              </button>
            </div>
          </div>
        )}

        {/* ---------------- STEP 3: report ---------------- */}
        {phase === "done" && report && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Pill label="updated" value={report.updated} tone="ok" />
              <Pill label="unchanged" value={report.unchanged} tone="muted" />
              <Pill label="skipped" value={report.skipped} tone="warn" />
              <Pill
                label="left untouched"
                value={report.untouched}
                tone="muted"
              />
            </div>

            <p className="text-xs text-slate-400">
              Press <strong>Generate</strong> on the board to rebuild the two
              main raids from this ranking.
            </p>

            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <h3 className="mb-2 text-sm font-bold text-slate-100">
                Updated ({report.changes.length})
              </h3>
              {report.changes.length === 0 ? (
                <p className="text-xs text-slate-500">No DPS rows changed.</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                  {report.changes.map((c) => (
                    <li key={c.userId} className="flex items-center gap-2">
                      <span className="truncate text-slate-200">
                        {c.displayName}
                      </span>
                      <span className="shrink-0 text-slate-500">
                        {c.className}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums text-slate-400">
                        {c.fromDps === null ? "—" : fmtDps(c.fromDps)} →{" "}
                        <span className="font-semibold text-indigo-300">
                          {fmtDps(c.toDps)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {report.skippedRows.length > 0 && (
              <section className="rounded-xl border border-amber-400/40 bg-[#10101f] p-4">
                <h3 className="mb-2 text-sm font-bold text-amber-200">
                  Skipped ({report.skippedRows.length})
                </h3>
                <ul className="space-y-1 text-xs">
                  {report.skippedRows.map((s, i) => (
                    <li key={`${s.userId}-${i}`} className="flex flex-wrap gap-2">
                      <span className="w-8 shrink-0 text-slate-600 tabular-nums">
                        {s.rowNumber || "—"}
                      </span>
                      <span className="text-slate-300">
                        {s.displayName ?? s.userId}
                      </span>
                      <span className="text-amber-300/80">{s.detail}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-4 py-1.5 text-sm font-semibold text-white hover:from-indigo-500 hover:to-fuchsia-500"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
