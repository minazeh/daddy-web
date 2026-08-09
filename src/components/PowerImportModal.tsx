"use client";

import { useMemo, useRef, useState } from "react";
import {
  applyPowerImport,
  previewPowerImport,
} from "@/lib/power-import-actions";
import {
  membersNotInCsv,
  unresolvedAsTsv,
  type ApplyReport,
  type ImportDecision,
  type ImportPreview,
  type PreviewRow,
  type RosterMember,
} from "@/lib/power-import";
import { GUILD_LABEL, type Guild } from "@/lib/types";

// CSV power-rating importer — PREVIEW, then APPLY. Nothing is written until
// the user presses Apply, and only the rows they confirmed are sent.
//
// The preview splits the file into five explicit buckets so nothing is ever
// silently dropped:
//   1. Exact matches          — auto-selected, uncheckable per row.
//   2. Needs review           — a suggestion; NOT selected until confirmed.
//   3. In CSV, no member here — the loud one. Data that went nowhere, incl.
//                               rows that are really the other guild's members.
//   4. Malformed rows         — per-row reason, never fails the file.
//   5. In guild, not in CSV   — informational; their power is left untouched.
//
// This component renders only after a click, so there is no SSR/hydration
// surface to worry about.

type Phase = "input" | "preview" | "done";

/** Decode an uploaded file, honouring a UTF-8/UTF-16 BOM. */
async function decodeFile(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  // UTF-8 (with or without a BOM — the parser strips a leading U+FEFF).
  return new TextDecoder("utf-8").decode(buf);
}

