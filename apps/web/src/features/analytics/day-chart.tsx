import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartKeys, ChartReadout, EdgeTick, IsolatedDot } from "@/components/chart-kit";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  activeDot,
  AXIS_BAND,
  evenTicks,
  formatAxisCount,
  MARGIN,
  PLOT_FRAME,
  useWidth,
  X_AXIS,
  useYAxisWidth,
  Y_AXIS,
} from "@/lib/chart-axis";

import { formatDay, niceTicks } from "./format";

export interface DayValue {
  /** The point's key: a "YYYY-MM-DD" day, or whatever `tickLabel` and `pointLabel` read. */
  day: string;
  /** null: nothing measured that day; the line has a gap there. */
  value: number | null;
}

export interface TooltipRow {
  label: string;
  value: string;
  plotted: boolean;
  /** The row's series color, when it is not the main line's. */
  color?: string | undefined;
}

const DEFAULT_PLOT_HEIGHT = 220;
const COLOR = "var(--chart-1)";
/**
 * The comparison: the next categorical slot, thinner and dashed so it
 * stays behind the main line (docs/design-system.md, "Charts").
 */
export const COMPARISON_COLOR = "var(--chart-2)";
const CONFIG = { value: { color: COLOR }, previous: { color: COMPARISON_COLOR } };

/** Marks over the points, drawn by the caller: the dashboard's notes and releases. */
export interface DayChartMarks {
  /** Drawn inside the plot, under the lines. */
  layer: React.ReactNode;
  /** A point's marks in its readout; "" for none. */
  text: (index: number) => string;
  /** A point's marks in its tooltip, under the values. */
  tooltip: (index: number) => React.ReactNode;
  /** A click on a point (not a finger's tap, which shows the tooltip), or Enter on it. */
  onSelect?: ((index: number) => void) | undefined;
}

/** The tooltip: Recharts passes `active` and `label`, the day's index. */
function Readout({
  active,
  label,
  title,
  rows,
  marks,
}: {
  active?: boolean;
  label?: unknown;
  title: (index: number) => string;
  rows: (index: number) => TooltipRow[];
  marks?: DayChartMarks | undefined;
}) {
  if (active !== true || typeof label !== "number") return null;
  return (
    <ChartReadout
      title={title(label)}
      rows={rows(label).map((row) => ({
        key: row.label,
        color: row.color ?? (row.plotted ? COLOR : undefined),
        value: row.value,
        label: row.label,
      }))}
      extra={marks?.tooltip(label)}
    />
  );
}

/** A line's key in the legend: solid for the period, dashed for the comparison. */
function LegendKey({ color, dashed }: { color: string; dashed: boolean }) {
  return (
    <svg aria-hidden="true" width="16" height="4" className="shrink-0">
      <line
        x1="1"
        x2="15"
        y1="2"
        y2="2"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={dashed ? "4 3" : undefined}
      />
    </svg>
  );
}

/**
 * One measure per day (or hour, week, month), as a line with a wash under
 * it, and optionally a comparison as a dashed line behind it. The hidden
 * range input supports keyboard and screen reader navigation. The caller
 * supplies the table view.
 */
