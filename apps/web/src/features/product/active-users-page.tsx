import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, UserRoundCheckIcon } from "lucide-react";
import * as React from "react";

import { ReportChart } from "@/components/report-chart";
import { type Stat, StatStrip } from "@/components/stat-strip";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAccess } from "@/lib/access";
import {
  type ActivePoint,
  type ActiveSummary,
  type ActiveUsers,
  activeUsersQuery,
} from "@/lib/active-users-api";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";

import { DayChart } from "../analytics/day-chart";
import {
  formatDay,
  formatDayRange,
  formatPercent,
  formatRatio,
  formatWhole,
  pointsChange,
  relativeChange,
} from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { MIN_LOADS_FOR_CHANGE } from "../overview/format";
import { NoSuchProject } from "../projects/no-such-project";
import { StackedBarChart } from "../telemetry/stacked-bar-chart";
import { comparedWith } from "./format";
import { NoSignedInUsers } from "./no-signed-in-users";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { type ProductSearch, productSearchOf } from "./search";

const MEASURES = [
  { value: "dau", label: "DAU", title: "Daily active users" },
  { value: "wau", label: "WAU", title: "Weekly active users" },
  { value: "mau", label: "MAU", title: "Monthly active users" },
] as const;
type Measure = (typeof MEASURES)[number]["value"];
const isMeasure = (value: unknown): value is Measure =>
  MEASURES.some((item) => item.value === value);

/** Lifecycle parts from the baseline up; chart-1 is the active users' line. */
const LIFECYCLE = [
  { key: "returning", label: "Returning", color: "var(--chart-7)" },
  { key: "resurrected", label: "Resurrected", color: "var(--chart-2)" },
  { key: "new", label: "New", color: "var(--chart-3)" },
] as const;

const DAY_SECONDS = 86_400;

/** A count's change from the period before, as the funnel shows one. */
function countChange(current: number, previous: number, shown = formatWhole): Partial<Stat> {
  return {
    change: relativeChange(current, previous),
    before: shown(previous),
    counts: { current, previous },
  };
}

function summaryStats(summary: ActiveSummary, previous: ActiveSummary): Stat[] {
  // Every change rests on the users active in each period, so a handful never shows a big swing.
  const counts = { current: summary.users, previous: previous.users };
  return [
    {
      label: "Active users",
      value: formatWhole(summary.users),
      ...countChange(summary.users, previous.users),
    },
    {
      label: "Average DAU",
      value: formatRatio(summary.averageDaily),
      ...countChange(summary.averageDaily, previous.averageDaily, formatRatio),
      counts,
    },
    {
      label: "WAU, last day",
      value: formatWhole(summary.weekly),
      ...countChange(summary.weekly, previous.weekly),
      counts,
    },
    {
      label: "MAU, last day",
      value: formatWhole(summary.monthly),
      ...countChange(summary.monthly, previous.monthly),
      counts,
    },
    {
      label: "Stickiness",
      value: formatPercent(summary.stickiness),
      // A share changes in percentage points.
      change: pointsChange(summary.stickiness, previous.stickiness),
      before: formatPercent(previous.stickiness),
      counts,
    },
  ];
}

