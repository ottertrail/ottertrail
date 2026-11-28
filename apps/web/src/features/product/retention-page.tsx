import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, UserRoundCheckIcon } from "lucide-react";
import * as React from "react";

import { Missing } from "@/components/missing";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DEFAULT_ENVIRONMENT, type PageRange, PERIODS, type Period } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type Cohort, type Retention, retentionQuery, type WeekAverage } from "@/lib/product-api";

import { formatDay, formatDayRange, formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatShare } from "./format";
import { NoSignedInUsers } from "./no-signed-in-users";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { type ProductSearch, productSearchOf } from "./search";

/**
 * The period picks the cohorts, one a week, so a period under 4 weeks
 * would show one or two rows. Those presets are not offered here, nor
 * Month to date, which is shorter for most of the month.
 */
const SHORT: readonly Period[] = ["today", "yesterday", "7d", "mtd"];
const RETENTION_PERIODS = PERIODS.filter((item) => !SHORT.includes(item.value));
const RETENTION_DEFAULT: Period = "90d";
const LONGEST: Period = "12m";

/** The range Retention shows: a preset it does not offer opens its default. */
const retentionRange = (range: PageRange): PageRange =>
  "period" in range && !RETENTION_PERIODS.some((item) => item.value === range.period)
    ? { period: RETENTION_DEFAULT }
    : range;

/**
 * Lower bounds, in whole percent, of shades 1 to 7: fixed, so a share looks
 * the same in every project, and finer where retention usually falls.
 */
const SHADE_FROM = [1, 5, 10, 15, 20, 30, 45] as const;
const SHADES = [
  "bg-seq-1 text-on-seq-1",
  "bg-seq-2 text-on-seq-2",
  "bg-seq-3 text-on-seq-3",
  "bg-seq-4 text-on-seq-4",
  "bg-seq-5 text-on-seq-5",
  "bg-seq-6 text-on-seq-6",
  "bg-seq-7 text-on-seq-7",
] as const;
const SWATCHES = [
  "bg-seq-1",
  "bg-seq-2",
  "bg-seq-3",
  "bg-seq-4",
  "bg-seq-5",
  "bg-seq-6",
  "bg-seq-7",
] as const;

/** Shade by the rounded percent the cell shows, so the two always agree. */
function shadeOf(part: number, whole: number): string {
  if (whole === 0 || part <= 0) return "text-ink";
  const percent = Math.max(1, Math.round((part / whole) * 100));
  return SHADES[SHADE_FROM.findLastIndex((from) => percent >= from)] ?? "text-ink";
}

