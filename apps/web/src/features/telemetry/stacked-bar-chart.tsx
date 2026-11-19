import * as React from "react";

import { tickLabel, ticksFor } from "./chart-time";
import { bucketStart, type ListChartFrame, listBucketLabel } from "./list-chart-frame";

/**
 * Counts over time buckets as stacked bars, for the Logs and Traces lists'
 * charts: one y-axis from zero, a bar per bucket with its parts stacked
 * from the baseline in the order given, 2px of surface between parts and
 * between bars, a rounded top, a legend from two parts, and a readout of
 * the hovered bucket with every part's count and the total. A hidden range
 * input moves between buckets with the keyboard and reads each out; with
 * `onSelect`, a click or Enter on a bucket selects it. The table view is
 * the caller's ("Show the numbers").
 */

export interface BarPart {
  key: string;
  label: string;
  /** A CSS color. */
  color: string;
  values: number[];
}

const AXIS_BAND = 28;
const MARGIN = { top: 12, right: 16, left: 56 };
/** The surface between parts and between bars. */
const GAP = 2;
const MAX_BAR = 24;

export function StackedBarChart({
  frame,
  parts,
  label,
  formatValue,
  plotHeight = 140,
  onSelect,
  selectHint,
}: {
  /** The buckets, each with its start on the clock of the instance's timezone. */
  frame: ListChartFrame;
  /** From the baseline up; the legend lists them in this order. */
  parts: BarPart[];
  /** What the chart shows: its accessible name. */
  label: string;
  formatValue: (value: number) => string;
  plotHeight?: number;
  /** A bucket clicked or chosen with Enter; none when the chart offers nothing. */
  onSelect?: ((index: number) => void) | undefined;
  /** What selecting a bucket does, under the readout, such as "Click to show this day". */
  selectHint?: string | undefined;
}) {
  const { stepSeconds, timeZone } = frame;
  const buckets = frame.bucketStarts.length;
  const chartHeight = MARGIN.top + plotHeight + AXIS_BAND;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [active, setActive] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return undefined;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const timeOf = (index: number) => bucketStart(frame, index);
  const last = buckets - 1;
  const totals = Array.from({ length: buckets }, (_, index) =>
    parts.reduce((sum, part) => sum + (part.values[index] ?? 0), 0),
  );
  const ticks = ticksFor(0, Math.max(0, ...totals));
  const top = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const slot = buckets > 0 ? plotWidth / buckets : 0;
  const gap = slot >= 4 ? GAP : slot >= 2 ? 1 : 0;
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - gap));
  const center = (index: number) => MARGIN.left + (index + 0.5) * slot;
  const baseline = MARGIN.top + plotHeight;
  const y = (value: number) => baseline - (value / top) * plotHeight;

  const spanSeconds = buckets * stepSeconds;
  const labelSpacing = spanSeconds <= 36 * 3600 ? 56 : stepSeconds >= 86_400 ? 64 : 104;
  const labelEvery = Math.max(
    1,
    Math.ceil(buckets / Math.max(1, Math.floor(plotWidth / labelSpacing))),
  );

  function bucketAt(clientX: number): number | null {
    const element = containerRef.current;
    if (element === null || buckets === 0 || slot === 0) return null;
    const offset = clientX - element.getBoundingClientRect().left - MARGIN.left;
    return Math.min(last, Math.max(0, Math.floor(offset / slot)));
  }

  const describe = (index: number) =>
    `${listBucketLabel(frame, index)}: ${formatValue(totals[index] ?? 0)} in all${parts
      .map((part) => `, ${part.label} ${formatValue(part.values[index] ?? 0)}`)
      .join("")}`;
  // The keyboard position starts on the latest bucket.
  const shown = active ?? Math.max(0, last);
  const tooltipOnLeft = active !== null && center(active) > width / 2;

  return (
    <div className="flex flex-col gap-3">
      {parts.length >= 2 && (
        <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          {parts.map((part) => (
            <li key={part.key} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-sm"
                style={{ background: part.color }}
              />
              <span className="max-w-64 truncate" title={part.label}>
                {part.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div
        ref={containerRef}
        data-slot="stacked-bar-chart"
        className={`relative w-full rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring ${
          onSelect === undefined ? "" : "cursor-pointer"
        }`}
        style={{ height: chartHeight }}
        onPointerMove={(event) => setActive(bucketAt(event.clientX))}
        onPointerLeave={() => setActive(null)}
        // The keyboard selects through the range input (Enter); a pointer, here.
        onPointerUp={(event) => {
          const index = bucketAt(event.clientX);
          if (onSelect !== undefined && index !== null) onSelect(index);
        }}
      >
        {buckets > 0 && (
          <input
            type="range"
            className="sr-only"
            aria-label={label}
            aria-valuetext={describe(shown)}
            min={0}
            max={last}
            step={1}
            value={shown}
            onChange={(event) => setActive(Number(event.target.value))}
            onFocus={() => setActive(shown)}
            onBlur={() => setActive(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && onSelect !== undefined) onSelect(shown);
            }}
          />
        )}
        {width > 0 && (
          <svg width={width} height={chartHeight} aria-hidden="true" className="block">
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--hairline)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-ink-subtle text-[11px] tabular-nums"
                >
                  {formatValue(tick)}
                </text>
              </g>
            ))}
            {Array.from({ length: buckets }, (_, index) => index)
              .filter((index) => (last - index) % labelEvery === 0)
              .map((index) => (
                <text
                  key={index}
                  x={Math.min(width - MARGIN.right, Math.max(MARGIN.left, center(index)))}
                  y={baseline + 18}
                  textAnchor={index === 0 ? "start" : index === last ? "end" : "middle"}
                  className="fill-ink-subtle text-[11px]"
                >
                  {tickLabel(timeOf(index), timeZone, stepSeconds, spanSeconds)}
                </text>
              ))}
            {active !== null && (
              <rect
                x={MARGIN.left + active * slot}
                y={MARGIN.top}
                width={slot}
                height={plotHeight}
                fill="var(--hairline)"
                opacity={0.6}
              />
            )}
            {totals.map((total, index) => {
              if (total === 0) return null;
              const left = center(index) - barWidth / 2;
              const radius = Math.min(4, barWidth / 2);
              const shownParts = parts.filter((part) => (part.values[index] ?? 0) > 0);
              let below = 0;
              return (
                <g key={index} data-bucket={index}>
                  {shownParts.map((part, n) => {
                    const value = part.values[index] ?? 0;
                    const bottom = y(below) - (n === 0 ? 0 : gap);
                    below += value;
                    const upper = y(below);
                    const height = Math.max(1, bottom - upper);
                    const isTop = n === shownParts.length - 1;
                    const r = isTop ? Math.min(radius, height) : 0;
                    const right = left + barWidth;
                    const topEdge = bottom - height;
                    return (
                      <path
                        key={part.key}
                        data-part={part.key}
                        fill={part.color}
                        d={`M${left},${bottom}V${topEdge + r}Q${left},${topEdge} ${left + r},${topEdge}H${right - r}Q${right},${topEdge} ${right},${topEdge + r}V${bottom}Z`}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        )}
        {active !== null && (
          <div
            aria-hidden="true"
            data-slot="chart-tooltip"
            className="pointer-events-none absolute top-2 z-10 max-w-80 min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
            style={
              tooltipOnLeft ? { right: width - center(active) + 12 } : { left: center(active) + 12 }
            }
          >
            <p className="mb-1.5 text-ink-subtle">{listBucketLabel(frame, active)}</p>
            <ul className="flex flex-col gap-1">
              {parts.map((part) => (
                <li key={part.key} className="flex min-w-0 items-center gap-2">
                  <span className="size-2 shrink-0 rounded-sm" style={{ background: part.color }} />
                  <span className="font-semibold whitespace-nowrap text-ink tabular-nums">
                    {formatValue(part.values[active] ?? 0)}
                  </span>
                  <span className="truncate text-ink-subtle">{part.label}</span>
                </li>
              ))}
              {parts.length >= 2 && (
                <li className="flex min-w-0 items-center gap-2 border-t pt-1">
                  <span className="size-2 shrink-0" />
                  <span className="font-semibold whitespace-nowrap text-ink tabular-nums">
                    {formatValue(totals[active] ?? 0)}
                  </span>
                  <span className="truncate text-ink-subtle">In all</span>
                </li>
              )}
            </ul>
            {selectHint !== undefined && <p className="mt-1.5 text-ink-subtle">{selectHint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