function NumberTable({
  caption,
  week,
  columns,
  points,
}: {
  caption: string;
  week: boolean;
  columns: { label: string; value: (point: ActivePoint) => string }[];
  points: ActivePoint[];
}) {
  return (
    <table className="w-full max-w-2xl text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            {week ? "Week" : "Day"}
          </th>
          {columns.map((column) => (
            <th key={column.label} scope="col" className="pb-2 text-right font-normal">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.day} className="border-t border-hairline">
            <th scope="row" className="py-1.5 text-left font-normal text-ink">
              {week ? `Week of ${formatDay(point.day)}` : formatDay(point.day, { weekday: true })}
            </th>
            {columns.map((column) => (
              <td key={column.label} className="py-1.5 text-right text-ink tabular-nums">
                {column.value(point)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TooShort() {
  return (
    <p className="py-10 text-center text-sm text-ink-subtle">
      A trend needs at least two days. Choose a longer period to see one.
    </p>
  );
}

function ActiveChart({ data }: { data: ActiveUsers }) {
  const [measure, setMeasure] = React.useState<Measure>("dau");
  const week = data.unit === "week";
  const chosen = MEASURES.find((item) => item.value === measure) ?? MEASURES[0];
  const dau = week ? formatRatio : formatWhole;
  const pointLabel = (day: string) =>
    week ? `Week of ${formatDay(day)}` : formatDay(day, { weekday: true });
  const valueOf = (point: ActivePoint) => point[measure];
  const what =
    measure === "dau"
      ? week
        ? "Users active each day, averaged over the week."
        : "Users active that day."
      : `Users active in the ${measure === "wau" ? 7 : 28} days ending that day${week ? ", the week's last day in the period" : ""}.`;
  return (
    <ReportChart
      title="Active users"
      description={what}
      actions={
        <ToggleGroup
          value={[measure]}
          onValueChange={(value) => {
            const [next] = value;
            if (isMeasure(next)) setMeasure(next);
          }}
          aria-label="Which count to chart"
          variant="outline"
          size="sm"
          spacing={0}
        >
          {MEASURES.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} title={item.title}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
      table={
        <NumberTable
          caption="Active users and stickiness"
          week={week}
          points={data.points}
          columns={[
            { label: week ? "Average DAU" : "DAU", value: (point) => dau(point.dau) },
            { label: "WAU", value: (point) => formatWhole(point.wau) },
            { label: "MAU", value: (point) => formatWhole(point.mau) },
            { label: "Stickiness", value: (point) => formatPercent(point.stickiness) },
          ]}
        />
      }
    >
      {data.points.length < 2 ? (
        <TooShort />
      ) : (
        <DayChart
          points={data.points.map((point) => ({ day: point.day, value: valueOf(point) }))}
          label={`${chosen.title} per ${week ? "week" : "day"}`}
          pointLabel={pointLabel}
          tooltipRows={(index) => {
            const point = data.points[index];
            if (point === undefined) return [];
            return [
              {
                label: chosen.label,
                value: measure === "dau" ? dau(point.dau) : formatWhole(valueOf(point)),
                plotted: true,
              },
              { label: "stickiness", value: formatPercent(point.stickiness), plotted: false },
            ];
          }}
          plotHeight={180}
        />
      )}
    </ReportChart>
  );
}

function LifecycleChart({ data }: { data: ActiveUsers }) {
  const week = data.unit === "week";
  const unit = week ? "week" : "day";
  const parts = LIFECYCLE.map((part) => ({
    ...part,
    values: data.points.map((point) => point[part.key]),
  }));
  return (
    <ReportChart
      title="New, returning, and resurrected"
      description={`Each ${unit}'s active users: first seen that ${unit}, also active in the 28 days before it, or back after a longer gap.`}
      table={
        <NumberTable
          caption="New, returning, and resurrected users"
          week={week}
          points={data.points}
          columns={[
            { label: "New", value: (point) => formatWhole(point.new) },
            { label: "Returning", value: (point) => formatWhole(point.returning) },
            { label: "Resurrected", value: (point) => formatWhole(point.resurrected) },
            {
              label: "Active",
              value: (point) => formatWhole(point.new + point.returning + point.resurrected),
            },
          ]}
        />
      }
    >
      {data.points.length < 2 ? (
        <TooShort />
      ) : (
        <StackedBarChart
          frame={{
            bucketStarts: data.points.map((point) => point.start),
            stepSeconds: (week ? 7 : 1) * DAY_SECONDS,
            timeZone: data.timeZone,
            firstDay: data.firstDay,
            lastDay: data.lastDay,
          }}
          parts={parts}
          label={`Active users per ${unit}, by lifecycle`}
          formatValue={formatWhole}
          bucketName={(index) => {
            const day = data.points[index]?.day ?? data.firstDay;
            return week ? `Week of ${formatDay(day)}` : formatDay(day, { weekday: true });
          }}
          plotHeight={160}
        />
      )}
    </ReportChart>
  );
}

/** The definitions the report counts by (docs/product-analytics.md, "Active users"). */
function ActiveNotes({ timeZone }: { timeZone: string }) {
  return (
    <details className="group border-t pt-5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 text-ink-subtle transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        How active users count
      </summary>
      <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1 pl-5 text-xs text-pretty text-ink-subtle">
        <li>
          A user is active on a day when they sent any event with their user ID, from the browser or
          your server, except time on page and Web Vitals, as in Retention.
        </li>
        <li>
          DAU counts the users active that day, WAU those active in the 7 days ending that day, and
          MAU those active in the 28 days ending that day. Stickiness is DAU ÷ MAU, averaged over
          the days.
        </li>
        <li>
          New users were first seen that day, in this environment, over all the time the project
          keeps. Returning users were also active in the 28 days before. Resurrected users were seen
          before, but not in those 28 days.
        </li>
        <li>
          Periods over 60 days show weeks from Monday: the average DAU of the week, WAU and MAU on
          its last day, and each user once in the week's lifecycle.
        </li>
        <li>
          Days start at midnight in the timezone set in Settings ({timeZone}). Events can arrive up
          to a day late, so the last day can still increase.
        </li>
      </ul>
    </details>
  );
}

function NoneActive({ data, environment }: { data: ActiveUsers; environment: string }) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <UserRoundCheckIcon />
        </EmptyMedia>
        <EmptyTitle>No signed-in users were active in this period</EmptyTitle>
        <EmptyDescription>
          No signed-in user sent an event{where} from {formatDayRange(data.firstDay, data.lastDay)}.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function ActiveUsersPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const access = useAccess();
  const query = useQuery(activeUsersQuery(projectId, range, environment));
  const search: ProductSearch = { range, environment };
  const show = (next: Partial<ProductSearch>) =>
    void navigate({
      to: "/projects/$projectId/product/active-users",
      params: { projectId },
      search: productSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        <p className="text-xs text-pretty text-ink-subtle">
          Counts signed-in users only.
          {access.canUse("web_analytics") && (
            <>
              {" "}
              For all visitors, see{" "}
              <Link
                to="/projects/$projectId/web-analytics"
                params={{ projectId }}
                search={productSearchOf(search)}
                className="text-ink underline underline-offset-2"
              >
                Web analytics
              </Link>
              .
            </>
          )}
        </p>
        {query.isError && (
          <LoadFailed
            what="The active users report"
            message={query.error.message}
            hasData={data !== undefined}
            onRetry={() => void query.refetch()}
          />
        )}
        {data === undefined ? (
          !query.isError && <LoadingRows rows={6} />
        ) : (
          <Refreshing stale={query.isPlaceholderData}>
            {data.summary.users > 0 ? (
              <div className="flex flex-col gap-6">
                <section aria-label="Summary" className="flex flex-col gap-3">
                  <StatStrip
                    label="Summary"
                    stats={summaryStats(data.summary, data.previous)}
                    minCount={MIN_LOADS_FOR_CHANGE}
                  />
                  <p className="text-xs text-ink-subtle">
                    {comparedWith(data.previous, data.timeZone)}
                  </p>
                </section>
                <ActiveChart data={data} />
                <LifecycleChart data={data} />
                <ActiveNotes timeZone={data.timeZone} />
              </div>
            ) : data.identifiesUsers ? (
              <NoneActive data={data} environment={environment} />
            ) : (
              <NoSignedInUsers lead="Active users counts signed-in users over days and weeks." />
            )}
          </Refreshing>
        )}
      </div>
    </div>
  );
}
