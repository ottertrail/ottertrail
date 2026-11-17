import * as React from "react";

import { formatCount, formatDay, niceTicks } from "./format";

export interface DayValue {
  /** "YYYY-MM-DD" */
  day: string;
  /** null: nothing measured that day; the line has a gap there. */
  value: number | null;
}

export interface TooltipRow {
  label: string;
  value: string;
  /** The metric the line draws; its row carries the line's key. */
  plotted: boolean;
}

/** Plot height; the x-axis labels get their own band below it, inside the container. */
const PLOT_HEIGHT = 220;
const AXIS_BAND = 28;
const HEIGHT = 12 + PLOT_HEIGHT + AXIS_BAND;
const MARGIN = { top: 12, right: 16, left: 48 };
/** Space each x-axis label needs, so labels never collide. */
const LABEL_SPACING = 72;

/** The line's runs of days with a value, as indexes into the points: a gap breaks the line. */
function runsOf(points: DayValue[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(index);
    }
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * One metric per day as a line with a light area wash: a single series, so
 * no legend (the card's title names the metric). A crosshair snaps to the
 * nearest day under the pointer, and the readout lists every metric of that
 * day.
 *
 * For keyboards and screen readers the chart holds a hidden range input
 * over the days: the arrow keys, Home and End move between days, and each
 * day is read out with all its numbers. The table view, outside this component, keeps every value
 * reachable without moving through the chart.
 */
export function DayChart({
  points,
  label,
  tooltipRows,
  formatValue = formatCount,
}: {
  points: DayValue[];
  /** What the line is, such as "Visitors per day"; the chart's accessible name. */
  label: string;
  tooltipRows: (index: number) => TooltipRow[];
  /** The y-axis labels; counts by default. */
  formatValue?: (value: number) => string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [active, setActive] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return undefined;
    }
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = points.length;
  const last = count - 1;
  const ticks = niceTicks(Math.max(0, ...points.map((point) => point.value ?? 0)));
  const top = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const x = (index: number) =>
    MARGIN.left + (count <= 1 ? plotWidth / 2 : (index / last) * plotWidth);
  const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;

  const valueAt = (index: number) => points[index]?.value ?? 0;
  // Days without a value break the line; a day alone between gaps is a dot.
  const runs = runsOf(points);
  const lines = runs
    .filter((run) => run.length > 1)
    .map((run) => {
      const first = run[0] ?? 0;
      const end = run.at(-1) ?? 0;
      const line = run
        .map((index, at) => `${at === 0 ? "M" : "L"}${x(index)},${y(valueAt(index))}`)
        .join("");
      return { first, line, area: `${line}L${x(end)},${y(0)}L${x(first)},${y(0)}Z` };
    });
  const dots = runs.filter((run) => run.length === 1).map((run) => run[0] ?? 0);
  // Label every nth day, counted back from the last, so the latest day always has one.
  const labelEvery = Math.max(
    1,
    Math.ceil(count / Math.max(1, Math.floor(plotWidth / LABEL_SPACING))),
  );

  function dayAt(clientX: number): number | null {
    const element = containerRef.current;
    if (element === null || count === 0) {
      return null;
    }
    const offset = clientX - element.getBoundingClientRect().left - MARGIN.left;
    const index = count <= 1 ? 0 : Math.round((offset / plotWidth) * last);
    return Math.min(last, Math.max(0, index));
  }

  // The keyboard position stays on the latest day until someone moves it.
  const shown = active ?? last;
  const shownPoint = points[shown];
  const readout =
    shownPoint === undefined
      ? ""
      : `${formatDay(shownPoint.day, { weekday: true })}: ${tooltipRows(shown)
          .map((row) => `${row.value} ${row.label}`)
          .join(", ")}`;
  const activePoint = active === null ? undefined : points[active];
  const rows = active === null ? [] : tooltipRows(active);
  const tooltipOnLeft = active !== null && x(active) > width / 2;

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring"
      style={{ height: HEIGHT }}
      onPointerMove={(event) => setActive(dayAt(event.clientX))}
      onPointerLeave={() => setActive(null)}
    >
      {count > 0 && (
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
          {points.map((point, index) =>
            (last - index) % labelEvery === 0 ? (
              <text
                key={point.day}
                x={x(index)}
                y={MARGIN.top + PLOT_HEIGHT + 18}
                textAnchor={
                  count > 1 && index === 0
                    ? "start"
                    : count > 1 && index === last
                      ? "end"
                      : "middle"
                }
                className="fill-ink-subtle text-[11px]"
              >
                {formatDay(point.day)}
              </text>
            ) : null,
          )}
          {lines.map((item) => (
            <g key={item.first}>
              <path d={item.area} fill="var(--chart-1)" fillOpacity={0.1} />
              <path
                d={item.line}
                fill="none"
                stroke="var(--chart-1)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}
          {dots.map((index) => (
            <circle key={index} cx={x(index)} cy={y(valueAt(index))} r={4} fill="var(--chart-1)" />
          ))}
          {activePoint !== undefined && active !== null && (
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
              {activePoint.value !== null && (
                <circle
                  cx={x(active)}
                  cy={y(activePoint.value)}
                  r={4}
                  fill="var(--chart-1)"
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
      )}
      {activePoint !== undefined && active !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
          style={tooltipOnLeft ? { right: width - x(active) + 12 } : { left: x(active) + 12 }}
        >
          <p className="mb-1.5 text-ink-subtle">{formatDay(activePoint.day, { weekday: true })}</p>
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <li key={row.label} className="flex items-center gap-2">
                <span
                  className="h-0.5 w-3 rounded-full"
                  style={{ background: row.plotted ? "var(--chart-1)" : "transparent" }}
                />
                <span className="font-semibold text-ink tabular-nums">{row.value}</span>
                <span className="text-ink-subtle">{row.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
