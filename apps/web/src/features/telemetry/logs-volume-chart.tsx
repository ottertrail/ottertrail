import { useQuery } from "@tanstack/react-query";

import { type PageRange } from "@/lib/analytics-api";
import { type LogFilters, logVolumeQuery } from "@/lib/logs-api";

import { formatWhole } from "../analytics/format";
import { stepText } from "./chart-time";
import { BucketTable, ListChartSection, NothingToChart } from "./list-chart";
import { bucketRange, type ListChartFrame, selectHint } from "./list-chart-frame";
import { severityParts } from "./severity-parts";
import { StackedBarChart } from "./stacked-bar-chart";

/**
 * Above the logs list: the records of the period and filters per time
 * bucket, stacked by severity, from its own request, so it loads, fails,
 * and retries without the list. A bar narrows the period to its day.
 */
export function LogsVolumeChart({
  projectId,
  range,
  environment,
  filters,
  onRange,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  filters: LogFilters;
  onRange: (range: PageRange) => void;
}) {
  const query = useQuery(logVolumeQuery(projectId, range, environment, filters));
  const volume = query.data;
  const frame: ListChartFrame | undefined = volume;
  const parts = volume === undefined ? [] : severityParts(volume);
  const title = "Records over time";
  return (
    <ListChartSection
      title={title}
      state={volume !== undefined ? "success" : query.isError ? "error" : "pending"}
      error={query.error}
      onRetry={() => void query.refetch()}
      description={
        volume === undefined
          ? undefined
          : `The records these filters find, per ${stepText(volume.stepSeconds)}, by severity: ${formatWhole(volume.total)} in all. Times in ${volume.timeZone}.`
      }
      table={
        volume !== undefined &&
        volume.total > 0 && (
          <BucketTable
            caption={title}
            frame={volume}
            columns={[
              ...parts.map((part) => ({
                key: part.key,
                label: part.label,
                values: part.values,
                format: formatWhole,
              })),
              {
                key: "total",
                label: "In all",
                values: Array.from({ length: volume.buckets }, (_, index) =>
                  parts.reduce((sum, part) => sum + (part.values[index] ?? 0), 0),
                ),
                format: formatWhole,
              },
            ]}
          />
        )
      }
    >
      {volume !== undefined && frame !== undefined && volume.total === 0 ? (
        <NothingToChart>No records to chart for these filters in this period.</NothingToChart>
      ) : (
        volume !== undefined &&
        frame !== undefined && (
          <div
            className="transition-opacity data-[stale=true]:opacity-60"
            data-stale={query.isPlaceholderData}
          >
            <StackedBarChart
              frame={volume}
              parts={parts}
              label={`Records per ${stepText(volume.stepSeconds)}, by severity`}
              formatValue={formatWhole}
              onSelect={
                bucketRange(frame, 0) === undefined
                  ? undefined
                  : (index) => {
                      const next = bucketRange(frame, index);
                      if (next !== undefined) onRange(next);
                    }
              }
              selectHint={bucketRange(frame, 0) === undefined ? undefined : selectHint(frame)}
            />
          </div>
        )
      )}
    </ListChartSection>
  );
}
