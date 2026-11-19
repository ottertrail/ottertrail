import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChartLineIcon, FilterXIcon, OctagonAlertIcon, XIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { ButtonLink } from "@/components/button-link";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccess } from "@/lib/access";
import {
  activeFilters,
  type Analytics,
  type Breakdown,
  analyticsQuery,
  type DayPoint,
  DEFAULT_ENVIRONMENT,
  type Filters,
  LIST_PREVIEW_ROWS,
  type ListReport,
  type PageRange,
} from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { projectQuery, type ProjectSummary } from "@/lib/projects-api";

import { EnvironmentSelect, PeriodSelect } from "../errors/range-controls";
import { MIN_LOADS_FOR_CHANGE } from "../overview/format";
import { NoSuchProject } from "../projects/no-such-project";
import { DayChart } from "./day-chart";
import { FilterLink } from "./filter-link";
import {
  formatCount,
  formatDay,
  formatDayRange,
  formatDuration,
  formatPercent,
  formatRatio,
  formatTimeOfDay,
  formatWhole,
  pointsChange,
  relativeChange,
} from "./format";
import { GoalsCard } from "./goals-card";
import {
  type FilterLinkFor,
  filterText,
  fromBreakdown,
  fromEvents,
  fromPages,
  type PageSearch,
  rankedRows,
  searchOf,
} from "./list-rows";
import type { RankedRow } from "./ranked-list";
import { ShowAllDialog } from "./show-all-dialog";

const METRICS = [
  { key: "visitors", label: "Visitors" },
  { key: "visits", label: "Visits" },
  { key: "pageviews", label: "Pageviews" },
] as const satisfies readonly { key: keyof DayPoint; label: string }[];

type Metric = (typeof METRICS)[number]["key"];

const isMetric = (value: unknown): value is Metric =>
  METRICS.some((metric) => metric.key === value);

interface ListTab {
  value: string;
  label: string;
  nameHeading: string;
  secondaryHeading: string;
  empty: string;
  /** The full list, for "Show all". */
  report: ListReport;
  rows: RankedRow[];
}

/** A list of visits grouped by one property. */
function visitsTab(
  value: string,
  label: string,
  nameHeading: string,
  report: ListReport,
  rows: RankedRow[],
): ListTab {
  return {
    value,
    label,
    nameHeading,
    secondaryHeading: "Visits",
    empty: "No visits in this period.",
    report,
    rows,
  };
}

/**
 * One breakdown as a compact table; with more than one list of the kind, a
 * toggle group switches between them. A list that shows its full
 * LIST_PREVIEW_ROWS may have more: "Show all" opens it in full.
 */
function BreakdownSection({
  title,
  tabs,
  projectId,
  search,
}: {
  title: string;
  tabs: ListTab[];
  projectId: string;
  search: PageSearch;
}) {
  const [first] = tabs;
  const [shownValue, setShownValue] = React.useState(first?.value ?? "");
  const [showing, setShowing] = React.useState<ListTab | undefined>();
  const tab = tabs.find((item) => item.value === shownValue) ?? first;
  if (tab === undefined) return null;
  return (
    <>
      <BreakdownTable
        title={title}
        headingLevel={2}
        caption={`${tab.label}, most visitors first`}
        nameHeading={tab.nameHeading}
        figureHeadings={["Visitors", tab.secondaryHeading]}
        rows={tab.rows.map((row) => ({
          key: row.key,
          label: row.label,
          title: row.title,
          bar: row.primary,
          figures: [
            formatWhole(row.primary),
            row.secondary === undefined ? "–" : formatWhole(row.secondary),
          ],
        }))}
        views={
          tabs.length > 1
            ? {
                value: tab.value,
                onValueChange: setShownValue,
                items: tabs.map((item) => ({ value: item.value, label: item.label })),
              }
            : undefined
        }
        showAll={
          tab.rows.length >= LIST_PREVIEW_ROWS ? (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2.5"
              onClick={() => setShowing(tab)}
              aria-label={`Show all ${tab.label.toLowerCase()}`}
            >
              Show all
            </Button>
          ) : undefined
        }
        empty={tab.empty}
        layout="stack"
      />
      {showing !== undefined && (
        <ShowAllDialog
          open
          onOpenChange={(open) => {
            if (!open) setShowing(undefined);
          }}
          title={tabs.length === 1 ? title : `${title}: ${showing.label}`}
          report={showing.report}
          nameHeading={showing.nameHeading}
          secondaryHeading={showing.secondaryHeading}
          projectId={projectId}
          search={search}
        />
      )}
    </>
  );
}