/** RFC 4180 quoting for the downloadable "unresolved" report. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function unresolvedAsCsv(rows: PreviewRow[]): string {
  const header = ["Row", "IGN", "Power", "Problem"].map(csvCell).join(",");
  const body = rows.map((r) =>
    [
      r.rowNumber,
      r.rawName,
      r.rawPower,
      r.crossGuild
        ? `Matches ${r.crossGuild.guildLabel} member "${r.crossGuild.displayName}" — not imported`
        : (r.reason ?? ""),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...body].join("\r\n");
}

const SKIP = "";

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
  row: PreviewRow;
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
            {m.displayName} · ⚡{m.power}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export function PowerImportModal({
  guild,
  onClose,
  onApplied,
}: {
  guild: Guild;
  onClose: () => void;
  onApplied: (changes: { userId: string; power: number }[]) => void;
}) {
  const [phase, setPhase] = useState<Phase>("input");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showNotInCsv, setShowNotInCsv] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const rosterById = useMemo(
    () => new Map((preview?.roster ?? []).map((m) => [m.userId, m])),
    [preview],
  );

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

  const notInCsv = useMemo(
    () => membersNotInCsv(preview?.roster ?? [], covered),
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
      const text = await decodeFile(file);
      setCsvText(text);
      setFileName(file.name);
    } catch {
      setError("Could not read that file.");
    }
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await previewPowerImport(guild, csvText);
      if (!result.ok) {
        setError(result.message ?? "Could not read that CSV.");
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
      const decisions: ImportDecision[] = preview.rows
        .filter((r) => r.power !== null && choices[r.rowNumber])
        .map((r) => ({
          rowNumber: r.rowNumber,
          userId: choices[r.rowNumber],
          power: r.power as number,
        }));
      if (decisions.length === 0) {
        setError("Nothing selected to apply.");
        return;
      }
      const result = await applyPowerImport(guild, decisions);
      if (!result.ok) {
        setError(result.message ?? "The import failed.");
        return;
      }
      setReport(result);
      onApplied(result.changes.map((c) => ({ userId: c.userId, power: c.to })));
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
      await navigator.clipboard.writeText(unresolvedAsTsv(rows));
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
    a.download = `${guild}-power-import-unresolved.csv`;
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
              Import power ratings — {GUILD_LABEL[guild]}
            </h2>
            <p className="text-xs text-slate-400">
              CSV with an <code>IGN</code> and a <code>Power</code> column. IGN
              is matched against each member&apos;s Discord display name.
              Nothing is saved until you press Apply.
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
                Upload a .csv
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-gradient-to-r file:from-indigo-600 file:to-fuchsia-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
                />
                {fileName && (
                  <span className="text-xs text-slate-400">
                    {fileName} · {csvText.length.toLocaleString()} chars
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-indigo-400/30 bg-indigo-950/20 p-4">
              <label className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                …or paste the rows
              </label>
              <textarea
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  setFileName(null);
                }}
                rows={8}
                spellCheck={false}
                placeholder={"IGN,Power\nSolar,64236\nDuckyO,56692"}
                className="mt-2 w-full rounded-md border border-indigo-400/30 bg-[#0c0c1c] px-2.5 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600"
              />
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
                disabled={busy || csvText.trim() === ""}
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
                    {rowsByTier.exact.map((r) => {
                      const m = r.userId ? rosterById.get(r.userId) : undefined;
                      const on = choices[r.rowNumber] === r.userId;
                      const same = m && m.power === r.power;
                      return (
                        <tr
                          key={r.rowNumber}
                          className="border-t border-indigo-500/10"
                        >
                          <td className="w-8 py-1">
                            <input
                              type="checkbox"
                              checked={on}
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
                          <td className="py-1 text-slate-500">
                            → {m?.displayName ?? r.userId}
                          </td>
                          <td className="py-1 text-right tabular-nums text-slate-400">
                            {m?.power ?? 0} → {r.power}
                            {same && (
                              <span className="ml-1 text-slate-600">
                                (no change)
                              </span>
                            )}
                          </td>
                          <td className="py-1 pl-2 text-amber-300/80">
                            {r.note}
                          </td>
                        </tr>
                      );
                    })}
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
                        ⚡{r.power}
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

            {/* --- 3. in CSV, no member in this guild (the loud one) --- */}
            <section className="rounded-xl border-2 border-red-400/50 bg-red-950/10 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-red-200">
                  In the CSV, no {GUILD_LABEL[guild]} member (
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
                These rows carry a power value that went nowhere. Fix the name in
                the source sheet, or pick the right member here.
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
                        ⚡{r.power}
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
                <ul className="space-y-1 text-xs">
                  {rowsByTier.error.map((r) => (
                    <li key={r.rowNumber} className="flex flex-wrap gap-2">
                      <span className="w-8 shrink-0 text-slate-600 tabular-nums">
                        {r.rowNumber}
                      </span>
                      <span className="text-slate-300">
                        {r.rawName || "(blank)"}
                      </span>
                      <span className="text-slate-500">{r.rawPower}</span>
                      <span className="text-red-300/80">{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* --- 5. in guild, absent from CSV (informational) --- */}
            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <button
                type="button"
                onClick={() => setShowNotInCsv((v) => !v)}
                className="flex w-full items-center gap-2 text-left"
              >
                <h3 className="text-sm font-bold text-slate-200">
                  In {GUILD_LABEL[guild]}, not in the CSV ({notInCsv.length})
                </h3>
                <span className="ml-auto text-xs text-slate-500">
                  {showNotInCsv ? "hide" : "show"}
                </span>
              </button>
              <p className="mt-1 text-[11px] text-slate-500">
                Nothing happens to these members — they keep the power they
                already have.
              </p>
              {showNotInCsv && (
                <ul className="mt-2 grid max-h-48 grid-cols-2 gap-x-4 overflow-y-auto text-xs sm:grid-cols-3">
                  {notInCsv.map((m) => (
                    <li key={m.userId} className="flex gap-1.5 py-0.5">
                      <span className="truncate text-slate-300">
                        {m.displayName}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums text-slate-500">
                        ⚡{m.power}
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

            <section className="rounded-xl border border-indigo-400/30 bg-[#10101f] p-4">
              <h3 className="mb-2 text-sm font-bold text-slate-100">
                Updated ({report.changes.length})
              </h3>
              {report.changes.length === 0 ? (
                <p className="text-xs text-slate-500">No power values changed.</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                  {report.changes.map((c) => (
                    <li key={c.userId} className="flex items-center gap-2">
                      <span className="truncate text-slate-200">
                        {c.displayName}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums text-slate-400">
                        {c.from} →{" "}
                        <span className="font-semibold text-indigo-300">
                          {c.to}
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
