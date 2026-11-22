import { useQuery } from "@tanstack/react-query";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { ReportChart } from "@/components/report-chart";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type AiChart, aiChartQuery, type AiFilters, type AiSplit } from "@/lib/ai-api";
import type { PageRange } from "@/lib/analytics-api";

import { ChartSection } from "../telemetry/chart-card";
import { stepText } from "../telemetry/chart-time";
import { durationFormat, formatNumber } from "../telemetry/metric-format";
import { assignSlots, OTHER_COLOR, SLOTS } from "../telemetry/split-colors";
import type { ChartLine } from "../telemetry/time-chart";
import { featureLabel, formatUsd, modelLabel } from "./format";

/** What the chart draws, one at a time: one measure, one y-axis. */
const MEASURES = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "calls", label: "Calls" },
  { value: "p95", label: "95th percentile" },
] as const;
type Measure = (typeof MEASURES)[number]["value"];

const SPLITS = [
  { value: "model", label: "By model" },
  { value: "feature", label: "By feature" },
] as const;

type Line = AiChart["series"][number];

/** A line's key for its color: its value, never its label, so no value passes for another. */
const keyOf = (line: Line) => (line.other ? "\u0000other" : `v${JSON.stringify(line.key)}`);

/** Adds lines' values bucket by bucket (cost, tokens, calls: they sum). */
const sumOf = (lines: Line[], pick: (line: Line) => number[]): number[] =>
  lines.reduce<number[]>(
    (total, line) => pick(line).map((value, index) => (total[index] ?? 0) + value),
    [],
  );

/**
 * The chart's lines for a measure: the lines the API split into, the first
 * eight in the slot each value got first while the page is open
 * (assignSlots), so a color stays with its model or feature; past eight,
 * the rest fold into Other, in gray. A 95th percentile cannot be added up,
 * so Other draws one only when it is the API's own Other line alone.
 */
function linesOf(chart: AiChart, measure: Measure, colors: Map<string, number>): ChartLine[] {
  const named = chart.series.filter((line) => !line.other);
  const shown = named.slice(0, SLOTS.length);
  const rest = [...named.slice(SLOTS.length), ...chart.series.filter((line) => line.other)];
  const slots = assignSlots(colors, shown.map(keyOf), SLOTS.length);
  const label = (line: Line) =>
    chart.split === "model" ? modelLabel(line.key) : featureLabel(line.key);
  const valuesOf = (line: Line): (number | null)[] =>
    measure === "cost"
      ? line.costUsd
      : measure === "tokens"
        ? line.tokens
        : measure === "calls"
          ? line.calls
          : line.p95Ms.map((ms) => (ms === null ? null : ms * 1000));
  const lines: ChartLine[] = shown.map((line) => {
    const slot = slots.get(keyOf(line));
    return {
      key: keyOf(line),
      label: label(line),
      color: slot === undefined ? OTHER_COLOR : (SLOTS[slot] ?? OTHER_COLOR),
      values: valuesOf(line),
    };
  });
  const [only] = rest;
  if (rest.length === 0 || only === undefined) return lines;
  const otherLabel = chart.split === "model" ? "Other models" : "Other features";
  if (measure === "p95") {
    return rest.length === 1
      ? [
          ...lines,
          { key: "\u0000other", label: otherLabel, color: OTHER_COLOR, values: valuesOf(only) },
        ]
      : lines;
  }
  const pick = (line: Line) =>
    measure === "cost" ? line.costUsd : measure === "tokens" ? line.tokens : line.calls;
  return [
    ...lines,
    { key: "\u0000other", label: otherLabel, color: OTHER_COLOR, values: sumOf(rest, pick) },
  ];
}

/** A toggle beside the chart's title: buttons with aria-pressed, one always chosen. */
function Toggle<T extends string>({
  label,
  items,
  chosen,
  onChoose,
}: {
  label: string;
  items: readonly { value: T; label: string }[];
  chosen: T;
  onChoose: (value: T) => void;
}) {
  return (
    <ToggleGroup
      value={[chosen]}
      onValueChange={(next: string[]) => {
        const found = items.find((item) => item.value === next[0]);
        if (found !== undefined) onChoose(found.value);
      }}
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {items.map((item) => (
        <ToggleGroupItem key={item.value} value={item.value}>
          {item.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The calls over the period, one measure at a time (estimated cost,
 * tokens, calls, or the 95th percentile), split by model or feature. It
 * loads, fails, and retries on its own, so a failed chart never holds back
 * the tables under it.
 */
export function AiTrend({
  projectId,
  range,
  environment,
  filters,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  filters: AiFilters;
}) {
  const [measure, setMeasure] = React.useState<Measure>("cost");
  const [split, setSplit] = React.useState<AiSplit>("model");
  // Each split keeps its own colors: a model and a feature may share a name.
  const [colors] = React.useState(() => ({
    model: new Map<string, number>(),
    feature: new Map<string, number>(),
  }));
  const chart = useQuery(aiChartQuery(projectId, range, environment, filters, split));
  const { data } = chart;

  const failure = chart.isError && (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {data === undefined ? "The chart could not load" : "The chart could not refresh"}
      </AlertTitle>
      <AlertDescription>
        {chart.error.message}
        {data !== undefined && " The chart below is from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={() => void chart.refetch()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
  if (data === undefined) {
    return (
      <ReportChart title="Estimated cost (USD)" headingLevel={2}>
        {failure || (
          <Skeleton
            className="h-[180px] w-full"
            aria-busy="true"
            aria-label="Loading the chart of AI calls"
          />
        )}
      </ReportChart>
    );
  }

  const step = stepText(data.stepSeconds);
  const by = data.split === "model" ? "by model" : "by feature";
  const lines = linesOf(data, measure, colors[data.split]);
  const duration = durationFormat(data.total.p95Ms.map((ms) => (ms === null ? null : ms * 1000)));
  const views: Record<
    Measure,
    { title: string; description: string; format: (value: number) => string }
  > = {
    cost: {
      title: "Estimated cost (USD)",
      description: `Estimated cost per ${step}, ${by}.`,
      format: formatUsd,
    },
    tokens: {
      title: "Tokens",
      description: `Input and output tokens per ${step}, ${by}.`,
      format: formatNumber,
    },
    calls: { title: "Calls", description: `Calls per ${step}, ${by}.`, format: formatNumber },
    p95: {
      title: `95th percentile (${duration.unit})`,
      description: `The 95th percentile of call durations per ${step}, ${by}. A gap means no call.`,
      format: duration.format,
    },
  };
  const view = views[measure];
  const calls = data.total.calls.reduce((total, value) => total + value, 0);
  return (
    <div className="flex flex-col gap-3">
      {failure}
      <div
        className="transition-opacity data-[stale=true]:opacity-60"
        data-stale={chart.isPlaceholderData}
        aria-busy={chart.isPlaceholderData}
      >
        <ChartSection
          headingLevel={2}
          title={view.title}
          description={view.description}
          frame={{
            start: data.start,
            starts: data.bucketStarts,
            stepSeconds: data.stepSeconds,
            buckets: data.buckets,
            timeZone: data.timeZone,
          }}
          subject="AI calls"
          lines={lines}
          formatValue={view.format}
          missing={calls === 0 ? "No AI call in this period." : undefined}
          actions={
            <>
              <Toggle
                label="Which figure to chart"
                items={MEASURES}
                chosen={measure}
                onChoose={setMeasure}
              />
              <Toggle label="Split the chart" items={SPLITS} chosen={split} onChoose={setSplit} />
            </>
          }
        />
      </div>
    </div>
  );
}