/** "Changes compare with 3 to 9 Nov 2026, up to 15:00 on 9 Nov." */
function comparisonNote({ previous, timeZone }: Analytics): string {
  const days = formatDayRange(previous.firstDay, previous.lastDay);
  const before = previous.summary;
  if (before.visits === 0 && before.pageviews === 0) {
    return `No visits in ${days} to compare with.`;
  }
  if (previous.until === null) {
    return `Changes compare with ${days}.`;
  }
  const time = formatTimeOfDay(previous.until, timeZone);
  return previous.firstDay === previous.lastDay
    ? `Changes compare with ${days}, up to ${time}.`
    : `Changes compare with ${days}, up to ${time} on ${formatDay(previous.lastDay)}.`;
}

/**
 * All the period's figures in one strip. A change shows only when its counts
 * reach the minimum (lib/change.ts): visitors, visits and pageviews rest on
 * themselves, the per-visit figures and the bounce rate on visits.
 */
function Summary({ analytics }: { analytics: Analytics }) {
  const { summary } = analytics;
  const before = analytics.previous.summary;
  const visits = { current: summary.visits, previous: before.visits };
  const stats: Stat[] = [
    {
      label: "Visitors",
      value: formatCount(summary.visitors),
      change: relativeChange(summary.visitors, before.visitors),
      before: formatWhole(before.visitors),
      counts: { current: summary.visitors, previous: before.visitors },
    },
    {
      label: "Visits",
      value: formatCount(summary.visits),
      change: relativeChange(summary.visits, before.visits),
      before: formatWhole(before.visits),
      counts: visits,
    },
    {
      label: "Pageviews",
      value: formatCount(summary.pageviews),
      change: relativeChange(summary.pageviews, before.pageviews),
      before: formatWhole(before.pageviews),
      counts: { current: summary.pageviews, previous: before.pageviews },
    },
    {
      label: "Views per visit",
      value: formatRatio(summary.viewsPerVisit),
      change: relativeChange(summary.viewsPerVisit, before.viewsPerVisit),
      before: formatRatio(before.viewsPerVisit),
      counts: visits,
    },
    {
      label: "Bounce rate",
      value: formatPercent(summary.bounceRate),
      // A share changes in percentage points.
      change: pointsChange(summary.bounceRate, before.bounceRate),
      before: formatPercent(before.bounceRate),
      counts: visits,
    },
    {
      label: "Visit duration",
      value: formatDuration(summary.avgDurationMs),
      change: relativeChange(summary.avgDurationMs, before.avgDurationMs),
      before: formatDuration(before.avgDurationMs),
      counts: visits,
    },
    {
      label: "Time engaged",
      value: formatDuration(summary.avgEngagedMs),
      change: relativeChange(summary.avgEngagedMs, before.avgEngagedMs),
      before: formatDuration(before.avgEngagedMs),
      counts: visits,
    },
  ];
  return (
    <section aria-label="Summary" className="flex flex-col gap-3">
      <StatStrip label="Figures" stats={stats} minCount={MIN_LOADS_FOR_CHANGE} />
      <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
        {comparisonNote(analytics)} Without cookies, visitors are recognized for only one day. A
        person who returns on another day counts again. Durations are averages per visit.
      </p>
    </section>
  );
}

