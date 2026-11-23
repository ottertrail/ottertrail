import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type PageRange } from "@/lib/analytics-api";
import { traceChartQuery, type TraceFilters } from "@/lib/traces-api";

import { formatWhole } from "../analytics/format";
import { stepText } from "./chart-time";
import { formatDuration } from "./format";
import { BucketTable, ListChartSection, NothingToChart } from "./list-chart";
import { bucketRange, selectHint } from "./list-chart-frame";
import { StackedBarChart } from "./stacked-bar-chart";
import { TimeChart } from "./time-chart";

type Shown = "traces" | "duration";

/** Load independently of the list. Keep errors on the baseline in the critical color; duration uses chart-1. */
export function TracesChart({
  projectId,
  range,
  environment,
  filters,
  onRange,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  filters: TraceFilters;
  onRange: (range: PageRange) => void;
}) {
  const query = useQuery(traceChartQuery(projectId, range, environment, filters));
  const [shown, setShown] = React.useState<Shown>("traces");
  const chart = query.data;
  const title = shown === "traces" ? "Traces over time" : "Duration over time";
  const step = chart === undefined ? "" : stepText(chart.stepSeconds);
  const without =
    chart === undefined
      ? []
      : chart.traces.map((count, index) => count - (chart.failed[index] ?? 0));
  return (
    <ListChartSection
      title={title}
      state={chart !== undefined ? "success" : query.isError ? "error" : "pending"}
      error={query.error}
      onRetry={() => void query.refetch()}
      actions={
        <ToggleGroup
          value={[shown]}
          onValueChange={(value) => {
            const [next] = value;
            if (next === "traces" || next === "duration") setShown(next);
          }}
          aria-label="What the chart shows"
          variant="outline"
          size="sm"
          spacing={0}
        >
          <ToggleGroupItem value="traces">Traces</ToggleGroupItem>
          <ToggleGroupItem value="duration">Duration</ToggleGroupItem>
        </ToggleGroup>
      }
      description={
        chart === undefined
          ? undefined
          : shown === "traces"
            ? `The traces these filters find, per ${step}, with errors and without: ${formatWhole(chart.total.traces)} in all, ${formatWhole(chart.total.failed)} with errors. Times in ${chart.timeZone}.${chart.failedCapped ? " Errors counted among the latest 10,000 failed spans." : ""}`
            : `The 95th-percentile duration of the traces these filters find, per ${step}: 95% took this long or less. Times in ${chart.timeZone}.`
      }
      table={
        chart !== undefined &&
        chart.total.traces > 0 && (
          <BucketTable
            caption={title}
            frame={chart}
            columns={[
              { key: "traces", label: "Traces", values: chart.traces, format: formatWhole },
              { key: "failed", label: "With errors", values: chart.failed, format: formatWhole },
              {
                key: "p95",
                label: "95th percentile",
                values: chart.p95Us,
                format: formatDuration,
              },
            ]}
          />
        )
      }
    >
      {chart !== undefined && chart.total.traces === 0 ? (
        <NothingToChart>No traces to chart for these filters in this period.</NothingToChart>
      ) : (
        chart !== undefined && (
          <div
            className="transition-opacity data-[stale=true]:opacity-60"
            data-stale={query.isPlaceholderData}
          >
            {shown === "traces" ? (
              <StackedBarChart
                frame={chart}
                parts={[
                  {
                    key: "failed",
                    label: "With errors",
                    color: "var(--status-critical)",
                    values: chart.failed,
                  },
                  {
                    key: "ok",
                    label: "Without errors",
                    color: "var(--chart-neutral)",
                    values: without,
                  },
                ]}
                label={`Traces per ${step}, with errors and without`}
                formatValue={formatWhole}
                onSelect={
                  bucketRange(chart, 0) === undefined
                    ? undefined
                    : (index) => {
                        const next = bucketRange(chart, index);
                        if (next !== undefined) onRange(next);
                      }
                }
                selectHint={bucketRange(chart, 0) === undefined ? undefined : selectHint(chart)}
              />
            ) : (
              <TimeChart
                start={chart.start}
                stepSeconds={chart.stepSeconds}
                buckets={chart.buckets}
                timeZone={chart.timeZone}
                lines={[
                  {
                    key: "p95",
                    label: "95th percentile",
                    color: "var(--chart-1)",
                    values: chart.p95Us,
                  },
                ]}
                label={`95th-percentile duration per ${step}`}
                formatValue={formatDuration}
                plotHeight={140}
                starts={chart.bucketStarts}
              />
            )}
          </div>
        )
      )}
    </ListChartSection>
  );
}
