import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { Missing } from "@/components/missing";
import { Skeleton } from "@/components/ui/skeleton";
import type { PageRange } from "@/lib/analytics-api";
import { type MetricKind, metricSparklineQuery } from "@/lib/metrics-api";

import { stepText } from "./chart-time";
import { formatMetricValue, formatRate } from "./metric-format";

/** What each kind's sparkline draws, in words: the line its chart opens on. */
const SPARKLINE_MEASURES: Record<MetricKind, string> = {
  gauge: "Average",
  updown: "Total",
  counter: "Per second",
  histogram: "95th percentile",
};

/** The longest period a sparkline is drawn for, in days, as the API allows. */
export const SPARKLINE_MAX_DAYS = 7;

const WIDTH = 96;
const HEIGHT = 24;
/** Room for the 2px line and the latest point's dot at the edges. */
const PAD = 3;

/**
 * A small line of one metric over the period, in a row of the Metrics
 * list: the measure its chart opens on, in at most 30 buckets, on its own
 * scale from its lowest to its highest value. The line is the de-emphasis
 * gray, 2px, broken where nothing arrived; the latest value is a dot in
 * the first chart color. No axis: the metric's own chart carries the
 * numbers. The line is decoration, hidden from screen readers and never
 * focused, so a row adds no tab stop: its words (the measure, the lowest,
 * the highest, and the latest value) are visually hidden text beside it,
 * and the hover title for the pointer.
 */
function Line({
  values,
  label,
}: {
  values: (number | null)[];
  /** What it shows, in words: visually hidden text and the hover title. */
  label: string;
}) {
  const present = values.filter((value): value is number => value !== null);
  const low = Math.min(...present);
  const high = Math.max(...present);
  const last = Math.max(1, values.length - 1);
  const x = (index: number) => PAD + (index / last) * (WIDTH - 2 * PAD);
  const y = (value: number) =>
    high === low ? HEIGHT / 2 : PAD + (1 - (value - low) / (high - low)) * (HEIGHT - 2 * PAD);
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push(index);
  });
  if (run.length > 0) runs.push(run);
  const latest = values.findLastIndex((value) => value !== null);
  return (
    <span data-slot="sparkline" title={label} className="flex h-6 w-24 items-center">
      <span className="sr-only">{label}</span>
      <svg
        aria-hidden="true"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block overflow-visible"
      >
        {runs.map((indexes) =>
          indexes.length === 1 ? (
            <circle
              key={indexes[0]}
              cx={x(indexes[0] ?? 0)}
              cy={y(values[indexes[0] ?? 0] ?? 0)}
              r={1.5}
              fill="var(--ink-subtle)"
            />
          ) : (
            <path
              key={indexes[0]}
              d={indexes
                .map((index, n) => `${n === 0 ? "M" : "L"}${x(index)},${y(values[index] ?? 0)}`)
                .join("")}
              fill="none"
              stroke="var(--ink-subtle)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ),
        )}
        {latest >= 0 && (
          <circle
            cx={x(latest)}
            cy={y(values[latest] ?? 0)}
            r={2.5}
            fill="var(--chart-1)"
            stroke="var(--background)"
            strokeWidth={1}
          />
        )}
      </svg>
    </span>
  );
}

/**
 * Whether `ref`'s element is within 200 pixels of what the reader sees,
 * now: of the scrolling content panel (`app-content`), where the pages
 * scroll, or of the window outside it. Without IntersectionObserver (an
 * old browser), always.
 */
function useNearView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = React.useState(() => typeof IntersectionObserver === "undefined");
  React.useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) setNear(entry.isIntersecting);
      },
      { root: element.closest("[data-slot=app-content]"), rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}

/**
 * One row's sparkline, asked for only while the row is within 200 pixels
 * of the view: a row scrolled past does not ask again when the period or
 * environment changes, only once it is back in view. At most two lines
 * of a page load at once (metricSparklineQuery), and the API gives them
 * one of its places. Loading is a skeleton; a failed load, a period with
 * nothing, and a histogram without bucket counts are each a dash that
 * says so, never a flat line.
 */
export function MetricSparkline({
  projectId,
  range,
  environment,
  metric,
  days,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  metric: { name: string; kind: MetricKind; unit: string };
  /**
   * The period's days: past SPARKLINE_MAX_DAYS no line is asked for.
   * Undefined while the list's answer for the period has not come: wait.
   */
  days: number | undefined;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const near = useNearView(ref);
  const tooLong = days !== undefined && days > SPARKLINE_MAX_DAYS;
  const spark = useQuery({
    ...metricSparklineQuery(projectId, range, environment, metric),
    enabled: near && days !== undefined && !tooLong,
  });
  const data = spark.data;
  let content: React.ReactNode;
  if (tooLong) content = <Missing label={`Lines are drawn for up to ${SPARKLINE_MAX_DAYS} days`} />;
  else if (spark.isError) content = <Missing label="The line could not load" />;
  else if (data === undefined) {
    content = <Skeleton className="h-6 w-24" aria-label="Loading the line" />;
  } else if (!data.percentiles) content = <Missing label="No bucket counts to draw from" />;
  else if (data.values.every((value) => value === null)) {
    content = <Missing label="No data in this period" />;
  } else {
    const present = data.values.filter((value): value is number => value !== null);
    const format = (value: number) =>
      metric.kind === "counter"
        ? formatRate(value, metric.unit)
        : formatMetricValue(value, metric.unit);
    const latest = data.values.findLast((value) => value !== null) ?? 0;
    const label = `${SPARKLINE_MEASURES[metric.kind]} per ${stepText(data.stepSeconds)}: lowest ${format(
      Math.min(...present),
    )}, highest ${format(Math.max(...present))}, latest ${format(latest)}${
      data.seriesCapped ? `, of the ${data.seriesCount} series with the most points` : ""
    }`;
    content = <Line values={data.values} label={label} />;
  }
  return (
    <div ref={ref} className="flex h-6 w-24 items-center">
      {content}
    </div>
  );
}