export function DayChart({
  points,
  label,
  tooltipRows,
  formatValue = formatAxisCount,
  plotHeight = DEFAULT_PLOT_HEIGHT,
  pointLabel = (day) => formatDay(day, { weekday: true }),
  tickLabel = formatDay,
  comparison,
  marks,
}: {
  points: DayValue[];
  label: string;
  tooltipRows: (index: number) => TooltipRow[];
  /** The y axis's labels. */
  formatValue?: (value: number) => string;
  plotHeight?: number;
  /** A point's name in its tooltip and readout: "Tue 17 Nov", or "Week of 16 Nov" for weeks. */
  pointLabel?: (day: string) => string;
  /** A point's name under the x axis: "17 Nov", or "14:00" for hours. */
  tickLabel?: (day: string) => string;
  /** The values compared with, one per point, and the names of both lines in the legend. */
  comparison?: { values: (number | null)[]; label: string; currentLabel: string } | undefined;
  marks?: DayChartMarks | undefined;
}) {
  const [keyed, setKeyed] = React.useState<number | null>(null);
  const touched = React.useRef(false);
  const select = marks?.onSelect;
  const [frameRef, width] = useWidth<HTMLDivElement>();
  const compared = comparison?.values ?? [];
  const ticks = niceTicks(
    Math.max(0, ...points.map((point) => point.value ?? 0), ...compared.map((value) => value ?? 0)),
  );
  const yWidth = useYAxisWidth(ticks.map(formatValue));
  const data = points.map((point, index) => ({
    index,
    value: point.value,
    previous: compared[index] ?? null,
  }));
  const values = points.map((point) => point.value);
  const last = points.length - 1;
  const xTicks = evenTicks(
    data.map((row) => row.index),
    points.map((point) => tickLabel(point.day)),
    width,
  );

  const dayOf = (index: number) => {
    const point = points[index];
    return point === undefined ? "" : tickLabel(point.day);
  };
  const readout = (index: number) => {
    const point = points[index];
    const marked = marks?.text(index) ?? "";
    return point === undefined
      ? ""
      : `${pointLabel(point.day)}: ${tooltipRows(index)
          .map((row) => `${row.value} ${row.label}`)
          .join(", ")}${marked === "" ? "" : `. ${marked}`}`;
  };
  const titleOf = (index: number) => {
    const point = points[index];
    return point === undefined ? "" : pointLabel(point.day);
  };

  return (
    <div
      ref={frameRef}
      className={select === undefined ? PLOT_FRAME : `${PLOT_FRAME} cursor-pointer`}
      data-slot="day-chart"
      onPointerDown={(event) => {
        touched.current = event.pointerType === "touch";
      }}
    >
      {comparison !== undefined && (
        <ul
          aria-label="Lines"
          className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-subtle"
        >
          <li className="flex items-center gap-1.5">
            <LegendKey color={COLOR} dashed={false} />
            {comparison.currentLabel}
          </li>
          <li className="flex items-center gap-1.5">
            <LegendKey color={COMPARISON_COLOR} dashed />
            {comparison.label}
          </li>
        </ul>
      )}
      <ChartKeys
        label={label}
        count={points.length}
        index={keyed}
        fallback={last}
        valueText={readout}
        onIndex={setKeyed}
        onEnter={select}
      />
      <ChartContainer
        config={CONFIG}
        aria-hidden="true"
        className="aspect-auto w-full"
        style={{ height: MARGIN.top + plotHeight + AXIS_BAND }}
      >
        <AreaChart
          data={data}
          margin={MARGIN}
          accessibilityLayer={false}
          onClick={(state) => {
            const index = Number(state.activeTooltipIndex ?? Number.NaN);
            if (select !== undefined && !touched.current && Number.isInteger(index)) select(index);
          }}
        >
          <CartesianGrid vertical={false} stroke="var(--hairline)" />
          {marks?.layer}
          <XAxis
            {...X_AXIS}
            dataKey="index"
            ticks={xTicks}
            tickFormatter={dayOf}
            tick={<EdgeTick format={dayOf} />}
          />
          <YAxis
            {...Y_AXIS}
            width={yWidth}
            ticks={ticks}
            domain={[0, ticks.at(-1) ?? 1]}
            tickFormatter={formatValue}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--hairline-tertiary)" }}
            isAnimationActive={false}
            position={{ y: 8 }}
            wrapperStyle={{ zIndex: 10 }}
            {...(keyed === null ? {} : { active: true, defaultIndex: keyed })}
            content={<Readout title={titleOf} rows={tooltipRows} marks={marks} />}
          />
          {comparison !== undefined && (
            <Area
              dataKey="previous"
              stroke={COMPARISON_COLOR}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
              dot={false}
              activeDot={activeDot(COMPARISON_COLOR)}
              isAnimationActive={false}
              data-series="comparison"
            />
          )}
          <Area
            dataKey="value"
            stroke={COLOR}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={COLOR}
            fillOpacity={0.1}
            dot={<IsolatedDot series={values} seriesColor={COLOR} />}
            activeDot={activeDot(COLOR)}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
