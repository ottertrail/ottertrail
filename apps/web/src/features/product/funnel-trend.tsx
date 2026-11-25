import { useQuery } from "@tanstack/react-query";

import { ReportChart } from "@/components/report-chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { PageRange } from "@/lib/analytics-api";
import {
  type FunnelCount,
  type FunnelStep,
  type FunnelTrend,
  type FunnelTrendPoint,
  type FunnelWindow,
  funnelTrendQuery,
} from "@/lib/product-api";

import { DayChart } from "../analytics/day-chart";
import { formatDay, formatWhole } from "../analytics/format";
import { formatShare } from "./format";
import { LoadFailed, Refreshing } from "./report-state";

const DAY_MS = 86_400_000;
const dayAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
/** The Monday on or before a day. */
const mondayOf = (day: string) => {
  const ms = msOf(day);
  return dayAt(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
};

/**
 * Every day (or week, from Monday) of the period, in order, with the
 * answer's point where there is one: a day nobody did step 1 has none.
 */
function slotsOf(trend: FunnelTrend): { day: string; point: FunnelTrendPoint | undefined }[] {
  const byDay = new Map(trend.points.map((point) => [point.day, point]));
  const week = trend.unit === "week";
  const first = msOf(week ? mondayOf(trend.firstDay) : trend.firstDay);
  const last = msOf(trend.lastDay);
  const slots = [];
  for (let ms = first; ms <= last; ms += (week ? 7 : 1) * DAY_MS) {
    const day = dayAt(ms);
    slots.push({ day, point: byDay.get(day) });
  }
  return slots;
}

/**
 * The overall conversion per day of each person's step 1, or per week for
 * a period longer than 60 days. Left out for a single day.
 */
export function FunnelTrendSection({
  projectId,
  range,
  environment,
  steps,
  count,
  window,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}) {
  const oneDay = "period" in range ? range.period === "today" : range.from === range.to;
  const trend = useQuery({
    ...funnelTrendQuery(projectId, range, environment, steps, count, window),
    enabled: !oneDay,
  });
  const data = oneDay ? undefined : trend.data;
  if (oneDay) return null;
  const who = count === "users" ? "users" : "visitors";
  const last = steps.length;
  const week = data?.unit === "week";
  const unitWord = week ? "Week" : "Day";
  const pointLabel = (day: string) =>
    week ? `Week of ${formatDay(day)}` : formatDay(day, { weekday: true });
  const slots = data === undefined ? [] : slotsOf(data);

  const table =
    data === undefined ? undefined : (
      <table className="w-full max-w-xl text-sm">
        <caption className="sr-only">Conversion per {unitWord.toLowerCase()}</caption>
        <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
          <tr className="text-xs text-ink-subtle">
            <th scope="col" className="pb-2 text-left font-normal">
              {unitWord}
            </th>
            <th scope="col" className="pb-2 text-right font-normal">
              At step 1
            </th>
            <th scope="col" className="pb-2 text-right font-normal">
              At step {last}
            </th>
            <th scope="col" className="pb-2 text-right font-normal">
              Conversion
            </th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point) => (
            <tr key={point.day} className="border-t border-hairline">
              <th scope="row" className="py-1.5 text-left font-normal text-ink">
                {pointLabel(point.day)}
              </th>
              <td className="py-1.5 text-right text-ink tabular-nums">
                {formatWhole(point.started)}
              </td>
              <td className="py-1.5 text-right text-ink tabular-nums">
                {formatWhole(point.converted)}
              </td>
              <td className="py-1.5 text-right text-ink tabular-nums">
                {formatShare(point.converted, point.started)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <ReportChart
      title="Conversion over time"
      description={
        data === undefined
          ? undefined
          : `By the ${week ? "week" : "day"} each of the ${who} did step 1.`
      }
      table={table}
    >
      {trend.isError && (
        <LoadFailed
          what="Conversion over time"
          message={trend.error.message}
          hasData={data !== undefined}
          onRetry={() => void trend.refetch()}
        />
      )}
      {data === undefined ? (
        !trend.isError && (
          <div aria-busy="true" aria-label="Loading conversion over time">
            <Skeleton className="h-[180px] w-full" />
          </div>
        )
      ) : data.points.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-subtle">
          No {who} did step 1 in this period.
        </p>
      ) : (
        <Refreshing stale={trend.isPlaceholderData}>
          <DayChart
            points={slots.map(({ day, point }) => ({
              day,
              value:
                point === undefined || point.started === 0
                  ? null
                  : (point.converted / point.started) * 100,
            }))}
            label={`Conversion per ${week ? "week" : "day"}`}
            formatValue={(value) => `${value}%`}
            pointLabel={pointLabel}
            tooltipRows={(index) => {
              const point = slots[index]?.point;
              if (point === undefined) {
                return [{ label: `${who} at step 1`, value: "No", plotted: false }];
              }
              return [
                {
                  label: "conversion",
                  value: formatShare(point.converted, point.started),
                  plotted: true,
                },
                { label: `at step 1`, value: formatWhole(point.started), plotted: false },
                { label: `at step ${last}`, value: formatWhole(point.converted), plotted: false },
              ];
            }}
            plotHeight={140}
          />
        </Refreshing>
      )}
    </ReportChart>
  );
}
