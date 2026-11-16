import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChartLineIcon,
  FilterXIcon,
  MinusIcon,
  OctagonAlertIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  activeFilters,
  type Analytics,
  analyticsQuery,
  type BreakdownRow,
  type DayPoint,
  DEFAULT_PERIOD,
  FILTER_LABELS,
  type FilterName,
  type Filters,
  isPeriod,
  PERIODS,
  type Period,
} from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type Project, projectQuery } from "@/lib/projects-api";

import { NoSuchProject } from "../projects/no-such-project";
import { DayChart } from "./day-chart";
import {
  type Change,
  countryName,
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
import { RankedList, type RankedRow } from "./ranked-list";

const METRICS = [
  { key: "visitors", label: "Visitors" },
  { key: "visits", label: "Visits" },
  { key: "pageviews", label: "Pageviews" },
] as const satisfies readonly { key: keyof DayPoint; label: string }[];

type Metric = (typeof METRICS)[number]["key"];

const isMetric = (value: unknown): value is Metric =>
  METRICS.some((metric) => metric.key === value);

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How a list row or filter names a value: a country's name, "Desktop", "Unknown" … */
function valueText(name: FilterName, value: string): string {
  if (value === "") {
    return name === "utmCampaign" ? "No campaign" : "Unknown";
  }
  if (name === "country") {
    return countryName(value);
  }
  return name === "deviceType" ? capitalize(value) : value;
}

/** "Country: Germany" */
const filterText = (name: FilterName, value: string) =>
  `${FILTER_LABELS[name]}: ${valueText(name, value)}`;

/** The page's address query: the period (left out when it is the default) and the filters. */
interface PageSearch {
  period?: Period;
  filters: Filters;
}

const searchOf = ({ period, filters }: PageSearch) => ({
  ...(period === undefined || period === DEFAULT_PERIOD ? {} : { period }),
  ...filters,
});

/** A list row's name, linking to the page filtered by it. */
function FilterLink({
  projectId,
  search,
  name,
  value,
}: {
  projectId: string;
  search: PageSearch;
  name: FilterName;
  /** "" for an unknown value. */
  value: string;
}) {
  return (
    <Link
      to="/projects/$projectId/web-analytics"
      params={{ projectId }}
      search={searchOf({ ...search, filters: { ...search.filters, [name]: value } })}
      aria-label={`Filter by ${filterText(name, value)}`}
      className={
        value === ""
          ? "text-ink-subtle hover:text-ink hover:underline"
          : "hover:text-link hover:underline"
      }
    >
      {valueText(name, value)}
    </Link>
  );
}

/** Breakdown rows for the ranked list: visitors set the bar, visits follow. */
function breakdownRows(
  rows: BreakdownRow[],
  name: FilterName,
  link: (name: FilterName, value: string) => React.ReactNode,
): RankedRow[] {
  return rows.map((row) => {
    const value = row.value ?? "";
    return {
      key: row.value ?? "\u0000unknown",
      label: link(name, value),
      title: valueText(name, value),
      primary: row.visitors,
      secondary: row.visits,
    };
  });
}

interface ListTab {
  value: string;
  label: string;
  nameHeading: string;
  secondaryHeading: string;
  empty: string;
  rows: RankedRow[];
}

/** A list of visits grouped by one property. */
function visitsTab(
  value: string,
  label: string,
  nameHeading: string,
  rows: RankedRow[],
  empty = "No visits in this period.",
): ListTab {
  return { value, label, nameHeading, secondaryHeading: "Visits", empty, rows };
}

/** A card of ranked lists; with more than one list, tabs switch between them. */
function ListCard({ title, tabs }: { title: string; tabs: ListTab[] }) {
  const lists = tabs.map((tab) => (
    <RankedList
      key={tab.value}
      rows={tab.rows}
      caption={`${tab.label}, most visitors first`}
      nameHeading={tab.nameHeading}
      primaryHeading="Visitors"
      secondaryHeading={tab.secondaryHeading}
      empty={tab.empty}
    />
  ));
  const [first] = tabs;
  if (tabs.length === 1 || first === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>{title}</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>{lists}</CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <Tabs defaultValue={first.value} className="gap-3">
        <CardHeader>
          <CardTitle>
            <h3>{title}</h3>
          </CardTitle>
          <CardAction>
            <TabsList aria-label={title}>
              {tabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </CardAction>
        </CardHeader>
        <CardContent>
          {tabs.map((tab, index) => (
            <TabsContent key={tab.value} value={tab.value}>
              {lists[index]}
            </TabsContent>
          ))}
        </CardContent>
      </Tabs>
    </Card>
  );
}

const CHANGE_ICONS = { up: ArrowUpIcon, down: ArrowDownIcon, same: MinusIcon } as const;

/** A tile's change from the period before: an arrow and a size, read out as a sentence. */
function ChangeLine({ change, before }: { change: Change; before: string }) {
  const Icon = CHANGE_ICONS[change.direction];
  const sentence =
    change.direction === "same"
      ? `No change from ${before}`
      : `${change.direction === "up" ? "Up" : "Down"} ${change.spoken} from ${before}`;
  return (
    <dd className="flex items-center gap-1 text-xs text-ink-subtle" title={`Before: ${before}`}>
      <Icon aria-hidden="true" className="size-3" />
      <span aria-hidden="true">{change.text}</span>
      <span className="sr-only">{sentence}</span>
    </dd>
  );
}

/** "Changes compare with 3–9 Nov 2026, up to 15:00 on 9 Nov." */
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

function SummaryTiles({ analytics }: { analytics: Analytics }) {
  const { summary } = analytics;
  const before = analytics.previous.summary;
  const tiles = [
    {
      label: "Visitors",
      value: formatCount(summary.visitors),
      change: relativeChange(summary.visitors, before.visitors),
      before: formatWhole(before.visitors),
    },
    {
      label: "Visits",
      value: formatCount(summary.visits),
      change: relativeChange(summary.visits, before.visits),
      before: formatWhole(before.visits),
    },
    {
      label: "Pageviews",
      value: formatCount(summary.pageviews),
      change: relativeChange(summary.pageviews, before.pageviews),
      before: formatWhole(before.pageviews),
    },
    {
      label: "Views per visit",
      value: formatRatio(summary.viewsPerVisit),
      change: relativeChange(summary.viewsPerVisit, before.viewsPerVisit),
      before: formatRatio(before.viewsPerVisit),
    },
    {
      label: "Bounce rate",
      value: formatPercent(summary.bounceRate),
      // A share changes in percentage points.
      change: pointsChange(summary.bounceRate, before.bounceRate),
      before: formatPercent(before.bounceRate),
    },
    {
      label: "Visit duration",
      value: formatDuration(summary.avgDurationMs),
      change: relativeChange(summary.avgDurationMs, before.avgDurationMs),
      before: formatDuration(before.avgDurationMs),
    },
    {
      label: "Time engaged",
      value: formatDuration(summary.avgEngagedMs),
      change: relativeChange(summary.avgEngagedMs, before.avgEngagedMs),
      before: formatDuration(before.avgEngagedMs),
    },
  ];
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 xl:grid-cols-7">
          {tiles.map((tile) => (
            <div key={tile.label} className="flex flex-col gap-1">
              <dt className="text-xs text-ink-subtle">{tile.label}</dt>
              <dd className="text-2xl font-semibold tracking-tight text-ink">{tile.value}</dd>
              {tile.change !== null && <ChangeLine change={tile.change} before={tile.before} />}
            </div>
          ))}
        </dl>
        <p className="text-xs text-ink-subtle">
          {comparisonNote(analytics)} Without cookies, a visitor is recognized for one day only, so
          a person who comes back on another day counts again. Durations are averages per visit.
        </p>
      </CardContent>
    </Card>
  );
}

function TrendCard({ days }: { days: DayPoint[] }) {
  const [metric, setMetric] = React.useState<Metric>("visitors");
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();

  const tooltipRows = (plotted: Metric) => (index: number) => {
    const day = days[index];
    return METRICS.map((item) => ({
      label: item.label,
      value: day === undefined ? "–" : formatWhole(day[item.key]),
      plotted: item.key === plotted,
    }));
  };

  return (
    <Card>
      <Tabs
        value={metric}
        onValueChange={(value) => {
          if (isMetric(value)) {
            setMetric(value);
          }
        }}
        className="gap-3"
      >
        <CardHeader>
          <CardTitle>
            <h3>{METRICS.find((item) => item.key === metric)?.label} per day</h3>
          </CardTitle>
          {days.length >= 2 && (
            <CardAction>
              <TabsList aria-label="Metric to chart">
                {METRICS.map((item) => (
                  <TabsTrigger key={item.key} value={item.key}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {METRICS.map((item) => (
            <TabsContent key={item.key} value={item.key}>
              {days.length < 2 ? (
                <p className="py-10 text-center text-sm text-ink-subtle">
                  A trend needs at least two days. Choose a longer period to see one.
                </p>
              ) : (
                <DayChart
                  points={days.map((day) => ({ day: day.day, value: day[item.key] }))}
                  label={`${item.label} per day`}
                  tooltipRows={tooltipRows(item.key)}
                />
              )}
            </TabsContent>
          ))}
          <div>
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
          <div id={tableId} hidden={!showTable} className="max-h-80 overflow-y-auto">
            {showTable && (
              <table className="w-full text-sm">
                <caption className="sr-only">Visitors, visits, and pageviews per day</caption>
                <thead className="sticky top-0 bg-card">
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
        </CardContent>
      </Tabs>
    </Card>
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
  const link = (name: FilterName, value: string) => (
    <FilterLink projectId={projectId} search={search} name={name} value={value} />
  );
  const pages: RankedRow[] = analytics.pages.map((row) => ({
    key: row.path,
    label: link("page", row.path),
    title: row.path,
    primary: row.visitors,
    secondary: row.pageviews,
  }));
  const events: RankedRow[] = analytics.customEvents.map((row) => ({
    key: row.name,
    label: row.name,
    title: row.name,
    primary: row.visitors,
    secondary: row.events,
  }));
  return (
    <>
      <SummaryTiles analytics={analytics} />
      <TrendCard days={analytics.days} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ListCard
          title="Pages"
          tabs={[
            {
              value: "top",
              label: "Top pages",
              nameHeading: "Path",
              secondaryHeading: "Views",
              empty: "No pageviews in this period.",
              rows: pages,
            },
            visitsTab(
              "entry",
              "Entry",
              "Path",
              breakdownRows(breakdowns.entryPage, "entryPage", link),
            ),
            visitsTab("exit", "Exit", "Path", breakdownRows(breakdowns.exitPage, "exitPage", link)),
          ]}
        />
        <ListCard
          title="Sources"
          tabs={[
            visitsTab(
              "source",
              "Sources",
              "Source",
              breakdownRows(breakdowns.source, "source", link),
            ),
            visitsTab(
              "campaign",
              "Campaigns",
              "Campaign",
              breakdownRows(breakdowns.utmCampaign, "utmCampaign", link),
            ),
          ]}
        />
        <ListCard
          title="Locations"
          tabs={[
            visitsTab(
              "country",
              "Countries",
              "Country",
              breakdownRows(breakdowns.country, "country", link),
            ),
            visitsTab(
              "region",
              "Regions",
              "Region",
              breakdownRows(breakdowns.region, "region", link),
            ),
            visitsTab("city", "Cities", "City", breakdownRows(breakdowns.city, "city", link)),
          ]}
        />
        <ListCard
          title="Devices"
          tabs={[
            visitsTab(
              "device",
              "Devices",
              "Device",
              breakdownRows(breakdowns.deviceType, "deviceType", link),
            ),
            visitsTab(
              "browser",
              "Browsers",
              "Browser",
              breakdownRows(breakdowns.browser, "browser", link),
            ),
            visitsTab(
              "os",
              "Systems",
              "Operating system",
              breakdownRows(breakdowns.os, "os", link),
            ),
          ]}
        />
        <ListCard
          title="Custom events"
          tabs={[
            {
              value: "events",
              label: "Custom events",
              nameHeading: "Event",
              secondaryHeading: "Events",
              empty: "No custom events in this period.",
              rows: events,
            },
          ]}
        />
      </div>
    </>
  );
}

function LoadingReports() {
  return (
    <>
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-80 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </>
  );
}

/** The active filters, each with a way to remove it, and a way to remove them all. */
function FilterBar({ projectId, search }: { projectId: string; search: PageSearch }) {
  const active = activeFilters(search.filters);
  if (active.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
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
        className="text-sm text-link hover:underline"
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
}: {
  projectId: string;
  project: Project | undefined;
  search: PageSearch;
}) {
  const neverReceived = project?.lastEventAt === null;
  const period = search.period ?? DEFAULT_PERIOD;
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
            ? "Install the tracking snippet on your site. Reports appear here as soon as the first pageview arrives."
            : "No pageviews or events arrived in this period. Choose a longer one to see earlier data."}
        </EmptyDescription>
      </EmptyHeader>
      {neverReceived && (
        <EmptyContent>
          <ButtonLink variant="outline" to="/projects/$projectId/settings" params={{ projectId }}>
            Install the snippet
          </ButtonLink>
        </EmptyContent>
      )}
      {!neverReceived && period !== "12m" && (
        <EmptyContent>
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/web-analytics"
            params={{ projectId }}
            search={searchOf({ period: "12m", filters: {} })}
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
 * all for one period that ends today in the instance's timezone.
 */
export function AnalyticsPage({
  projectId,
  period,
  filters,
}: {
  projectId: string;
  period: Period;
  filters: Filters;
}) {
  const navigate = useNavigate();
  const project = useQuery(projectQuery(projectId));
  const analytics = useQuery(analyticsQuery(projectId, period, filters));
  const search: PageSearch = { period, filters };

  if (analytics.error instanceof ApiError && analytics.error.status === 404) {
    return <NoSuchProject />;
  }

  const data = analytics.data;
  const refreshing = analytics.isPlaceholderData;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={[...PERIODS]}
          value={period}
          onValueChange={(value) => {
            if (isPeriod(value)) {
              void navigate({
                to: "/projects/$projectId/web-analytics",
                params: { projectId },
                // A new period keeps the filters.
                search: searchOf({ period: value, filters }),
              });
            }
          }}
        >
          <SelectTrigger aria-label="Period" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data !== undefined && (
          <p className="text-sm text-ink-subtle">
            {formatDayRange(data.firstDay, data.lastDay)} · {data.timeZone}
          </p>
        )}
      </div>
      <FilterBar projectId={projectId} search={search} />

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
            <NoData projectId={projectId} project={project.data} search={search} />
          )}
        </div>
      )}
    </div>
  );
}
