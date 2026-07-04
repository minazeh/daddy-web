import type {
  LeaderboardRow,
  MemberSessionRow,
  MemberSessionStatus,
  TrendPoint,
} from "@/lib/attendance";
import { fmtDateShort } from "@/lib/attendance";

// GvG attendance charts — plain, deterministic SVG/CSS (the app's house style:
// no charting lib, no DOM measurement, so SSR HTML and the first client render
// are byte-identical — hydration-safe by construction; see MembersDashboard).
// No "use client": these are pure render functions usable from server pages
// (/attendance) and client components (the member modal) alike. Hover detail
// rides native SVG <title> tooltips; every value is also reachable in the
// accompanying lists/tables, so nothing is gated on hover.
//
// Palette: marks wear the app's indigo accent (#818cf8 = indigo-400, ≥3:1 on
// the #10101f card). Text wears text tokens (slate), never the series color.
// Presence states are STATUS colors (emerald/amber/red), reserved for exactly
// that meaning and always paired with a label/legend — never color alone.

const MARK = "#818cf8"; // indigo-400 — single-series accent
const GRID = "#23233f"; // one step off the #10101f card surface, hairline solid
const SURFACE = "#10101f"; // card surface (surface-ring color for markers)
const TICK_TEXT = "#64748b"; // slate-500
const LABEL_TEXT = "#e2e8f0"; // slate-200

// Clean y-axis step (1/2/5 × 10^k) targeting ~4 gridlines.
function niceStep(maxVal: number): number {
  const rough = Math.max(maxVal, 1) / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= rough) return m * pow;
  }
  return 10 * pow;
}

// ---- Trend: present count per session over time (single series → line +
// 10%-opacity area wash, endpoint dot + direct label, no legend box). ----

