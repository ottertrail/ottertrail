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
  Y_AXIS,
} from "@/lib/chart-axis";

import { formatDay, niceTicks } from "./format";

export interface DayValue {
  day: string;
  /** null: nothing measured that day; the line has a gap there. */
  value: number | null;
}

export interface TooltipRow {
  label: string;
  value: string;
  plotted: boolean;
}

const DEFAULT_PLOT_HEIGHT = 220;
const COLOR = "var(--chart-1)";
const CONFIG = { value: { color: COLOR } };

/** The tooltip: Recharts passes `active` and `label`, the day's index. */
function Readout({
  active,
  label,
  title,
  rows,
}: {
  active?: boolean;
  label?: unknown;
  title: (index: number) => string;
  rows: (index: number) => TooltipRow[];
}) {
  if (active !== true || typeof label !== "number") return null;
  return (
    <ChartReadout
      title={title(label)}
      rows={rows(label).map((row) => ({
        key: row.label,
        color: row.plotted ? COLOR : undefined,
        value: row.value,
        label: row.label,
      }))}
    />
  );
}

/** One measure per day, as a line with a wash under it. The hidden range input supports keyboard and screen reader navigation. The caller supplies the table view. */
export function DayChart({
  points,
  label,
  tooltipRows,
  formatValue = formatAxisCount,
  plotHeight = DEFAULT_PLOT_HEIGHT,
  pointLabel = (day) => formatDay(day, { weekday: true }),
}: {
  points: DayValue[];
  label: string;
  tooltipRows: (index: number) => TooltipRow[];
  /** The y axis's labels. */
  formatValue?: (value: number) => string;
  plotHeight?: number;
  /** A point's name in its tooltip and readout: "Tue 17 Nov", or "Week of 16 Nov" for weeks. */
  pointLabel?: (day: string) => string;
}) {
  const [keyed, setKeyed] = React.useState<number | null>(null);
  const [frameRef, width] = useWidth<HTMLDivElement>();
  const ticks = niceTicks(Math.max(0, ...points.map((point) => point.value ?? 0)));
  const data = points.map((point, index) => ({ index, value: point.value }));
  const values = points.map((point) => point.value);
  const last = points.length - 1;
  const xTicks = evenTicks(
    data.map((row) => row.index),
    points.map((point) => formatDay(point.day)),
    width,
  );

  const dayOf = (index: number) => {
    const point = points[index];
    return point === undefined ? "" : formatDay(point.day);
  };
  const readout = (index: number) => {
    const point = points[index];
    return point === undefined
      ? ""
      : `${pointLabel(point.day)}: ${tooltipRows(index)
          .map((row) => `${row.value} ${row.label}`)
          .join(", ")}`;
  };
  const titleOf = (index: number) => {
    const point = points[index];
    return point === undefined ? "" : pointLabel(point.day);
  };

  return (
    <div ref={frameRef} className={PLOT_FRAME} data-slot="day-chart">
      <ChartKeys
        label={label}
        count={points.length}
        index={keyed}
        fallback={last}
        valueText={readout}
        onIndex={setKeyed}
      />
      <ChartContainer
        config={CONFIG}
        aria-hidden="true"
        className="aspect-auto w-full"
        style={{ height: MARGIN.top + plotHeight + AXIS_BAND }}
      >
        <AreaChart data={data} margin={MARGIN} accessibilityLayer={false}>
          <CartesianGrid vertical={false} stroke="var(--hairline)" />
          <XAxis
            {...X_AXIS}
            dataKey="index"
            ticks={xTicks}
            tickFormatter={dayOf}
            tick={<EdgeTick format={dayOf} />}
          />
          <YAxis
            {...Y_AXIS}
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
            content={<Readout title={titleOf} rows={tooltipRows} />}
          />
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
