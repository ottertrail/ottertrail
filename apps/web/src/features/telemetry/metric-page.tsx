import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  type MetricChart,
  metricChartQuery,
  type MetricKind,
  type MetricSeries,
} from "@/lib/metrics-api";

import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChartCard } from "./chart-card";
import { stepText } from "./chart-time";
import { ChoiceFilter } from "./filters";
import {
  formatMetricValue,
  formatNumber,
  formatRate,
  KIND_LABELS,
  unitText,
} from "./metric-format";
import {
  DEFAULT_STAT,
  environmentSearch,
  METRIC_STATS,
  type MetricSearch,
  metricSearchOf,
  type MetricStat,
  rangeSearch,
} from "./search";
import { assignSlots, OTHER_COLOR, SLOTS } from "./split-colors";
import type { ChartLine } from "./time-chart";

/** What each measure is called, in the legend, the tooltip, and the measure picker. */
const MEASURE_LABELS: Record<string, string> = {
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  rate: "Per second",
  sum: "Total",
  p50: "Median (p50)",
  p95: "95th percentile",
  p99: "99th percentile",
};

/** A line's name: the split attribute's value, "(not set)" for points without it, or "Other". */
const valueLabel = (value: string | null, other: boolean) =>
  other ? "Other values" : value === null ? "(not set)" : value === "" ? "(empty)" : value;

/** A split line's key: its value, never its label, so no value can pass for another line. */
const keyOf = (series: MetricSeries) =>
  series.other ? "\u0000other" : `v${JSON.stringify(series.value)}`;

/**
 * The chart's lines for some measures. Without a split, one line per
 * measure (a gauge's average, minimum, and maximum). With one, a line per
 * value of the measure shown, each value in the slot it got first while
 * the page is open (`colors`, assignSlots), found by its key, never its
 * label; "other" in gray.
 */
function linesOf(
  chart: MetricChart,
  measures: readonly string[],
  colors: Map<string, number>,
): ChartLine[] {
  if (chart.split === null) {
    const [series] = chart.series;
    if (series === undefined) return [];
    return measures.map((measure, index) => ({
      key: measure,
      label: MEASURE_LABELS[measure] ?? measure,
      color: SLOTS[index] ?? OTHER_COLOR,
      values: series.values[measure] ?? [],
    }));
  }
  const [measure = "rate"] = measures;
  const slots = assignSlots(
    colors,
    chart.series.filter((series) => !series.other).map(keyOf),
    SLOTS.length,
  );
  return chart.series.map((series) => {
    const key = keyOf(series);
    const slot = slots.get(key);
    return {
      key,
      label: valueLabel(series.value, series.other),
      color: series.other || slot === undefined ? OTHER_COLOR : (SLOTS[slot] ?? OTHER_COLOR),
      values: series.values[measure] ?? [],
    };
  });
}

/** The cards a kind of metric shows, each with its lines and the way its values read. */
function chartCards(chart: MetricChart, stat: MetricStat, colors: Map<string, number>) {
  const step = stepText(chart.stepSeconds);
  const split = chart.split !== null;
  const unit = chart.unit;
  const values = (value: number) => formatMetricValue(value, unit);
  const kind: MetricKind = chart.kind;
  if (kind === "gauge") {
    return [
      {
        title: split ? `${MEASURE_LABELS[stat] ?? stat} by ${chart.split}` : "Value",
        description: split
          ? `Each value's ${stat === "avg" ? "average" : stat === "min" ? "lowest" : "highest"} point per ${step}.`
          : `The average, lowest, and highest point per ${step}.`,
        lines: linesOf(chart, split ? [stat] : METRIC_STATS.gauge, colors),
        format: values,
      },
    ];
  }
  if (kind === "updown") {
    return [
      {
        title: split ? `Total by ${chart.split}` : "Total",
        description: `Each series' last value in each ${step}, added up${split ? " per value" : ""}: what was open, queued, or in use across all of them. A series that sent nothing in a ${step} adds nothing to it.`,
        lines: linesOf(chart, ["sum"], colors),
        format: values,
      },
    ];
  }
  if (kind === "counter") {
    return [
      {
        title: split ? `Per second by ${chart.split}` : "Per second",
        description: `How fast it grew, per second, in each ${step}: a cumulative series' increase between points, spread over the time between them, a drop counting as a restart; a delta series' values over the ${step}. Series are added up.`,
        lines: linesOf(chart, ["rate"], colors),
        format: (value: number) => formatRate(value, unit),
      },
    ];
  }
  return [
    {
      title: split ? `${MEASURE_LABELS[stat] ?? stat} by ${chart.split}` : "Percentiles",
      description: `Worked out from the histogram's buckets per ${step}: within the bucket a percentile falls in, values are taken as spread evenly between its bounds, so a percentile is as close as the buckets are narrow.`,
      lines: linesOf(chart, split ? [stat] : METRIC_STATS.histogram, colors),
      format: values,
      missing: chart.percentiles
        ? undefined
        : "This histogram's points carry no bucket counts, which percentiles are worked out from. Its count still gives the observations per second.",
    },
    {
      title: split ? `Observations per second by ${chart.split}` : "Observations per second",
      description: `How many values the histogram counted, per second, in each ${step}.`,
      lines: linesOf(chart, ["rate"], colors),
      format: (value: number) => `${formatNumber(value)}/s`,
    },
  ];
}

