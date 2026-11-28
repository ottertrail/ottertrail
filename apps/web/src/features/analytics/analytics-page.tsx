import { useQuery } from "@tanstack/react-query";
import { ChartLineIcon, FilterXIcon, OctagonAlertIcon, PlusIcon, XIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  type Analytics,
  type Breakdown,
  type DayPoint,
  DEFAULT_ENVIRONMENT,
  type EventList,
  type FilterName,
  type Filters,
  type ListReport,
  type PageGoalResult,
  type PageRange,
} from "@/lib/analytics-api";
import {
  analyticsQuery,
  canBeGoal,
  type GoalChoice,
  goalChoiceFrom,
  LIST_PREVIEW_ROWS,
  listPreviewQuery,
  type ListRow,
  sameGoal,
} from "@/lib/analytics-queries";
import { ApiError } from "@/lib/api";
import { MISSING } from "@/lib/missing";

import { EnvironmentSelect, PeriodSelect } from "../errors/range-controls";
import { MIN_LOADS_FOR_CHANGE } from "../overview/format";
import { DayChart } from "./day-chart";
import { AddFilter, FilterChip } from "./filter-editor";
import { FilterLink, GoalLink, PageLink } from "./filter-link";
import {
  formatConversion,
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
  fromBreakdown,
  fromEvents,
  fromEventValues,
  fromPages,
  goalText,
  type PageSearch,
  rankedRows,
  rowRate,
  valueText,
} from "./list-rows";
import type { RankedRow } from "./ranked-list";
import { useAnalyticsScope } from "./scope";
import { ShowAllDialog } from "./show-all-dialog";

const METRICS = [
  { key: "visitors", label: "Visitors" },
  { key: "visits", label: "Visits" },
  { key: "pageviews", label: "Pageviews" },
] as const satisfies readonly { key: keyof DayPoint; label: string }[];

/** With a goal, the chart opens on its converted visitors. */
const GOAL_METRICS = [{ key: "converted", label: "Converted" } as const, ...METRICS];

type Metric = (typeof GOAL_METRICS)[number]["key"];

const isMetric = (value: unknown): value is Metric =>
  GOAL_METRICS.some((metric) => metric.key === value);

const dayValue = (day: DayPoint, metric: Metric) => day[metric] ?? 0;

/** A goal's name: a saved goal's, or the custom event's. */
function goalName(goal: GoalChoice, analytics: Analytics | undefined): string {
  if ("event" in goal) return goal.event;
  return (
    analytics?.goal?.name ?? analytics?.goals.find((item) => item.id === goal.id)?.name ?? "Goal"
  );
}

/** The one value a filter keeps with "is", if the page has such a filter; else undefined. */
function onlyValue(filters: Filters, name: FilterName): string | undefined {
  const matching = filters.filter((filter) => filter.name === name);
  const [only] = matching;
  return matching.length === 1 && only?.operator === "is" && only.values.length === 1
    ? only.values[0]
    : undefined;
}

/** The source of a visit with no tag and no referrer from another site (visits/visit-source.ts). */
const DIRECT = "Direct / none";

interface ListTab {
  value: string;
  label: string;
  nameHeading: string;
  secondaryHeading: string;
  /** A third figure without a goal: each row's exit rate (exit pages). */
  rateHeading?: string;
  /** A line under the card's title while this list shows. */
  description?: string;
  empty: string;
  report: ListReport;
  rows: RankedRow[];
  /**
   * A list the page's answer does not hold: read from the list route when
   * its tab shows, its rows made with this (rows is then unused).
   */
  lazy?: (rows: ListRow[]) => RankedRow[];
}

/**
 * The tracker's link and not found lists (docs/web-analytics.md, "Links
 * and not found pages"). Empty, each says how it fills.
 */
const EVENT_SECTIONS = [
  {
    report: "outboundLinks",
    title: "Outbound links",
    nameHeading: "Link",
    secondaryHeading: "Clicks",
    empty:
      'No clicks on links to other sites in this period. The tracker records them unless its snippet has data-outbound="off".',
  },
  {
    report: "fileDownloads",
    title: "File downloads",
    nameHeading: "File",
    secondaryHeading: "Downloads",
    empty:
      'No file downloads in this period. Clicks on links to files such as .pdf or .zip count unless the snippet has data-downloads="off".',
  },
  {
    report: "notFoundPages",
    title: "Not found pages",
    nameHeading: "Path",
    secondaryHeading: "Views",
    empty:
      'No not found pages in this period. To count them, add <meta name="ottertrail" content="not-found"> to your not found page.',
  },
] as const satisfies readonly {
  report: EventList;
  title: string;
  nameHeading: string;
  secondaryHeading: string;
  empty: string;
}[];