/** A short, wide chart of one metric per day, and every day's numbers on demand. */
function Trend({ days }: { days: DayPoint[] }) {
  const [metric, setMetric] = React.useState<Metric>("visitors");
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();
  const headingId = React.useId();

  const tooltipRows = (plotted: Metric) => (index: number) => {
    const day = days[index];
    return METRICS.map((item) => ({
      label: item.label,
      value: day === undefined ? "–" : formatWhole(day[item.key]),
      plotted: item.key === plotted,
    }));
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t pt-5">
      <Tabs
        value={metric}
        onValueChange={(value) => {
          if (isMetric(value)) {
            setMetric(value);
          }
        }}
        className="gap-2"
      >
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 id={headingId} className="text-sm font-medium text-ink">
            {METRICS.find((item) => item.key === metric)?.label} per day
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {days.length >= 2 && (
              <TabsList aria-label="Metric to chart">
                {METRICS.map((item) => (
                  <TabsTrigger key={item.key} value={item.key}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showTable}
              aria-controls={tableId}
              onClick={() => setShowTable((shown) => !shown)}
            >
              {showTable ? "Hide the numbers" : "Show the numbers"}
            </Button>
          </div>
        </div>
        {METRICS.map((item) => (
          <TabsContent key={item.key} value={item.key}>
            {days.length < 2 ? (
              <p className="py-8 text-center text-sm text-ink-subtle">
                A trend needs at least two days. Choose a longer period to see one.
              </p>
            ) : (
              <DayChart
                points={days.map((day) => ({ day: day.day, value: day[item.key] }))}
                label={`${item.label} per day`}
                tooltipRows={tooltipRows(item.key)}
                plotHeight={140}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
      <div id={tableId} hidden={!showTable} className="max-h-80 max-w-xl overflow-y-auto">
        {showTable && (
          <table className="w-full text-sm">
            <caption className="sr-only">Visitors, visits, and pageviews per day</caption>
            <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
              <tr className="text-xs text-ink-subtle">
                <th scope="col" className="pb-2 text-left font-normal">
                  Day
                </th>
                {METRICS.map((item) => (
                  <th key={item.key} scope="col" className="pb-2 text-right font-normal">
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.day} className="border-t border-hairline">
                  <th scope="row" className="py-1.5 text-left font-normal text-ink">
                    {formatDay(day.day, { weekday: true })}
                  </th>
                  {METRICS.map((item) => (
                    <td key={item.key} className="py-1.5 text-right text-ink tabular-nums">
                      {formatWhole(day[item.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Reports({
  analytics,
  projectId,
  search,
}: {
  analytics: Analytics;
  projectId: string;
  search: PageSearch;
}) {
  const { breakdowns } = analytics;
  const showGoals = useAccess().canUse("product_analytics");
  const link: FilterLinkFor = (name, value) => (
    <FilterLink projectId={projectId} search={search} name={name} value={value} />
  );
  const rows = (report: Breakdown) => rankedRows(report, fromBreakdown(breakdowns[report]), link);
  const card = { projectId, search };
  return (
    <>
      <Summary analytics={analytics} />
      <Trend days={analytics.days} />
      {/* Side by side by the content's width, not the window's: the sidebar takes 16rem. */}
      <div className="@container border-t pt-5">
        <div className="grid gap-x-8 gap-y-8 @3xl:grid-cols-2 @5xl:grid-cols-3">
          <BreakdownSection
            {...card}
            title="Pages"
            tabs={[
              {
                value: "top",
                label: "Top pages",
                nameHeading: "Path",
                secondaryHeading: "Views",
                empty: "No pageviews in this period.",
                report: "pages",
                rows: rankedRows("pages", fromPages(analytics.pages), link),
              },
              visitsTab("entry", "Entry", "Path", "entryPage", rows("entryPage")),
              visitsTab("exit", "Exit", "Path", "exitPage", rows("exitPage")),
            ]}
          />
          <BreakdownSection
            {...card}
            title="Sources"
            tabs={[
              visitsTab("source", "Sources", "Source", "source", rows("source")),
              visitsTab("campaign", "Campaigns", "Campaign", "utmCampaign", rows("utmCampaign")),
            ]}
          />
          <BreakdownSection
            {...card}
            title="Locations"
            tabs={[
              visitsTab("country", "Countries", "Country", "country", rows("country")),
              visitsTab("region", "Regions", "Region", "region", rows("region")),
              visitsTab("city", "Cities", "City", "city", rows("city")),
            ]}
          />
          <BreakdownSection
            {...card}
            title="Devices"
            tabs={[
              visitsTab("device", "Devices", "Device", "deviceType", rows("deviceType")),
              visitsTab("browser", "Browsers", "Browser", "browser", rows("browser")),
              visitsTab("os", "Systems", "Operating system", "os", rows("os")),
            ]}
          />
          <BreakdownSection
            {...card}
            title="Releases"
            tabs={[
              {
                // Only "Unknown" means the site names no release: say how to.
                ...visitsTab(
                  "release",
                  "Releases",
                  "Release",
                  "release",
                  breakdowns.release.every((row) => row.value === null) ? [] : rows("release"),
                ),
                empty:
                  'No visit in this period names a release. Add data-release="1.4.2" (your app\'s version) to the tracking snippet to see which versions visitors use.',
              },
            ]}
          />
          <BreakdownSection
            {...card}
            title="Custom events"
            tabs={[
              {
                value: "events",
                label: "Custom events",
                nameHeading: "Event",
                secondaryHeading: "Events",
                empty: "No custom events in this period.",
                report: "customEvents",
                rows: rankedRows("customEvents", fromEvents(analytics.customEvents), link),
              },
            ]}
          />
        </div>
      </div>
      {/* Goals belong to product analytics (docs/access.md). */}
      {showGoals && (
        <GoalsCard
          goals={analytics.goals}
          projectId={projectId}
          eventNames={analytics.customEvents.map((event) => event.name)}
        />
      )}
    </>
  );
}

/** Shaped like the report: the strip of figures, the short chart, and the breakdowns. */
function LoadingReports() {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, index) => (
          // oxlint-disable-next-line react/no-array-index-key
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="h-44 w-full" />
      <div className="@container">
        <div className="grid gap-8 @3xl:grid-cols-2 @5xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            // oxlint-disable-next-line react/no-array-index-key
            <Skeleton key={index} className="h-40 w-full" />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * The active filters, each with a way to remove it, and a way to remove them
 * all; with none, how to add one.
 */
function ActiveFilters({ projectId, search }: { projectId: string; search: PageSearch }) {
  const active = activeFilters(search.filters);
  if (active.length === 0) {
    return (
      <p className="text-sm text-ink-subtle">
        No filters. Select a name in a table to filter by it.
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ul aria-label="Filters" className="flex flex-wrap items-center gap-2">
        {active.map(([name, value]) => {
          const text = filterText(name, value);
          const others = Object.fromEntries(active.filter(([other]) => other !== name));
          return (
            <li
              key={name}
              className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-sm text-ink"
            >
              <span className="truncate" title={text}>
                {text}
              </span>
              <Link
                to="/projects/$projectId/web-analytics"
                params={{ projectId }}
                search={searchOf({ ...search, filters: others })}
                aria-label={`Remove the filter ${text}`}
                className="rounded p-1 text-ink-subtle hover:bg-background/60 hover:text-ink"
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </Link>
            </li>
          );
        })}
      </ul>
      <Link
        to="/projects/$projectId/web-analytics"
        params={{ projectId }}
        search={searchOf({ ...search, filters: {} })}
        className="text-sm whitespace-nowrap text-link hover:underline"
      >
        Clear filters
      </Link>
    </div>
  );
}

/** No data in the range: nothing ever arrived, nothing matches the filters, or nothing lately. */
function NoData({
  projectId,
  project,
  search,
  otherEnvironments,
}: {
  projectId: string;
  project: ProjectSummary | undefined;
  search: PageSearch;
  /** Other environments have events, which the environment picker can show. */
  otherEnvironments: boolean;
}) {
  const neverReceived = project?.lastEventAt === null;
  // The snippet is in the project's settings, for those who manage projects.
  const canInstall = useAccess().can("projects");
  const isYear = "period" in search.range && search.range.period === "12m";
  if (!neverReceived && activeFilters(search.filters).length > 0) {
    return (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FilterXIcon />
          </EmptyMedia>
          <EmptyTitle>No visits match these filters</EmptyTitle>
          <EmptyDescription>
            No visit in this period matches all of them. Remove a filter, or choose a longer period.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/web-analytics"
            params={{ projectId }}
            search={searchOf({ ...search, filters: {} })}
          >
            Clear filters
          </ButtonLink>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChartLineIcon />
        </EmptyMedia>
        <EmptyTitle>{neverReceived ? "No events yet" : "Nothing in this period"}</EmptyTitle>
        <EmptyDescription>
          {neverReceived
            ? canInstall
              ? "Install the tracking snippet on your site. Reports appear here as soon as the first pageview arrives."
              : "Reports appear here as soon as the first pageview arrives. An admin installs the tracking snippet from the project's settings."
            : `No pageviews or events arrived${
                search.environment === DEFAULT_ENVIRONMENT ? "" : ` in ${search.environment}`
              } in this period. Choose a longer one to see earlier data${
                otherEnvironments ? ", or another environment" : ""
              }.`}
        </EmptyDescription>
      </EmptyHeader>
      {neverReceived && canInstall && (
        <EmptyContent>
          <ButtonLink variant="outline" to="/projects/$projectId/settings" params={{ projectId }}>
            Install the snippet
          </ButtonLink>
        </EmptyContent>
      )}
      {!neverReceived && !isYear && (
        <EmptyContent>
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/web-analytics"
            params={{ projectId }}
            search={searchOf({ ...search, range: { period: "12m" }, filters: {} })}
          >
            Show the last 12 months
          </ButtonLink>
        </EmptyContent>
      )}
    </Empty>
  );
}

const hasData = (analytics: Analytics) =>
  analytics.summary.pageviews > 0 ||
  analytics.summary.visits > 0 ||
  analytics.customEvents.length > 0;

/**
 * Web analytics for one project: the numbers, a trend, and ranked lists,
 * all for a period that ends today or for chosen days, in the
 * timezone set in Settings.
 */
export function AnalyticsPage({
  projectId,
  range,
  filters,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  filters: Filters;
  environment?: string;
}) {
  const navigate = useNavigate();
  const project = useQuery(projectQuery(projectId));
  const analytics = useQuery(analyticsQuery(projectId, range, filters, environment));
  const search: PageSearch = { range, filters, environment };
  const show = (next: Partial<PageSearch>) =>
    void navigate({
      to: "/projects/$projectId/web-analytics",
      params: { projectId },
      // New days, or another environment, keep everything else.
      search: searchOf({ ...search, ...next }),
    });

  if (analytics.error instanceof ApiError && analytics.error.status === 404) {
    return <NoSuchProject />;
  }

  const data = analytics.data;
  const refreshing = analytics.isPlaceholderData;

  return (
    <div className="flex flex-col">
      <FilterBar
        label="Period, environment, and filters"
        period={
          <PeriodSelect range={range} answered={data} onRange={(next) => show({ range: next })} />
        }
        environment={
          // Only once there is a choice (most projects have production alone),
          // and always while another is shown, so there is a way back.
          data !== undefined && (
            <EnvironmentSelect
              environment={environment}
              answered={data}
              onEnvironment={(next) => show({ environment: next })}
            />
          )
        }
        filters={<ActiveFilters projectId={projectId} search={search} />}
        range={
          data !== undefined && (
            <FilterBarRange
              firstDay={data.firstDay}
              lastDay={data.lastDay}
              timeZone={data.timeZone}
            />
          )
        }
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {analytics.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined ? "The reports could not load" : "The reports could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {analytics.error.message}
              {data !== undefined && " The numbers below are from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void analytics.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        {data === undefined ? (
          !analytics.isError && (
            <div className="flex flex-col gap-6" aria-busy="true">
              <LoadingReports />
            </div>
          )
        ) : (
          <div
            className="flex flex-col gap-6 transition-opacity data-[refreshing=true]:opacity-60"
            data-refreshing={refreshing}
            aria-busy={refreshing}
          >
            {hasData(data) ? (
              <Reports analytics={data} projectId={projectId} search={search} />
            ) : (
              <NoData
                projectId={projectId}
                project={project.data}
                search={search}
                otherEnvironments={data.environments.some((name) => name !== environment)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
