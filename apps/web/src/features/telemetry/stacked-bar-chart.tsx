import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartKeys, ChartReadout, EdgeTick } from "@/components/chart-kit";
import { TruncatedText } from "@/components/truncated-text";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  AXIS_BAND,
  evenTicks,
  MARGIN,
  PLOT_FRAME,
  useWidth,
  X_AXIS,
  Y_AXIS,
} from "@/lib/chart-axis";

import { ticksFor, timeTicks } from "./chart-time";
import { bucketStart, type ListChartFrame, listBucketLabel } from "./list-chart-frame";

/** A hidden range input provides keyboard navigation. The caller supplies the table view. */

export interface BarPart {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/** Surface between the parts of one bar. */
const PART_GAP = 2;
/** The least height a part with a value is drawn at, so a few errors under many records show. */
const MIN_PART = 3;
const MAX_BAR = 24;
/** About the y axis's width and the margins, to size the gap between bars before drawing. */
const AXIS_ROOM = 56;

interface Row {
  index: number;
  values: number[];
}

/**
 * One part of one bar. A part with a value is at least MIN_PART high, and the parts above it
 * move up by what it gained, so the stack's numbers stay as they are and only its top grows.
 * Parts above the baseline give up 2px of their bottom, so the surface shows between them, and
 * the top part of each bar has rounded corners.
 */
function PartShape({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  payload,
  part,
  parts,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Row;
  part: number;
  parts: BarPart[];
}) {
  const index = payload?.index ?? -1;
  const values = payload?.values ?? [];
  const self = parts[part];
  if (self === undefined || (values[part] ?? 0) <= 0) return null;
  const below = values.slice(0, part).some((value) => value > 0);
  const isTop = !values.slice(part + 1).some((value) => value > 0);
  // Recharts draws each part to scale: its height per unit gives the parts below theirs.
  const perUnit = height / (values[part] ?? 1);
  const lift = values
    .slice(0, part)
    .reduce((sum, value) => sum + (value > 0 ? Math.max(0, MIN_PART - value * perUnit) : 0), 0);
  const gap = below ? PART_GAP : 0;
  const bottom = y + height - lift - gap;
  const shown = Math.max(MIN_PART, height - gap);
  const top = bottom - shown;
  const r = isTop ? Math.min(4, width / 2, shown) : 0;
  const right = x + width;
  return (
    <path
      data-part={self.key}
      data-bucket={index}
      fill={self.color}
      d={`M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${right - r}Q${right},${top} ${right},${top + r}V${bottom}Z`}
    />
  );
}

/** The tooltip: Recharts passes `active` and `label`, the bucket's index. */
function Readout({
  active,
  label,
  labelOf,
  parts,
  totals,
  formatValue,
  hint,
}: {
  active?: boolean;
  label?: unknown;
  labelOf: (index: number) => string;
  parts: BarPart[];
  totals: number[];
  formatValue: (value: number) => string;
  hint?: string | undefined;
}) {
  if (active !== true || typeof label !== "number") return null;
  return (
    <ChartReadout
      title={labelOf(label)}
      rows={[
        ...parts.map((part) => ({
          key: part.key,
          color: part.color,
          marker: "square" as const,
          value: formatValue(part.values[label] ?? 0),
          label: part.label,
        })),
        ...(parts.length >= 2
          ? [
              {
                key: "total",
                value: formatValue(totals[label] ?? 0),
                label: "In all",
                total: true,
              },
            ]
          : []),
      ]}
      footer={hint}
    />
  );
}

export function StackedBarChart({
  frame,
  parts,
  label,
  formatValue,
  plotHeight = 140,
  onSelect,
  selectHint,
  bucketName,
}: {
  /** Bucket starts follow the instance timezone. */
  frame: ListChartFrame;
  /** A bar's name in its tooltip and readout, such as "Week of 16 Nov"; by default its start. */
  bucketName?: ((index: number) => string) | undefined;
  /** Stack and list legend entries in the supplied order, from the baseline up. */
  parts: BarPart[];
  label: string;
  formatValue: (value: number) => string;
  plotHeight?: number;
  onSelect?: ((index: number) => void) | undefined;
  /** What a click on a bar does; `touch` when a finger chose the bar, which takes a second tap. */
  selectHint?: ((touch: boolean) => string) | undefined;
}) {
  const { stepSeconds, timeZone } = frame;
  const buckets = frame.bucketStarts.length;
  const [frameRef, width] = useWidth<HTMLDivElement>();
  const [keyed, setKeyed] = React.useState<number | null>(null);
  // A tap shows a bar's tooltip; a second tap on the same bar selects it, so a finger can read
  // a bar before choosing it. A drag to other bars starts again.
  const [touch, setTouch] = React.useState(false);
  const [armed, setArmed] = React.useState<number | null>(null);

  const totals = Array.from({ length: buckets }, (_, index) =>
    parts.reduce((sum, part) => sum + (part.values[index] ?? 0), 0),
  );
  // The bars count things (records, traces, visitors): no half steps.
  const ticks = ticksFor(0, Math.max(0, ...totals), 4, 1);
  const times = Array.from({ length: buckets }, (_, index) => bucketStart(frame, index));
  const axis = timeTicks(times, timeZone, stepSeconds);
  const xTicks = evenTicks(axis.ticks, axis.ticks.map(axis.label), width);
  const slot = buckets > 0 ? Math.max(0, width - AXIS_ROOM) / buckets : 0;
  // Recharts leaves barCategoryGap on each side of a bar: 2px between bars, 1px when narrow.
  const barGap = slot >= 6 ? 1 : slot >= 3 ? 0.5 : 0;
  const data: Row[] = times.map((_, index) => ({
    index,
    values: parts.map((part) => part.values[index] ?? 0),
  }));
  const config: ChartConfig = Object.fromEntries(
    parts.map((part) => [part.key, { label: part.label, color: part.color }]),
  );

  const labelOf = bucketName ?? ((index: number) => listBucketLabel(frame, index));
  const describe = (index: number) =>
    `${labelOf(index)}: ${formatValue(totals[index] ?? 0)} in all${parts
      .map((part) => `, ${part.label} ${formatValue(part.values[index] ?? 0)}`)
      .join("")}`;

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
              <TruncatedText text={part.label} className="max-w-64" />
            </li>
          ))}
        </ul>
      )}
      <div
        ref={frameRef}
        data-slot="stacked-bar-chart"
        className={`${PLOT_FRAME} ${onSelect === undefined ? "" : "cursor-pointer"}`}
        onPointerDown={(event) => setTouch(event.pointerType === "touch")}
        onTouchMove={() => setArmed(null)}
      >
        <ChartKeys
          label={label}
          count={buckets}
          index={keyed}
          fallback={Math.max(0, buckets - 1)}
          valueText={describe}
          onIndex={setKeyed}
          onEnter={onSelect}
        />
        <ChartContainer
          config={config}
          aria-hidden="true"
          className="aspect-auto w-full"
          style={{ height: MARGIN.top + plotHeight + AXIS_BAND }}
        >
          <BarChart
            data={data}
            margin={MARGIN}
            accessibilityLayer={false}
            barCategoryGap={barGap}
            onClick={(state) => {
              const index = Number(state.activeTooltipIndex ?? Number.NaN);
              if (onSelect === undefined || !Number.isInteger(index)) return;
              if (touch && armed !== index) {
                setArmed(index);
                return;
              }
              onSelect(index);
            }}
          >
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
              ticks={ticks}
              domain={[0, ticks.at(-1) ?? 1]}
              tickFormatter={formatValue}
            />
            <ChartTooltip
              cursor={{ fill: "var(--hairline)", opacity: 0.6 }}
              isAnimationActive={false}
              position={{ y: 8 }}
              wrapperStyle={{ zIndex: 10 }}
              {...(keyed === null ? {} : { active: true, defaultIndex: keyed })}
              content={
                <Readout
                  labelOf={labelOf}
                  parts={parts}
                  totals={totals}
                  formatValue={formatValue}
                  hint={selectHint?.(touch)}
                />
              }
            />
            {parts.map((part, position) => (
              <Bar
                key={part.key}
                name={part.label}
                stackId="stack"
                dataKey={(row: Row) => row.values[position]}
                fill={part.color}
                maxBarSize={MAX_BAR}
                isAnimationActive={false}
                shape={<PartShape part={position} parts={parts} />}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </div>
    </div>
  );
}
