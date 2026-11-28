import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { FilterBar } from "@/components/filter-bar";
import { PageBack } from "@/components/page-back";
import { ReportChart } from "@/components/report-chart";
import { StatStrip } from "@/components/stat-strip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { projectReports } from "@/lib/analytics-queries";
import { ApiError } from "@/lib/api";
import { nowQuery, type RightNow } from "@/lib/now-api";

import { NoSuchProject } from "../projects/no-such-project";
import { StackedBarChart } from "../telemetry/stacked-bar-chart";
import { DashboardAnalyticsScope } from "./dashboard-analytics-page";
import { FilterLink } from "./filter-link";
import { countryName, formatCount, formatTimeOfDay, formatWhole } from "./format";
import type { PageSearch } from "./list-rows";
import { LiveDot } from "./now-indicator";

const MEASURES = [
  { key: "visitors", label: "Visitors" },
  { key: "pageviews", label: "Pageviews" },
] as const;

type Measure = (typeof MEASURES)[number]["key"];

const isMeasure = (value: unknown): value is Measure =>
  MEASURES.some((measure) => measure.key === value);

const EMPTY = "Nobody in the last 30 minutes.";

/** The window as the API counted it: "13:34 to 14:03". */
function windowText(now: RightNow): string {
  const first = now.perMinute[0]?.start ?? now.at;
  return `${formatTimeOfDay(first, now.timeZone)} to ${formatTimeOfDay(now.at, now.timeZone)}`;
}