export function AttendanceTrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) return null; // parents render their own empty state
  const W = 640;
  const H = 220;
  const M = { top: 16, right: 20, bottom: 28, left: 36 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const maxVal = Math.max(1, ...points.map((p) => p.present));
  const step = niceStep(maxVal);
  const yMax = step * Math.ceil(maxVal / step);
  const ticks: number[] = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);

  const n = points.length;
  const x = (i: number) =>
    M.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.present).toFixed(1)}`)
    .join(" ");
  const areaPath =
    n > 1
      ? `${linePath} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`
      : null;

  // Label at most ~6 x-ticks (always the first and last) to avoid collisions.
  const every = Math.max(1, Math.ceil(n / 6));
  const showX = (i: number) => i === n - 1 || (i % every === 0 && n - 1 - i >= every / 2);

  const last = points[n - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Attendance trend across ${n} session${n === 1 ? "" : "s"}, latest ${last.present} present`}
    >
      {/* recessive hairline grid + y ticks */}
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={M.left}
            y1={y(v)}
            x2={W - M.right}
            y2={y(v)}
            stroke={GRID}
            strokeWidth={1}
          />
          <text
            x={M.left - 6}
            y={y(v) + 3}
            textAnchor="end"
            fontSize={10}
            fill={TICK_TEXT}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {v}
          </text>
        </g>
      ))}

      {/* area wash (~10% opacity) + 2px line, round joins */}
      {areaPath && <path d={areaPath} fill={MARK} fillOpacity={0.1} />}
      {n > 1 && (
        <path
          d={linePath}
          fill="none"
          stroke={MARK}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* point markers with a 2px surface ring; endpoint bigger + direct label */}
      {points.map((p, i) => (
        <circle
          key={p.sessionId}
          cx={x(i)}
          cy={y(p.present)}
          r={i === n - 1 ? 4 : 3}
          fill={MARK}
          stroke={SURFACE}
          strokeWidth={2}
        />
      ))}
      <text
        x={Math.min(x(n - 1) + 8, W - 2)}
        y={y(last.present) - 8}
        textAnchor={x(n - 1) + 24 > W - M.right ? "end" : "start"}
        fontSize={11}
        fontWeight={600}
        fill={LABEL_TEXT}
      >
        {last.present}
      </text>

      {/* x labels */}
      {points.map((p, i) =>
        showX(i) ? (
          <text
            key={p.sessionId}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize={10}
            fill={TICK_TEXT}
          >
            {fmtDateShort(p.date)}
          </text>
        ) : null,
      )}

      {/* full-height hover targets: native tooltip per session */}
      {points.map((p, i) => {
        const slot = n === 1 ? plotW : plotW / (n - 1);
        return (
          <rect
            key={p.sessionId}
            x={x(i) - slot / 2}
            y={M.top}
            width={slot}
            height={plotH}
            fill="transparent"
          >
            <title>
              {`${fmtDateShort(p.date)} — ${p.present} present${
                p.expected !== null
                  ? ` · ${p.expected} expected`
                  : " · no roster data"
              }`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

// ---- Leaderboard: one nominal series → every bar wears the same accent.
// Thin bars (14px), 4px rounded data-end, square baseline, value at the tip
// (outside, in a text token). ----

export function RateLeaderboard({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ol className="space-y-1.5">
      {rows.map((r, i) => (
        <li
          key={r.userId}
          className="flex items-center gap-2 text-xs"
          title={`${r.displayName}: present ${r.presentCount} of ${r.expectedCount} sessions since joining`}
        >
          <span className="w-5 shrink-0 text-right tabular-nums text-slate-500">
            {i + 1}.
          </span>
          <span className="w-28 shrink-0 truncate text-slate-300">
            {r.displayName}
          </span>
          <span className="h-3.5 flex-1 overflow-hidden rounded-sm bg-indigo-950/40">
            <span
              className="block h-full rounded-r bg-gradient-to-r from-indigo-500 to-fuchsia-500"
              style={{ width: `${r.ratePct}%` }}
            />
          </span>
          <span className="w-24 shrink-0 text-right tabular-nums text-slate-400">
            {r.presentCount}/{r.expectedCount} · {r.ratePct}%
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---- Per-member presence strip: one cell per session row, chronological.
// Presence is STATUS, not identity: filled emerald = present, amber = present
// but ⚠ flagged, hollow red = absent, dim emerald = present-but-uncounted,
// muted gray = no roster data. Always shipped with the legend + row list —
// never color alone. ----

export const STATUS_LABEL: Record<MemberSessionStatus, string> = {
  present: "Present",
  absent: "Absent",
  "present-uncounted": "Present (not counted)",
  "no-data": "No roster data",
};

function cellClass(row: MemberSessionRow): string {
  if (row.status === "present") {
    return row.flagged ? "bg-amber-400" : "bg-emerald-400";
  }
  if (row.status === "absent") {
    return "bg-red-400/10 ring-1 ring-inset ring-red-400/70";
  }
  if (row.status === "present-uncounted") {
    return "bg-emerald-400/25 ring-1 ring-inset ring-emerald-400/40";
  }
  return "bg-slate-700/50"; // no-data
}

export function MemberSessionStrip({ rows }: { rows: MemberSessionRow[] }) {
  return (
    <div>
      <div className="flex flex-wrap gap-0.5" aria-hidden>
        {rows.map((r) => (
          <span
            key={r.sessionId}
            className={`h-4 w-3 rounded-[3px] ${cellClass(r)}`}
            title={`${fmtDateShort(r.date)} — ${STATUS_LABEL[r.status]}${
              r.flagged ? " · ⚠ wrong VC / off-roster" : ""
            }`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-400" /> Present
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-amber-400" /> ⚠ Flagged
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-red-400/10 ring-1 ring-inset ring-red-400/70" />{" "}
          Absent
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-400/25 ring-1 ring-inset ring-emerald-400/40" />{" "}
          Not counted
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-slate-700/50" /> No roster
          data
        </span>
      </div>
    </div>
  );
}