const addWeeks = (monday: string, weeks: number) =>
  new Date(Date.parse(`${monday}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);

const endsThisWeek = (cohort: Cohort, currentWeek: string) =>
  cohort.retained.length > 0 && addWeeks(cohort.week, cohort.retained.length - 1) === currentWeek;

function Legend() {
  const id = React.useId();
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 text-xs text-ink-subtle">
      <span id={id}>Share of the cohort:</span>
      <ul className="flex flex-wrap items-start gap-0.5" aria-labelledby={id}>
        <li className="flex w-9 flex-col gap-1">
          <span aria-hidden="true" className="h-3 rounded-sm ring-1 ring-hairline ring-inset" />
          0%
        </li>
        {SWATCHES.map((swatch, index) => {
          const from = SHADE_FROM[index] ?? 0;
          const next = SHADE_FROM[index + 1];
          return (
            <li key={swatch} className="flex w-9 flex-col gap-1">
              <span aria-hidden="true" className={`h-3 rounded-sm ${swatch}`} />
              <span aria-hidden="true">{from}%</span>
              <span className="sr-only">
                {next === undefined ? `${from}% or more` : `${from} to ${next - 1}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "24 Aug" on a phone, "24 Aug 2026" from 40rem. */
function WeekName({ week }: { week: string }) {
  return (
    <>
      <span className="sm:hidden">{formatDay(week)}</span>
      <span className="max-sm:hidden">{formatDayRange(week, week)}</span>
    </>
  );
}

const WEEK_COLUMN = "min-w-12 sm:min-w-14";
const CELL = "rounded-sm px-1.5 py-1 text-center tabular-nums sm:px-2";
/** Week 0 is everyone, always 100%: no shade, so it does not outshine the weeks after. */
const WEEK_ZERO = `${CELL} text-ink-subtle`;

function AverageRow({ average, users }: { average: WeekAverage[]; users: number }) {
  return (
    // A transparent border, outside each cell's fill, sets the average apart from the cohorts.
    <tr
      data-average="true"
      className="font-medium [&>*]:border-b-8 [&>*]:border-transparent [&>*]:bg-clip-padding"
    >
      <th scope="row" className={`py-1 pr-3 text-left whitespace-nowrap text-ink ${PINNED}`}>
        Average
      </th>
      <td className="py-1 pr-3 text-right text-ink tabular-nums">{formatWhole(users)}</td>
      {average.map((week, offset) => {
        if (week.users === 0) {
          return (
            <td key={offset} className={`${CELL} text-ink-subtle`}>
              <Missing label="No cohort has finished this week" />
            </td>
          );
        }
        return (
          <td
            key={offset}
            title={`${formatWhole(week.retained)} of ${formatWhole(week.users)} users, in the cohorts that finished this week`}
            className={offset === 0 ? WEEK_ZERO : `${CELL} ${shadeOf(week.retained, week.users)}`}
          >
            {formatShare(week.retained, week.users)}
          </td>
        );
      })}
    </tr>
  );
}

function CohortTable({ retention }: { retention: Retention }) {
  const weeks = Math.max(0, ...retention.cohorts.map((cohort) => cohort.retained.length));
  const notOver = retention.cohorts.some((cohort) => endsThisWeek(cohort, retention.currentWeek));
  const users = retention.cohorts.reduce((sum, cohort) => sum + cohort.users, 0);
  return (
    <section aria-labelledby="weekly-retention" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="weekly-retention" className="text-sm font-medium text-ink">
          Weekly retention
        </h2>
        <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
          Each row represents signed-in users first seen in that week. Each column shows the share
          who returned that many weeks later.
        </p>
      </div>
      <ScrollHint>
        <div data-slot="table-container" className="relative overflow-x-auto">
          <table className="w-full border-separate border-spacing-0.5 text-sm">
            <caption className="sr-only">
              Weekly retention of signed-in users, by the week of their first event
            </caption>
            <thead>
              <tr className="text-xs text-ink-subtle">
                <th
                  scope="col"
                  className={`pr-3 pb-2 text-left font-normal whitespace-nowrap ${PINNED}`}
                >
                  First week
                </th>
                <th scope="col" className="pr-3 pb-2 text-right font-normal">
                  Users
                </th>
                {Array.from({ length: weeks }, (_, week) => (
                  <th
                    key={week}
                    scope="col"
                    className={`${WEEK_COLUMN} pb-2 text-center font-normal whitespace-nowrap`}
                  >
                    Week {week}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <AverageRow average={retention.average} users={users} />
              {retention.cohorts.map((cohort) => {
                const current = endsThisWeek(cohort, retention.currentWeek);
                return (
                  <tr key={cohort.week}>
                    <th
                      scope="row"
                      className={`py-1 pr-3 text-left font-normal whitespace-nowrap text-ink ${PINNED}`}
                    >
                      <WeekName week={cohort.week} />
                    </th>
                    <td className="py-1 pr-3 text-right text-ink tabular-nums">
                      {formatWhole(cohort.users)}
                    </td>
                    {Array.from({ length: weeks }, (_, week) => {
                      const retained = cohort.retained[week];
                      if (retained === undefined) {
                        return (
                          <td key={week}>
                            <span className="sr-only">Not begun</span>
                          </td>
                        );
                      }
                      const last = current && week === cohort.retained.length - 1;
                      const shade =
                        week === 0 ? WEEK_ZERO : `${CELL} ${shadeOf(retained, cohort.users)}`;
                      return (
                        <td
                          key={week}
                          title={`${formatWhole(retained)} of ${formatWhole(cohort.users)} users${last ? " so far: this week is not over" : ""}`}
                          className={`${shade} ${last ? "italic" : ""}`}
                          data-current={last ? "true" : undefined}
                        >
                          {formatShare(retained, cohort.users)}
                          {last && (
                            <>
                              <span aria-hidden="true">*</span>
                              <span className="sr-only"> (this week is not over)</span>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ScrollHint>
      <Legend />
      {notOver && (
        <p className="text-xs text-ink-subtle">
          <span className="italic">*</span> This week is not over. Its share can still increase, and
          the average leaves it out.
        </p>
      )}
    </section>
  );
}

/** The definitions the report counts by (docs/product-analytics.md, "Retention"). */
function RetentionNotes({ timeZone }: { timeZone: string }) {
  return (
    <details className="group border-t pt-5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 text-ink-subtle transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        How retention counts
      </summary>
      <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1 pl-5 text-xs text-pretty text-ink-subtle">
        <li>
          Only signed-in users count, identified by your site's user ID. Visitor IDs change daily.
          Someone who returns next week counts as a new visitor.
        </li>
        <li>
          A cohort contains users whose first event in this environment occurred that week, across
          the project's full retention period. The report shows every cohort whose first week
          overlaps the selected period. Each cohort continues through the current week.
        </li>
        <li>
          A user returned in week <em>n</em> if they triggered any event except time on page or Web
          Vitals in the <em>n</em>-th week after their first week. Week 0 includes everyone: 100%.
        </li>
        <li>
          The average adds up the cohorts that finished each week, so a larger cohort counts more. A
          week that is not over is left out.
        </li>
        <li>
          Weeks start on Monday in the timezone set in Settings ({timeZone}). Events can arrive up
          to a day late. A week's counts can increase for a day after it ends.
        </li>
      </ul>
    </details>
  );
}

function NoCohorts({
  retention,
  environment,
  onLonger,
}: {
  retention: Retention;
  environment: string;
  /** Absent when the period is already the longest preset. */
  onLonger: (() => void) | undefined;
}) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <UserRoundCheckIcon />
        </EmptyMedia>
        <EmptyTitle>No new signed-in users in this period</EmptyTitle>
        <EmptyDescription>
          No signed-in user was first seen{where} from{" "}
          {formatDayRange(retention.firstDay, retention.lastDay)}.
        </EmptyDescription>
      </EmptyHeader>
      {onLonger !== undefined && (
        <EmptyContent>
          <Button variant="outline" onClick={onLonger}>
            Show the last 12 months
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

export function RetentionPage({
  projectId,
  range: asked,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const range = retentionRange(asked);
  const query = useQuery(retentionQuery(projectId, range, environment));
  const search: ProductSearch = { range, environment };
  const show = (next: Partial<ProductSearch>) =>
    void navigate({
      to: "/projects/$projectId/product/retention",
      params: { projectId },
      search: productSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;
  const longest = "period" in range && range.period === LONGEST;

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        range={range}
        environment={environment}
        answered={data}
        periods={RETENTION_PERIODS}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {query.isError && (
          <LoadFailed
            what="The retention report"
            message={query.error.message}
            hasData={data !== undefined}
            onRetry={() => void query.refetch()}
          />
        )}
        {data === undefined ? (
          !query.isError && <LoadingRows rows={6} />
        ) : (
          <Refreshing stale={query.isPlaceholderData}>
            {data.cohorts.length > 0 ? (
              <div className="flex flex-col gap-6">
                <CohortTable retention={data} />
                <RetentionNotes timeZone={data.timeZone} />
              </div>
            ) : data.identifiesUsers ? (
              <NoCohorts
                retention={data}
                environment={environment}
                onLonger={longest ? undefined : () => show({ range: { period: LONGEST } })}
              />
            ) : (
              <NoSignedInUsers lead="Retention follows signed-in users from week to week." />
            )}
          </Refreshing>
        )}
      </div>
    </div>
  );
}
