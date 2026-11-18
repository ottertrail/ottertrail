import * as React from "react";

import { bucketLabel, tickLabel, ticksFor } from "./chart-time";

/**
 * Lines over time buckets, for the Metrics page: one y-axis, each line in
 * its own color, a legend from two lines, a crosshair that snaps to the
 * nearest bucket with every line's value in its readout, and a hidden
 * range input that moves between buckets with the keyboard and reads each
 * out. Nulls break a line (nothing arrived then); a value alone between
 * gaps is a dot. The table view is the caller's ("Show the numbers").
 */

export interface ChartLine {
  key: string;
  label: string;
  /** A CSS color: a chart slot, or the de-emphasis gray for "other". */
  color: string;
  values: (number | null)[];
}

const PLOT_HEIGHT = 220;
const AXIS_BAND = 28;
const HEIGHT = 12 + PLOT_HEIGHT + AXIS_BAND;
const MARGIN = { top: 12, right: 16, left: 64 };

/** Each run of buckets with a value, as indexes: a null breaks the line. */
function runsOf(values: (number | null)[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(index);
    }
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

export function TimeChart({
  start,
  stepSeconds,
  buckets,
  timeZone,
  lines,
  label,
  formatValue,
  domain,
}: {
  /** The first bucket's start, ISO. */
  start: string;
  stepSeconds: number;
  buckets: number;
  timeZone: string;
  /** In the legend's order; the first is drawn on top. */
  lines: ChartLine[];
  /** What the chart shows: its accessible name. */
  label: string;
  formatValue: (value: number) => string;
  /** A fixed y-axis range, such as 0 to 100 for percentages; values past it widen it. */
  domain?: { min: number; max: number } | undefined;
}) {
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

  const startMs = Date.parse(start);
  const timeOf = (index: number) => new Date(startMs + index * stepSeconds * 1000);
  const last = buckets - 1;
  const all = lines.flatMap((line) => line.values.filter((value) => value !== null));
  const ticks = ticksFor(Math.min(domain?.min ?? 0, ...all), Math.max(domain?.max ?? 0, ...all));
  const bottom = ticks[0] ?? 0;
  const top = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const x = (index: number) =>
    MARGIN.left + (buckets <= 1 ? plotWidth / 2 : (index / last) * plotWidth);
  const y = (value: number) =>
    MARGIN.top + PLOT_HEIGHT - ((value - bottom) / (top - bottom)) * PLOT_HEIGHT;

  const spanSeconds = buckets * stepSeconds;
  const labelSpacing = spanSeconds <= 36 * 3600 ? 56 : stepSeconds >= 86_400 ? 64 : 104;
  const labelEvery = Math.max(
    1,
    Math.ceil(buckets / Math.max(1, Math.floor(plotWidth / labelSpacing))),
  );

  function bucketAt(clientX: number): number | null {
    const element = containerRef.current;
    if (element === null || buckets === 0) return null;
    const offset = clientX - element.getBoundingClientRect().left - MARGIN.left;
    const index = buckets <= 1 ? 0 : Math.round((offset / plotWidth) * last);
    return Math.min(last, Math.max(0, index));
  }

  const valueText = (value: number | null | undefined) =>
    value === null || value === undefined ? "no data" : formatValue(value);
  // The keyboard position starts on the latest bucket with a value.
  const latest = Math.max(
    0,
    ...lines.map((line) => line.values.findLastIndex((value) => value !== null)),
  );
  const shown = active ?? latest;
  const readout = `${bucketLabel(timeOf(shown), stepSeconds, timeZone)}: ${lines
    .map((line) => `${line.label} ${valueText(line.values[shown])}`)
    .join(", ")}`;
  const tooltipOnLeft = active !== null && x(active) > width / 2;

  return (
    <div className="flex flex-col gap-3">
      {lines.length >= 2 && (
        <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          {lines.map((line) => (
            <li key={line.key} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: line.color }}
              />
              <span className="max-w-64 truncate" title={line.label}>
                {line.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div
        ref={containerRef}
        className="relative w-full rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring"
        style={{ height: HEIGHT }}
        onPointerMove={(event) => setActive(bucketAt(event.clientX))}
        onPointerLeave={() => setActive(null)}
      >
        {buckets > 0 && (
          <input
            type="range"
            className="sr-only"
            aria-label={label}
            aria-valuetext={readout}
            min={0}
            max={last}
            step={1}
            value={shown}
            onChange={(event) => setActive(Number(event.target.value))}
            onFocus={() => setActive(shown)}
            onBlur={() => setActive(null)}
          />
        )}
        {width > 0 && (
          <svg width={width} height={HEIGHT} aria-hidden="true" className="block">
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
                  x={x(index)}
                  y={MARGIN.top + PLOT_HEIGHT + 18}
                  textAnchor={index === 0 ? "start" : index === last ? "end" : "middle"}
                  className="fill-ink-subtle text-[11px]"
                >
                  {tickLabel(timeOf(index), timeZone, stepSeconds, spanSeconds)}
                </text>
              ))}
            {lines.toReversed().map((line) => {
              const runs = runsOf(line.values);
              const at = (index: number) => y(line.values[index] ?? 0);
              return (
                <g key={line.key}>
                  {runs
                    .filter((run) => run.length > 1)
                    .map((run) => (
                      <path
                        key={run[0]}
                        d={run
                          .map((index, n) => `${n === 0 ? "M" : "L"}${x(index)},${at(index)}`)
                          .join("")}
                        fill="none"
                        stroke={line.color}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ))}
                  {runs
                    .filter((run) => run.length === 1)
                    .map((run) => (
                      <circle
                        key={run[0]}
                        cx={x(run[0] ?? 0)}
                        cy={at(run[0] ?? 0)}
                        r={4}
                        fill={line.color}
                      />
                    ))}
                </g>
              );
            })}
            {active !== null && (
              <g pointerEvents="none">
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + PLOT_HEIGHT}
                  stroke="var(--hairline-tertiary)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                {lines.map((line) => {
                  const value = line.values[active];
                  return value === null || value === undefined ? null : (
                    <circle
                      key={line.key}
                      cx={x(active)}
                      cy={y(value)}
                      r={4}
                      fill={line.color}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  );
                })}
              </g>
            )}
          </svg>
        )}
        {active !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-2 z-10 max-w-80 min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
            style={tooltipOnLeft ? { right: width - x(active) + 12 } : { left: x(active) + 12 }}
          >
            <p className="mb-1.5 text-ink-subtle">
              {bucketLabel(timeOf(active), stepSeconds, timeZone)}
            </p>
            <ul className="flex flex-col gap-1">
              {lines.map((line) => (
                <li key={line.key} className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ background: line.color }}
                  />
                  <span className="font-semibold whitespace-nowrap text-ink tabular-nums">
                    {line.values[active] === null || line.values[active] === undefined
                      ? "–"
                      : formatValue(line.values[active])}
                  </span>
                  <span className="truncate text-ink-subtle">{line.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
