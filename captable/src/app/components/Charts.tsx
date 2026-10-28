import { useId, useState, type PointerEvent } from "react";
import { compareDecimals, formatCompact, formatFractionPercent, fractionOf, multiplyDecimals, sumDecimals, type Fraction } from "../lib/decimal.ts";
import { addDays, daysBetween, formatDate } from "../lib/format.ts";
import { useDisplay } from "./Display.tsx";

// The charts. Every number shown is formatted from exact decimals; only the SVG geometry (arc lengths, x
// and y positions) uses floating point, which never reaches a displayed figure.

/** A fraction as a 0–1 number, for drawing only. */
function geometry(fraction: Fraction): number {
  if (fraction.den === 0n) return 0;
  return Number((fraction.num * 1_000_000n) / fraction.den) / 1_000_000;
}

export interface DonutSegment {
  label: string;
  value: string;
  color: string;
  hatched?: boolean;
}

export function DonutChart({ segments, center, centerLabel = "Fully diluted", label }: { segments: readonly DonutSegment[]; center: string; centerLabel?: string; label: string }) {
  const patternId = useId().replace(/:/g, "");
  const total = sumDecimals(segments.map((segment) => segment.value));
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg viewBox="0 0 180 180" width="180" height="180" className="donut" role="group" aria-label={label}>
      <defs>
        <pattern id={patternId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" style={{ fill: "var(--s-pool)" }} />
          <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: "var(--hatch)" }} strokeWidth="2" />
        </pattern>
      </defs>
      {segments.filter((segment) => compareDecimals(segment.value, "0") > 0).map((segment) => {
        const share = fractionOf(segment.value, total);
        const length = geometry(share) * circumference;
        const gap = Math.min(2, length / 3);
        const circle = (
          <circle
            key={segment.label}
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            style={{ stroke: segment.hatched ? `url(#${patternId})` : segment.color }}
            strokeWidth="24"
            strokeDasharray={`${Math.max(0.01, length - gap)} ${circumference}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 90 90)"
            tabIndex={0}
            role="img"
            aria-label={`${segment.label} ${formatFractionPercent(share)}`}
          >
            <title>{`${segment.label}: ${formatFractionPercent(share)}`}</title>
          </circle>
        );
        offset += length;
        return circle;
      })}
      <text x="90" y="86" textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 10 }}>{centerLabel}</text>
      <text x="90" y="103" textAnchor="middle" style={{ fill: "var(--text)", fontSize: 14, fontWeight: 650 }}>{center}</text>
    </svg>
  );
}

/** Plan usage: amber above 90%, red above 100%. */
export function Meter({ used, size, label }: { used: string; size: string; label: string }) {
  const share = fractionOf(used, size);
  const ratio = geometry(share);
  const tone = ratio > 1 ? " over" : ratio > 0.9 ? " warn" : "";
  const percent = formatFractionPercent(share);
  return (
    <div className={`meter${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 10_000) / 100} aria-valuetext={percent} aria-label={`${label} ${percent}`}>
      <div className="fill" style={{ width: `${Math.min(100, ratio * 100).toFixed(2)}%` }} />
    </div>
  );
}

/** Vested, unvested and cancelled as one bar; `cancelled` is null when it isn't known (its legend says "—"). */
export function ProgressBar({ vested, unvested, cancelled, unit, vestedLabel = "Vested" }: { vested: string; unvested: string; cancelled: string | null; unit: string; vestedLabel?: string }) {
  const { format } = useDisplay();
  const total = sumDecimals([vested, unvested, cancelled]);
  const parts = [
    ["pv", vested, vestedLabel],
    ["pu", unvested, "Unvested"],
    ["pc", cancelled, "Cancelled"],
  ] as const;
  return (
    <>
      <div className="pbar" role="img" aria-label={`${format.shares(vested)} ${vestedLabel.toLowerCase()}, ${format.shares(unvested)} unvested${cancelled === null ? "" : `, ${format.shares(cancelled)} cancelled`}`}>
        {parts.filter(([, value]) => compareDecimals(value, "0") > 0).map(([className, value, text]) => (
          <span key={className} className={className} style={{ width: `${(geometry(fractionOf(value, total)) * 100).toFixed(3)}%` }} title={`${text}: ${format.shares(value)} ${unit}`} />
        ))}
      </div>
      <div className="pbar-legend">
        {parts.map(([className, value, text]) => (
          <div className="pl" key={className}>
            <span className={`sw sw-${className.slice(1)}`} aria-hidden="true" />
            <span><b>{text}</b>{value === null ? "—" : `${format.shares(value)} ${unit}`}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** One vest event as the chart draws it; `active` is false for a tranche cancelled by a termination. */
export interface ChartEvent {
  date: string;
  cumulative: string;
  active: boolean;
  cliff?: boolean;
}

interface VestingChartProps {
  events: readonly ChartEvent[];
  total: string;
  start: string;
  stopDate: string | null;
  label: string;
}

/** Cumulative vested quantity over time as a step line, with Today, the stop date and the cliff marked. */
export function VestingChart({ events, total, start, stopDate, label }: VestingChartProps) {
  const { format, today } = useDisplay();
  const [hover, setHover] = useState<{ x: number; y: number; date: string; value: string } | null>(null);
  const active = [...events].filter((event) => event.active).sort((a, b) => a.date.localeCompare(b.date));
  const last = active.at(-1)?.date ?? start;
  const end = [last, addDays(today, 61), addDays(start, 365)].sort().at(-1)!;
  const width = 640;
  const height = 200;
  const [left, right, top, bottom] = [52, 14, 14, 26];
  const span = Math.max(1, daysBetween(start, end));
  const x = (date: string) => left + (daysBetween(start, date) / span) * (width - left - right);
  const y = (value: string) => top + (1 - geometry(fractionOf(value, total))) * (height - top - bottom);
  const points: [string, string][] = [[start, "0"], ...active.map((event): [string, string] => [event.date, event.cumulative]), [end, active.at(-1)?.cumulative ?? "0"]];
  let path = `M${x(points[0]![0]).toFixed(1)},${y("0").toFixed(1)}`;
  for (const [date, value] of points.slice(1)) path += ` H${x(date).toFixed(1)} V${y(value).toFixed(1)}`;
  const area = `${path} V${y("0").toFixed(1)} Z`;
  const ticks = ["0", "0.25", "0.5", "0.75", "1"].map((share) => multiplyDecimals(total, share));
  const years: number[] = [];
  for (let year = Number(start.slice(0, 4)) + 1; year <= Number(end.slice(0, 4)); year += 1) years.push(year);
  const cliff = active.find((event) => event.cliff);
  const valueAt = (date: string) => points.filter(([pointDate]) => pointDate <= date).at(-1)?.[1] ?? "0";
  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const sx = ((event.clientX - box.left) / box.width) * width;
    const offset = Math.round(((sx - left) / (width - left - right)) * span);
    const date = addDays(start, Math.max(0, Math.min(span, offset)));
    const value = valueAt(date);
    setHover({ x: (x(date) / width) * 100, y: (y(value) / height) * 100, date, value });
  };
  return (
    <div className="chart-box">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <g className="axis">
          {ticks.map((tick, index) => (
            <g key={index}>
              <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} style={{ stroke: "var(--grid)" }} strokeWidth="1" />
              <text x={left - 8} y={y(tick) + 4} textAnchor="end">{formatCompact(tick)}</text>
            </g>
          ))}
          {years.map((year) => {
            const date = `${year}-01-01`;
            return (
              <g key={year}>
                <line x1={x(date)} x2={x(date)} y1={height - bottom} y2={height - bottom + 4} style={{ stroke: "var(--border-strong)" }} />
                <text x={x(date)} y={height - 8} textAnchor="middle">{year}</text>
              </g>
            );
          })}
        </g>
        <path d={area} style={{ fill: "var(--vest-wash)" }} />
        <path d={path} fill="none" style={{ stroke: "var(--vest)" }} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {cliff && (!stopDate || cliff.date <= stopDate) ? (
          <circle cx={x(cliff.date)} cy={y(cliff.cumulative)} r="4.5" style={{ fill: "var(--vest)", stroke: "var(--surface)" }} strokeWidth="2" />
        ) : null}
        {today >= start && today <= end ? (
          <>
            <line x1={x(today)} x2={x(today)} y1={top} y2={height - bottom} style={{ stroke: "var(--text-2)" }} strokeWidth="1" />
            <text x={x(today) + 4} y={top + 10} style={{ fill: "var(--text-2)", fontSize: 10.5 }}>Today</text>
          </>
        ) : null}
        {stopDate && stopDate <= end ? (
          <>
            <line x1={x(stopDate)} x2={x(stopDate)} y1={top} y2={height - bottom} style={{ stroke: "var(--danger)" }} strokeWidth="1" />
            <text x={x(stopDate) - 4} y={top + 22} textAnchor="end" style={{ fill: "var(--danger-text)", fontSize: 10.5 }}>
              {stopDate > today ? "Vesting stops" : "Vesting stopped"}
            </text>
          </>
        ) : null}
        <rect x={left} y={top} width={width - left - right} height={height - top - bottom} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover ? (
        <div className="chart-tip" style={{ left: `${hover.x}%`, top: `${hover.y}%` }} aria-hidden="true">
          <b>{format.shares(hover.value)}</b>
          <span className="tk" />vested · {formatFractionPercent(fractionOf(hover.value, total), 1)}
          <div className="muted">{formatDate(hover.date)}</div>
        </div>
      ) : null}
    </div>
  );
}