/** A tab whose list loads when it shows (listPreviewQuery). */
const lazyTab = (tab: ListTab, toRows: (rows: ListRow[]) => RankedRow[]): ListTab => ({
  ...tab,
  rows: [],
  lazy: toRows,
});

/** While a tab's list loads, or why it did not: as the page's first load shows them. */
function TabListState({
  query,
  empty,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown };
  empty: string;
}) {
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive" className="text-left">
        <OctagonAlertIcon />
        <AlertTitle>The list could not load</AlertTitle>
        <AlertDescription>{query.error?.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return empty;
}

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
 * A full LIST_PREVIEW_ROWS preview may have more rows. With a goal (`goal`),
 * each row shows its visitors, converted visitors, and rate, most converted
 * first, and the bar the converted.
 */
function BreakdownSection({
  title,
  tabs,
  search,
  goal = false,
}: {
  title: string;
  tabs: ListTab[];
  search: PageSearch;
  goal?: boolean;
}) {
  const [first] = tabs;
  const [shownValue, setShownValue] = React.useState(first?.value ?? "");
  const [showing, setShowing] = React.useState<ListTab | undefined>();
  const tab = tabs.find((item) => item.value === shownValue) ?? first;
  const { source } = useAnalyticsScope();
  // Only the shown tab's list loads, and only when the page's answer lacks it.
  const preview = useQuery({
    ...listPreviewQuery(
      source,
      search.range,
      search.filters,
      search.environment,
      tab?.report ?? "pages",
      search.goal,
    ),
    enabled: tab?.lazy !== undefined,
  });
  if (tab === undefined) return null;
  const shownRows = tab.lazy === undefined ? tab.rows : tab.lazy(preview.data ?? []);
  return (
    <>
      <BreakdownTable
        title={title}
        headingLevel={2}
        caption={`${tab.label}, ${goal ? "most converted" : "most visitors"} first`}
        nameHeading={tab.nameHeading}
        figureHeadings={
          goal
            ? ["Visitors", "Converted", "Rate"]
            : [
                "Visitors",
                tab.secondaryHeading,
                ...(tab.rateHeading === undefined ? [] : [tab.rateHeading]),
              ]
        }
        barFigure={goal ? 1 : 0}
        rows={shownRows.map((row) => ({
          key: row.key,
          label: row.label,
          title: row.title,
          action: row.action,
          bar: goal ? (row.converted ?? 0) : row.primary,
          figures: goal
            ? [formatWhole(row.primary), formatWhole(row.converted ?? 0), rowRate(row)]
            : [
                formatWhole(row.primary),
                row.secondary === undefined ? MISSING : formatWhole(row.secondary),
                ...(tab.rateHeading === undefined ? [] : [formatPercent(row.exitRate ?? null)]),
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
          shownRows.length >= LIST_PREVIEW_ROWS ? (
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
        empty={
          tab.lazy === undefined ? tab.empty : <TabListState query={preview} empty={tab.empty} />
        }
        description={tab.description}
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
          rateHeading={showing.rateHeading}
          search={search}
        />
      )}
    </>
  );
}

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

/** Use the minimum in lib/change.ts. Per-visit metrics and bounce rate use visit counts. */
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

/**
 * With a goal: the visitors, those who reached it, their share, and the
 * goal's events, each compared with the period before.
 */
function GoalSummary({ analytics, goal }: { analytics: Analytics; goal: PageGoalResult }) {
  const visitors = analytics.summary.visitors;
  const before = analytics.previous.summary.visitors;
  const converted = { current: goal.converted, previous: goal.previous.converted };
  const rateBefore = before === 0 ? null : goal.previous.converted / before;
  const stats: Stat[] = [
    {
      label: "Visitors",
      value: formatCount(visitors),
      change: relativeChange(visitors, before),
      before: formatWhole(before),
      counts: { current: visitors, previous: before },
    },
    {
      label: "Converted",
      value: formatCount(goal.converted),
      change: relativeChange(goal.converted, goal.previous.converted),
      before: formatWhole(goal.previous.converted),
      counts: converted,
    },
    {
      label: "Conversion rate",
      value: formatConversion(goal.conversionRate),
      // A share changes in percentage points.
      change: pointsChange(visitors === 0 ? null : goal.conversionRate, rateBefore),
      before: rateBefore === null ? MISSING : formatConversion(rateBefore),
      counts: converted,
    },
    {
      label: "Events",
      value: formatCount(goal.events),
      change: relativeChange(goal.events, goal.previous.events),
      before: formatWhole(goal.previous.events),
      counts: { current: goal.events, previous: goal.previous.events },
    },
  ];
  return (
    <section aria-label="Summary" className="flex flex-col gap-3">
      <StatStrip
        label="Figures"
        stats={stats}
        minCount={MIN_LOADS_FOR_CHANGE}
        className="lg:max-w-3xl"
      />
      <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
        {comparisonNote(analytics)} Converted visitors reached the goal in this period. Your
        server&apos;s events have no visitor, so they are not counted. A person who returns on
        another day counts again.
      </p>
    </section>
  );
}

function Trend({ days, goal = false }: { days: DayPoint[]; goal?: boolean }) {
  const metrics = goal ? GOAL_METRICS : METRICS;
  const [metric, setMetric] = React.useState<Metric>(goal ? "converted" : "visitors");
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();
  const headingId = React.useId();

  const tooltipRows = (plotted: Metric) => (index: number) => {
    const day = days[index];
    return metrics.map((item) => ({
      label: item.label,
      value: day === undefined ? MISSING : formatWhole(dayValue(day, item.key)),
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
            {metrics.find((item) => item.key === metric)?.label} per day
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {days.length >= 2 && (
              <TabsList aria-label="Metric to chart">
                {metrics.map((item) => (
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
        {metrics.map((item) => (
          <TabsContent key={item.key} value={item.key}>
            {days.length < 2 ? (
              <p className="py-8 text-center text-sm text-ink-subtle">
                A trend needs at least two days. Choose a longer period to see one.
              </p>
            ) : (
              <DayChart
                points={days.map((day) => ({ day: day.day, value: dayValue(day, item.key) }))}
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
            <caption className="sr-only">
              {goal ? "Converted visitors, visitors, visits," : "Visitors, visits,"} and pageviews
              per day
            </caption>
            <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
              <tr className="text-xs text-ink-subtle">
                <th scope="col" className="pb-2 text-left font-normal">
                  Day
                </th>
                {metrics.map((item) => (
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
                  {metrics.map((item) => (
                    <td key={item.key} className="py-1.5 text-right text-ink tabular-nums">
                      {formatWhole(dayValue(day, item.key))}
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

function Reports({ analytics, search }: { analytics: Analytics; search: PageSearch }) {
  const { breakdowns } = analytics;
  // The answer's goal, not the address's: while a new one loads, the old numbers stay.
  const goal = analytics.goal;
  // Links into the dashboard's other pages: never on a shared link.
  const { dashboard, source: reportSource } = useAnalyticsScope();
  const link: FilterLinkFor = (name, value) => (
    <FilterLink search={search} name={name} value={value} />
  );
  const eventLink = (name: string) => (
    <GoalLink search={search} goal={{ event: name }} name={name} />
  );
  const rows = (report: Breakdown) => rankedRows(report, fromBreakdown(breakdowns[report]), link);
  /** A visits tab whose list loads when it shows. */
  const lazyVisits = (value: string, label: string, nameHeading: string, report: ListReport) =>
    lazyTab(visitsTab(value, label, nameHeading, report, []), (list) =>
      rankedRows(report, list, link),
    );
  // A row without a path ("Unknown") has no page to show.
  const withHeatmaps = (list: RankedRow[]) =>
    dashboard === null
      ? list
      : list.map((row) =>
          row.key.startsWith("/")
            ? { ...row, action: dashboard.renderHeatmapLink(search, row.key) }
            : row,
        );
  const chosenEvent =
    search.goal !== undefined && "event" in search.goal ? search.goal.event : undefined;
  const eventRows = rankedRows(
    "customEvents",
    fromEvents(analytics.customEvents),
    link,
    eventLink,
  ).map((row) => {
    const name = row.title ?? row.key;
    return {
      ...row,
      action: (
        <>
          {chosenEvent === name && (
            <Badge variant="secondary" className="mr-1">
              Goal
            </Badge>
          )}
          {dashboard?.renderEventLink?.(search, name)}
        </>
      ),
    };
  });
  const card = { search, goal: goal !== null };
  const channels = lazyVisits("channel", "Channels", "Channel", "channel");
  // Filtered by one source, the card drills into it: how its visits got it, and from where.
  const source = onlyValue(search.filters, "source");
  // The How tab's own list, from the cache once it has loaded: Medium and Campaign need a tag.
  const kinds = useQuery({
    ...listPreviewQuery(
      reportSource,
      search.range,
      search.filters,
      search.environment,
      "sourceKind",
      search.goal,
    ),
    enabled: source !== undefined,
  });
  const tagged = kinds.data?.some((row) => row.name === "tag") ?? false;
  const sourceTabs: ListTab[] =
    source === undefined
      ? [
          {
            ...visitsTab("source", "Sources", "Source", "source", rows("source")),
            description:
              "A visit's source is its utm_source tag (or ref), else the referrer's site, else Direct / none.",
          },
          channels,
        ]
      : [
          {
            ...lazyVisits("how", "How", "How it came", "sourceKind"),
            description:
              source === DIRECT
                ? "Direct / none: visits with no utm_source or ref tag and no referrer from another site."
                : `${valueText("source", source)}: how its visits got this source, and their referrers.`,
          },
          lazyVisits("referrers", "Referrers", "Referrer", "referrer"),
          ...(tagged
            ? [
                lazyVisits("medium", "Medium", "UTM medium", "utmMedium"),
                visitsTab("campaign", "Campaign", "Campaign", "utmCampaign", rows("utmCampaign")),
              ]
            : []),
          channels,
        ];
  // A browser's row drills down: filtered by it, the Browsers list shows its versions.
  const browser = onlyValue(search.filters, "browser");
  const browsers =
    browser === undefined || browser === ""
      ? visitsTab("browser", "Browsers", "Browser", "browser", rows("browser"))
      : lazyVisits("browser", "Browsers", `${browser} version`, "browserVersion");
  return (
    <>
      {goal === null ? (
        <Summary analytics={analytics} />
      ) : (
        <GoalSummary analytics={analytics} goal={goal} />
      )}
      <Trend key={goal === null ? "visits" : "goal"} days={analytics.days} goal={goal !== null} />
      {/* Use content width; the sidebar takes 16rem. Three figures need half of it. */}
      <div className="@container border-t pt-5">
        <div
          className={`grid gap-x-8 gap-y-8 @3xl:grid-cols-2 ${goal === null ? "@5xl:grid-cols-3" : ""}`}
        >
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
                rows: withHeatmaps(rankedRows("pages", fromPages(analytics.pages), link)),
              },
              visitsTab("entry", "Entry", "Path", "entryPage", withHeatmaps(rows("entryPage"))),
              // The list route adds each page's exit rate, which the page's answer leaves out.
              lazyTab(
                {
                  ...visitsTab("exit", "Exit", "Path", "exitPage", []),
                  secondaryHeading: "Exits",
                  rateHeading: "Exit rate",
                },
                (list) => withHeatmaps(rankedRows("exitPage", list, link)),
              ),
              lazyVisits("hostname", "Hostnames", "Hostname", "hostname"),
            ]}
          />
          <BreakdownSection {...card} title="Sources" tabs={sourceTabs} />
          <BreakdownSection
            {...card}
            title="Campaigns"
            tabs={[
              // Each UTM tag alone; Sources mixes utm_source with referrer hosts.
              visitsTab("campaign", "Campaign", "Campaign", "utmCampaign", rows("utmCampaign")),
              lazyVisits("utm-source", "Source", "UTM source", "utmSource"),
              lazyVisits("medium", "Medium", "UTM medium", "utmMedium"),
              lazyVisits("term", "Term", "Term", "utmTerm"),
              lazyVisits("content", "Content", "Content", "utmContent"),
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
              browsers,
              visitsTab("os", "Systems", "Operating system", "os", rows("os")),
            ]}
          />
          <BreakdownSection
            {...card}
            title="Releases"
            tabs={[
              {
                // Show setup help only for the unnamed release ("Unknown").
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
            // A custom event's own numbers: a goal adds none to them.
            goal={false}
            title="Custom events"
            tabs={[
              {
                value: "events",
                label: "Custom events",
                nameHeading: "Event",
                secondaryHeading: "Events",
                empty: "No custom events in this period.",
                report: "customEvents",
                rows: eventRows,
              },
            ]}
          />
        </div>
        {/* Two per row at most: links are long, and a goal's three figures need half the width. */}
        <div className="mt-8 grid gap-x-8 gap-y-8 @3xl:grid-cols-2">
          {EVENT_SECTIONS.map((section) => (
            <BreakdownSection
              key={section.report}
              {...card}
              title={section.title}
              tabs={[
                {
                  value: section.report,
                  label: section.title,
                  nameHeading: section.nameHeading,
                  secondaryHeading: section.secondaryHeading,
                  empty: section.empty,
                  report: section.report,
                  rows: rankedRows(
                    section.report,
                    fromEventValues(analytics[section.report]),
                    link,
                  ),
                },
              ]}
            />
          ))}
        </div>
      </div>
      <GoalsSection analytics={analytics} search={search} />
    </>
  );
}

/**
 * Goals belong to product analytics (docs/access.md). They show without data too, so a project
 * can set its goals before its first event arrives. A shared link shows them, read-only, once
 * there are some: nobody there can add one.
 */
function GoalsSection({ analytics, search }: { analytics: Analytics; search: PageSearch }) {
  const { dashboard } = useAnalyticsScope();
  if (dashboard === null ? analytics.goals.length === 0 : !dashboard.showGoals) return null;
  return (
    <GoalsCard
      goals={analytics.goals}
      projectId={dashboard?.projectId ?? ""}
      // The tracker's link events can be goals too (docs/product-analytics.md, "Goals").
      eventNames={[
        ...analytics.customEvents.map((event) => event.name),
        "outbound_link",
        "file_download",
      ]}
      search={search}
    />
  );
}

/**
 * Adds the goal filter, or replaces it: the saved goals and the period's
 * custom events, so a goal is a choice away on a phone too, where the lists
 * are far down. The filter's chip shows the goal chosen and removes it.
 */
function GoalMenu({
  analytics,
  onGoal,
}: {
  analytics: Analytics | undefined;
  onGoal: (goal: GoalChoice) => void;
}) {
  const goals = analytics?.goals ?? [];
  const events = (analytics?.customEvents ?? [])
    .map((event) => event.name)
    .filter((name) => canBeGoal(name));
  if (goals.length === 0 && events.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline">
            <PlusIcon data-icon="inline-start" />
            Goal
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-auto max-w-80 min-w-48">
        {goals.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Goals</DropdownMenuLabel>
            {goals.map((goal) => (
              <DropdownMenuItem key={goal.id} onClick={() => onGoal({ id: goal.id })}>
                <span className="truncate">{goal.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {goals.length > 0 && events.length > 0 && <DropdownMenuSeparator />}
        {events.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Custom events</DropdownMenuLabel>
            {events.map((name) => (
              <DropdownMenuItem key={name} onClick={() => onGoal({ event: name })}>
                <span className="truncate">{name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

function ActiveFilters({
  search,
  analytics,
}: {
  search: PageSearch;
  analytics: Analytics | undefined;
}) {
  const { filters, goal } = search;
  if (filters.length === 0 && goal === undefined) {
    return (
      <p className="text-sm text-ink-subtle">
        No filters. Add one, or select a name in a table to filter by it.
      </p>
    );
  }
  const goalChip = goal === undefined ? undefined : goalText(goalName(goal, analytics));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ul aria-label="Filters" className="flex min-w-0 flex-wrap items-center gap-2">
        {goalChip !== undefined && (
          <li className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-sm text-ink">
            <TruncatedText text={goalChip} />

            <PageLink
              search={{ ...search, goal: undefined }}
              aria-label={`Remove the filter ${goalChip}`}
              className="rounded p-1 text-ink-subtle hover:bg-background/60 hover:text-ink"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </PageLink>
          </li>
        )}
        {filters.map((filter) => (
          <FilterChip key={`${filter.name}.${filter.operator}`} search={search} filter={filter} />
        ))}
      </ul>
      <PageLink
        search={{ ...search, filters: [], goal: undefined }}
        className="text-sm whitespace-nowrap text-link hover:underline"
      >
        Clear filters
      </PageLink>
    </div>
  );
}

function NoData({ search, otherEnvironments }: { search: PageSearch; otherEnvironments: boolean }) {
  const { dashboard } = useAnalyticsScope();
  const neverReceived = dashboard?.lastEventAt === null;
  const canInstall = dashboard?.canInstall ?? false;
  const isYear = "period" in search.range && search.range.period === "12m";
  if (!neverReceived && search.filters.length > 0) {
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
          <PageLink button={{ variant: "outline" }} search={{ ...search, filters: [] }}>
            Clear filters
          </PageLink>
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
      {neverReceived && canInstall && <EmptyContent>{dashboard?.installLink}</EmptyContent>}
      {!neverReceived && !isYear && (
        <EmptyContent>
          <PageLink
            button={{ variant: "outline" }}
            search={{ ...search, range: { period: "12m" }, filters: [] }}
          >
            Show the last 12 months
          </PageLink>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** A goal the API will not count: deleted since the link was made, or not the user's to see. */
const isGoalRefusal = (error: Error) =>
  error instanceof ApiError && (error.code === "unknown_goal" || error.status === 403);

const hasData = (analytics: Analytics) =>
  analytics.summary.pageviews > 0 ||
  analytics.summary.visits > 0 ||
  analytics.customEvents.length > 0;

/**
 * The Web analytics page, in the scope it runs in (scope.tsx): the
 * dashboard's (dashboard-analytics-page.tsx) or a shared link's (share/).
 * Use the timezone set in Settings.
 */
export function AnalyticsView({
  range,
  filters,
  environment = DEFAULT_ENVIRONMENT,
  goalSearch = {},
}: {
  range: PageRange;
  filters: Filters;
  environment?: string;
  /** The goal filter in the address (docs/web-analytics.md, "The goal filter"), unchecked. */
  goalSearch?: { goal?: string | undefined; goalEvent?: string | undefined };
}) {
  const scope = useAnalyticsScope();
  const goal = goalChoiceFrom(goalSearch);
  const analytics = useQuery(analyticsQuery(scope.source, range, filters, environment, goal));
  const search: PageSearch = { range, filters, environment, goal };
  // Preserve other filters when changing dates or environment.
  const show = (next: Partial<PageSearch>) => scope.show({ ...search, ...next });

  if (analytics.error instanceof ApiError && analytics.error.status === 404) {
    return scope.notFound;
  }

  const data = analytics.data;
  const refreshing = analytics.isPlaceholderData;

  return (
    <div className="flex flex-col">
      {scope.renderHeaderActions(environment)}
      <FilterBar
        label="Period, environment, and filters"
        period={
          <PeriodSelect range={range} answered={data} onRange={(next) => show({ range: next })} />
        }
        environment={
          // Keep the picker visible for a selected environment so the user can switch back.
          // A shared link shows its own environment only.
          data !== undefined &&
          scope.dashboard !== null && (
            <EnvironmentSelect
              environment={environment}
              answered={data}
              onEnvironment={(next) => show({ environment: next })}
            />
          )
        }
        filters={
          <>
            <AddFilter search={search} />
            <GoalMenu
              analytics={data}
              onGoal={(next) => {
                if (!sameGoal(next, goal)) show({ goal: next });
              }}
            />
            <ActiveFilters search={search} analytics={data} />
          </>
        }
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
              {goal !== undefined && isGoalRefusal(analytics.error) ? (
                <PageLink
                  button={{ variant: "outline", size: "sm" }}
                  search={{ ...search, goal: undefined }}
                >
                  Remove the goal
                </PageLink>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void analytics.refetch()}>
                  Retry
                </Button>
              )}
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
              <Reports analytics={data} search={search} />
            ) : (
              <>
                <NoData
                  search={search}
                  otherEnvironments={data.environments.some((name) => name !== environment)}
                />
                <GoalsSection analytics={data} search={search} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
