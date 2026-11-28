import * as React from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { ChartKeys, ChartReadout, EdgeTick, IsolatedDot } from "@/components/chart-kit";
import { TruncatedText } from "@/components/truncated-text";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  activeDot,
  AXIS_BAND,
  evenTicks,
  MARGIN,
  PLOT_FRAME,
  useWidth,
  X_AXIS,
  useYAxisWidth,
  Y_AXIS,
} from "@/lib/chart-axis";
import { MISSING } from "@/lib/missing";

import { bucketLabel, ticksFor, timeTicks } from "./chart-time";

/** Nulls break lines; isolated values draw as dots. A hidden range input provides keyboard navigation. The caller supplies the table view. */

export interface ChartLine {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

const DEFAULT_PLOT_HEIGHT = 220;

/** The tooltip: Recharts passes `active` and `label`, the bucket's index. */
function Readout({
  active,
  label,
  lines,
  labelOf,
  formatValue,
}: {
  active?: boolean;
  label?: unknown;
  lines: ChartLine[];
  labelOf: (index: number) => string;
  formatValue: (value: number) => string;
}) {
  if (active !== true || typeof label !== "number") return null;
  return (
    <ChartReadout
      title={labelOf(label)}
      rows={lines.map((line) => {
        const value = line.values[label];
        return {
          key: line.key,
          color: line.color,
          value: value === null || value === undefined ? MISSING : formatValue(value),
          label: line.label,
        };
      })}
    />
  );
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
  plotHeight = DEFAULT_PLOT_HEIGHT,
  starts,
}: {
  start: string;
  /** Use explicit ISO starts for daylight saving changes; otherwise advance by stepSeconds. */
  starts?: string[] | undefined;
  stepSeconds: number;
  buckets: number;
  timeZone: string;
  lines: ChartLine[];
  label: string;
  formatValue: (value: number) => string;
  /** Expand the requested axis range to include outlying values. */
  domain?: { min: number; max: number } | undefined;
  plotHeight?: number;
}) {
  const [keyed, setKeyed] = React.useState<number | null>(null);
  const [frameRef, width] = useWidth<HTMLDivElement>();

  const startMs = Date.parse(start);
  const times = Array.from({ length: buckets }, (_, index) => {
    const known = starts?.[index];
    return known === undefined ? new Date(startMs + index * stepSeconds * 1000) : new Date(known);
  });
  /** End labels at the next explicit start to reflect daylight saving changes. Daily buckets keep their day. */
  const labelOf = (index: number) => {
    const next = starts?.[index + 1];
    const from = times[index] ?? new Date(startMs);
    const seconds =
      next === undefined || stepSeconds >= 86_400
        ? stepSeconds
        : (Date.parse(next) - from.getTime()) / 1000;
    return bucketLabel(from, seconds, timeZone);
  };
  const all = lines.flatMap((line) => line.values.filter((value) => value !== null));
  const ticks = ticksFor(Math.min(domain?.min ?? 0, ...all), Math.max(domain?.max ?? 0, ...all));
  const yWidth = useYAxisWidth(ticks.map(formatValue));
  const axis = timeTicks(times, timeZone, stepSeconds);
  const xTicks = evenTicks(axis.ticks, axis.ticks.map(axis.label), width);
  // Series keys can hold dots (model names), which Recharts would read as paths, so each line
  // reads its value by position.
  const data = times.map((_, index) => ({
    index,
    values: lines.map((line) => line.values[index] ?? null),
  }));
  const config: ChartConfig = Object.fromEntries(
    lines.map((line) => [line.key, { label: line.label, color: line.color }]),
  );

  const valueText = (value: number | null | undefined) =>
    value === null || value === undefined ? "no data" : formatValue(value);
  const latest = Math.max(
    0,
    ...lines.map((line) => line.values.findLastIndex((value) => value !== null)),
  );
  const readout = (index: number) =>
    `${labelOf(index)}: ${lines
      .map((line) => `${line.label} ${valueText(line.values[index])}`)
      .join(", ")}`;

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
              <TruncatedText text={line.label} className="max-w-64" />
            </li>
          ))}
        </ul>
      )}
      <div ref={frameRef} className={PLOT_FRAME} data-slot="time-chart">
        <ChartKeys
          label={label}
          count={buckets}
          index={keyed}
          fallback={latest}
          valueText={readout}
          onIndex={setKeyed}
        />
        <ChartContainer
          config={config}
          aria-hidden="true"
          className="aspect-auto w-full"
          style={{ height: MARGIN.top + plotHeight + AXIS_BAND }}
        >
          <LineChart data={data} margin={MARGIN} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--hairline)" />
            <XAxis
              {...X_AXIS}
              dataKey="index"
              ticks={xTicks}
              tickFormatter={(index: number) => axis.label(index)}
              tick={<EdgeTick format={axis.label} />}
            />
            <YAxis
              {...Y_AXIS}
              width={yWidth}
              ticks={ticks}
              domain={[ticks[0] ?? 0, ticks.at(-1) ?? 1]}
              tickFormatter={formatValue}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--hairline-tertiary)" }}
              isAnimationActive={false}
              position={{ y: 8 }}
              wrapperStyle={{ zIndex: 10 }}
              {...(keyed === null ? {} : { active: true, defaultIndex: keyed })}
              content={<Readout lines={lines} labelOf={labelOf} formatValue={formatValue} />}
            />
            {lines.toReversed().map((line) => {
              const position = lines.indexOf(line);
              return (
                <Line
                  key={line.key}
                  name={line.label}
                  dataKey={(row: (typeof data)[number]) => row.values[position]}
                  stroke={line.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  dot={<IsolatedDot series={line.values} seriesColor={line.color} />}
                  activeDot={activeDot(line.color)}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ChartContainer>
      </div>
    </div>
  );
}