/** One metric over a period: charts of it, optionally split by one of its attributes. */
export function MetricPage({
  projectId,
  name,
  kind,
  range,
  environment = DEFAULT_ENVIRONMENT,
  split,
  stat,
}: {
  projectId: string;
  name: string;
  /** undefined: the address names no kind, and the page says so. */
  kind: MetricKind | undefined;
  range: PageRange;
  environment?: string;
  split: string | undefined;
  stat: MetricStat | undefined;
}) {
  const navigate = useNavigate();
  const chosenKind: MetricKind = kind ?? "gauge";
  const shownStat = stat ?? DEFAULT_STAT[chosenKind];
  // Each split's values keep their colors while the page is open (assignSlots).
  const [colors] = React.useState(() => new Map<string, Map<string, number>>());
  const colorsOf = (key: string | null) => {
    const known = colors.get(key ?? "");
    if (known !== undefined) return known;
    const fresh = new Map<string, number>();
    colors.set(key ?? "", fresh);
    return fresh;
  };
  const chart = useQuery({
    ...metricChartQuery(projectId, range, environment, { name, kind: chosenKind, split }),
    enabled: kind !== undefined,
  });
  const search: MetricSearch = { range, environment, kind: chosenKind, split, stat: shownStat };
  const show = (next: Partial<MetricSearch>) =>
    void navigate({
      to: "/projects/$projectId/metrics/$name",
      params: { projectId, name },
      search: metricSearchOf({ ...search, ...next }),
    });

  if (chart.error instanceof ApiError && chart.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = chart.data;
  const stats = METRIC_STATS[chosenKind];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/projects/$projectId/metrics"
          params={{ projectId }}
          search={{ ...rangeSearch(range), ...environmentSearch(environment) }}
          className="flex items-center gap-1 self-start text-sm text-link hover:underline"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          All metrics
        </Link>
        <h2 className="font-mono text-lg font-medium break-all text-ink">{name}</h2>
        {kind !== undefined && (
          <p className="text-sm text-ink-subtle">
            {KIND_LABELS[kind]}
            {data !== undefined && unitText(data.unit) !== "" && ` · ${unitText(data.unit)}`}
          </p>
        )}
      </div>

      {kind === undefined ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>This address does not say what kind of metric this is</AlertTitle>
          <AlertDescription>Open the metric from the list of metrics.</AlertDescription>
        </Alert>
      ) : (
        <>
          <RangeControls
            range={range}
            environment={environment}
            answered={data}
            onRange={(next) => show({ range: next })}
            onEnvironment={(next) => show({ environment: next })}
          >
            {data !== undefined && (data.keys.length > 0 || split !== undefined) && (
              <ChoiceFilter
                label="Split by"
                anyLabel="No split"
                choices={data.keys.map((key) => ({ value: key, label: `Split by ${key}` }))}
                value={split}
                // Without a split, every measure shows: the one chosen goes.
                onChange={(next) =>
                  show({
                    split: next,
                    stat: next === undefined ? DEFAULT_STAT[chosenKind] : shownStat,
                  })
                }
                className="w-56"
              />
            )}
            {split !== undefined && stats.length > 1 && (
              <Select
                items={stats.map((measure) => ({
                  value: measure,
                  label: MEASURE_LABELS[measure] ?? measure,
                }))}
                value={shownStat}
                onValueChange={(next) => {
                  const chosen = stats.find((measure) => measure === next);
                  if (chosen !== undefined) show({ stat: chosen });
                }}
              >
                <SelectTrigger aria-label="Measure" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stats.map((measure) => (
                    <SelectItem key={measure} value={measure}>
                      {MEASURE_LABELS[measure] ?? measure}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </RangeControls>

          {chart.isError && (
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>
                {data === undefined ? "The metric could not load" : "The metric could not refresh"}
              </AlertTitle>
              <AlertDescription>
                {chart.error.message}
                {data !== undefined && " The charts below are from the last successful load."}
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void chart.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          )}
          {data === undefined ? (
            !chart.isError && (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
                <Skeleton className="h-72 w-full" />
              </div>
            )
          ) : (
            <div
              className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
              data-stale={chart.isPlaceholderData}
              aria-busy={chart.isPlaceholderData}
            >
              {data.series.length === 0 ? (
                <Empty className="border border-dashed p-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchXIcon />
                    </EmptyMedia>
                    <EmptyTitle>No points of this metric in this period</EmptyTitle>
                    <EmptyDescription>
                      Nothing arrived for it
                      {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this
                      period. Metrics are kept {data.retentionDays} days.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  {chartCards(data, shownStat, colorsOf(data.split)).map((card) => (
                    <ChartCard
                      key={card.title}
                      title={card.title}
                      description={card.description}
                      frame={data}
                      subject={data.name}
                      lines={card.lines}
                      formatValue={card.format}
                      missing={"missing" in card ? card.missing : undefined}
                    />
                  ))}
                  <p className="text-sm text-ink-subtle">
                    {formatNumber(data.seriesCount)} series: each combination of service, scope,
                    attributes, and resource attributes is one.
                    {data.split !== null &&
                      data.series.some((series) => series.other) &&
                      " Past eight values, those with the least volume are added up as “Other values”."}
                  </p>
                  {data.seriesCapped && (
                    <p className="text-sm text-ink-subtle">
                      This metric has more than {formatNumber(data.seriesCount)} series in this
                      period: the charts read the {formatNumber(data.seriesCount)} with the most
                      points. Choose a shorter period to read them all.
                    </p>
                  )}
                  {data.percentiles && data.skippedSeries > 0 && (
                    <p className="text-sm text-ink-subtle">
                      {formatNumber(data.skippedSeries)}{" "}
                      {data.skippedSeries === 1 ? "series is" : "series are"} left out of the
                      percentiles, which need one set of bucket bounds: other bounds than the rest,
                      or no bucket counts. The observations per second count{" "}
                      {data.skippedSeries === 1 ? "it" : "them"}.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
