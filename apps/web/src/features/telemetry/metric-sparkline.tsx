import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Line as RechartsLine, LineChart, XAxis, YAxis } from "recharts";

import { Missing } from "@/components/missing";
import { ChartContainer } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { PageRange } from "@/lib/analytics-api";
import { type MetricKind, metricSparklineQuery } from "@/lib/metrics-api";

import { stepText } from "./chart-time";
import { formatMetricValue, formatRate } from "./metric-format";

const SPARKLINE_MEASURES: Record<MetricKind, string> = {
  gauge: "Average",
  updown: "Total",
  counter: "Per second",
  histogram: "95th percentile",
};

/** Match the API's maximum sparkline period in days. */
export const SPARKLINE_MAX_DAYS = 7;

/** Leave room for the 2px stroke and latest-point dot. */
const PAD = 3;
const CONFIG = { value: { color: "var(--ink-subtle)" } };

/** A point of the line: a dot where a value stands alone, and the latest value in chart-1. */
function SparkDot({
  series,
  latest,
  cx,
  cy,
  index = -1,
}: {
  series: (number | null)[];
  latest: number;
  cx?: number;
  cy?: number;
  index?: number;
}) {
  if (cx === undefined || cy === undefined || series[index] === null) return null;
  if (index === latest) {
    return (
      <circle
        cx={cx}
        cy={cy}
        r={2.5}
        fill="var(--chart-1)"
        stroke="var(--background)"
        strokeWidth={1}
      />
    );
  }
  const alone = (series[index - 1] ?? null) === null && (series[index + 1] ?? null) === null;
  return alone ? <circle cx={cx} cy={cy} r={1.5} fill="var(--ink-subtle)" /> : null;
}

/** Provide hidden text and a hover title; the line itself adds no tab stop. */
function Line({
  values,
  label,
}: {
  values: (number | null)[];
  /** Used as hidden text and the hover title. */
  label: string;
}) {
  const present = values.filter((value): value is number => value !== null);
  const low = Math.min(...present);
  const high = Math.max(...present);
  const latest = values.findLastIndex((value) => value !== null);
  const data = values.map((value, index) => ({ index, value }));
  return (
    <span data-slot="sparkline" title={label} className="flex h-6 w-24 items-center">
      <span className="sr-only">{label}</span>
      <ChartContainer config={CONFIG} aria-hidden="true" className="aspect-auto h-6 w-24">
        <LineChart
          data={data}
          margin={{ top: PAD, right: PAD, bottom: PAD, left: PAD }}
          accessibilityLayer={false}
        >
          <XAxis dataKey="index" hide />
          <YAxis hide domain={high === low ? [low - 1, high + 1] : [low, high]} />
          <RechartsLine
            dataKey="value"
            stroke="var(--ink-subtle)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            dot={<SparkDot series={values} latest={latest} />}
            activeDot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </span>
  );
}

/** Observe within 200 pixels of app-content or the window. Treat missing IntersectionObserver as visible. */
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

/** Fetch within 200 pixels of view, at most two at once (metricSparklineQuery). Missing data, errors, and histograms without counts show a dash. */
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
  /** Wait while undefined; skip periods longer than SPARKLINE_MAX_DAYS. */
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