/** Visitors or pageviews per minute; the last bar is the minute still running. */
function PerMinute({ now }: { now: RightNow }) {
  const [measure, setMeasure] = React.useState<Measure>("visitors");
  const { perMinute, timeZone } = now;
  const frame = {
    bucketStarts: perMinute.map((minute) => minute.start),
    stepSeconds: 60,
    timeZone,
    firstDay: "",
    lastDay: "",
  };
  const label = MEASURES.find((item) => item.key === measure)?.label ?? "Visitors";
  return (
    <Tabs
      value={measure}
      onValueChange={(value) => {
        if (isMeasure(value)) setMeasure(value);
      }}
      className="gap-2"
    >
      <ReportChart
        title={`${label} per minute`}
        description="The last minute is still running."
        actions={
          <TabsList aria-label="Measure to chart">
            {MEASURES.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        table={
          <table className="w-full max-w-xl text-sm">
            <caption className="sr-only">Visitors and pageviews per minute</caption>
            <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
              <tr className="text-xs text-ink-subtle">
                <th scope="col" className="pb-2 text-left font-normal">
                  Minute
                </th>
                {MEASURES.map((item) => (
                  <th key={item.key} scope="col" className="pb-2 text-right font-normal">
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {perMinute.map((minute) => (
                <tr key={minute.start} className="border-t border-hairline">
                  <th scope="row" className="py-1.5 text-left font-normal text-ink tabular-nums">
                    {formatTimeOfDay(minute.start, timeZone)}
                  </th>
                  {MEASURES.map((item) => (
                    <td key={item.key} className="py-1.5 text-right text-ink tabular-nums">
                      {formatWhole(minute[item.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        }
      >
        {MEASURES.map((item) => (
          <TabsContent key={item.key} value={item.key}>
            {now.windowVisitors === 0 ? (
              <p className="py-8 text-center text-sm text-ink-subtle">{EMPTY}</p>
            ) : (
              <StackedBarChart
                frame={frame}
                parts={[
                  {
                    key: item.key,
                    label: item.label,
                    color: "var(--chart-1)",
                    values: perMinute.map((minute) => minute[item.key]),
                  },
                ]}
                label={`${item.label} per minute`}
                formatValue={formatCount}
              />
            )}
          </TabsContent>
        ))}
      </ReportChart>
    </Tabs>
  );
}

/**
 * A row's name links to the Web analytics page for today, filtered by it,
 * as the page's own lists do.
 */
function Lists({ now }: { now: RightNow }) {
  const today: PageSearch = {
    range: { period: "today" },
    filters: [],
    environment: now.environment,
  };
  return (
    // Use content width; the sidebar takes 16rem.
    <div className="@container border-t pt-5">
      <div className="grid gap-x-8 gap-y-8 @3xl:grid-cols-2 @5xl:grid-cols-3">
        <BreakdownTable
          title="Pages"
          headingLevel={2}
          caption="Pages visitors were on in the last 30 minutes, most visitors first"
          nameHeading="Path"
          figureHeadings={["Visitors", "Views"]}
          rows={now.pages.map((row) => ({
            key: row.path,
            label: <FilterLink search={today} name="page" value={row.path} />,
            title: row.path,
            bar: row.visitors,
            figures: [formatWhole(row.visitors), formatWhole(row.pageviews)],
          }))}
          empty={EMPTY}
          layout="stack"
        />
        <BreakdownTable
          title="Sources"
          headingLevel={2}
          caption="Where the last 30 minutes' visits came from, most visitors first"
          nameHeading="Source"
          figureHeadings={["Visitors"]}
          rows={now.sources.map((row) => ({
            key: row.value,
            label: <FilterLink search={today} name="source" value={row.value} />,
            title: row.value,
            bar: row.visitors,
            figures: [formatWhole(row.visitors)],
          }))}
          empty={EMPTY}
          layout="stack"
        />
        <BreakdownTable
          title="Countries"
          headingLevel={2}
          caption="Where the last 30 minutes' visitors are, most visitors first"
          nameHeading="Country"
          figureHeadings={["Visitors"]}
          rows={now.countries.map((row) => {
            const name = row.value === null ? "Unknown" : countryName(row.value);
            return {
              key: row.value ?? "\u0000unknown",
              label: <FilterLink search={today} name="country" value={row.value ?? ""} />,
              title: name,
              bar: row.visitors,
              figures: [formatWhole(row.visitors)],
            };
          })}
          empty={EMPTY}
          layout="stack"
        />
      </div>
    </div>
  );
}

function Notes() {
  return (
    <details className="group border-t pt-5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 text-ink-subtle transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        How Right now counts
      </summary>
      <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1 pl-5 text-xs text-pretty text-ink-subtle">
        <li>
          A visitor is there when their browser sent a pageview, time on a page, or a custom event.
          Visitors now counts the last 5 minutes; the chart and the lists, the last 30.
        </li>
        <li>
          A visit's source and country are those it started with, as in the Web analytics lists.
          Events sent by your server have no visitor and are not counted.
        </li>
        <li>The numbers update every 15 seconds while this tab is open.</li>
      </ul>
    </details>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading Right now" className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          // oxlint-disable-next-line react/no-array-index-key
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * Right now (docs/web-analytics.md, "Right now"): who is on the site, for
 * the environment in the address. Its own address, apart from the Web
 * analytics page's period and filters, which it does not use.
 */
export function RightNowPage({
  projectId,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  environment?: string;
}) {
  const now = useQuery(nowQuery(projectReports(projectId), environment));
  const back = (
    <PageBack
      label="Web analytics"
      link={
        <Link
          to="/projects/$projectId/web-analytics"
          params={{ projectId }}
          search={environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }}
        />
      }
    />
  );
  if (now.error instanceof ApiError && now.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = now.data;
  const pageviews = data?.perMinute.reduce((sum, minute) => sum + minute.pageviews, 0) ?? 0;
  return (
    <div className="flex flex-col">
      {back}
      <FilterBar
        label="Environment and time"
        environment={
          <span className="text-sm whitespace-nowrap text-ink-subtle">
            Environment <span className="text-ink">{environment}</span>
          </span>
        }
        range={
          data !== undefined && (
            <p className="flex flex-wrap items-baseline gap-x-3 text-sm text-ink-subtle tabular-nums">
              <span className="whitespace-nowrap text-ink-muted">{windowText(data)}</span>
              <span className="whitespace-nowrap">{data.timeZone}</span>
            </p>
          )
        }
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {now.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined ? "Right now could not load" : "Right now could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {now.error.message}
              {data !== undefined && " The numbers below are from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void now.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {data === undefined ? (
          !now.isError && <Loading />
        ) : (
          <div
            className="flex flex-col gap-6 transition-opacity data-[stale=true]:opacity-60"
            data-stale={now.isPlaceholderData || now.isError}
          >
            <StatStrip
              label="Right now"
              className="lg:grid-cols-3"
              stats={[
                {
                  label: "Visitors now",
                  value: (
                    <span className="flex items-center gap-2">
                      <LiveDot live={data.visitors > 0} />
                      {formatWhole(data.visitors)}
                    </span>
                  ),
                },
                { label: "Visitors, last 30 minutes", value: formatWhole(data.windowVisitors) },
                { label: "Pageviews, last 30 minutes", value: formatWhole(pageviews) },
              ]}
            />
            <PerMinute now={data} />
            <DashboardAnalyticsScope projectId={projectId}>
              <Lists now={data} />
            </DashboardAnalyticsScope>
            <Notes />
          </div>
        )}
      </div>
    </div>
  );
}
