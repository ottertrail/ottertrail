import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BellPlusIcon,
  OctagonAlertIcon,
  SearchXIcon,
  WaypointsIcon,
} from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { WhenAllowed } from "@/components/when-allowed";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type ServiceChart, serviceChartQuery, STATUS_CLASSES } from "@/lib/services-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChartCard } from "./chart-card";
import { stepText } from "./chart-time";
import { formatDuration } from "./format";
import { durationFormat, formatNumber } from "./metric-format";
import {
  addRuleSearch,
  routeTraceFilters,
  serviceSearchOf,
  servicesSearchOf,
  tracesSearchOf,
} from "./search";
import { SLOTS } from "./split-colors";
import { StatusBar, StatusLegend } from "./status-classes";
import { STATUS_COLORS, STATUS_LABELS } from "./status-format";
import type { ChartLine } from "./time-chart";

const formatShare = (percent: number) => `${formatNumber(percent)}%`;

/** The charts of one service's or route's requests over the period. */
function Charts({ data, subject }: { data: ServiceChart; subject: string }) {
  const step = stepText(data.stepSeconds);
  const classes = STATUS_CLASSES.filter((name) => data.totals.statuses[name] > 0);
  const requestLines: ChartLine[] = classes.map((name) => ({
    key: name,
    label: STATUS_LABELS[name],
    color: STATUS_COLORS[name],
    values: data.perSecond[name],
  }));
  const failedLines: ChartLine[] = [
    {
      key: "failed",
      label: "Failed",
      // Slots the status classes (chart-1 to chart-4) never use on this page.
      color: SLOTS[4] ?? "",
      values: data.failedShare.map((share) => (share === null ? null : share * 100)),
    },
  ];
  const duration = durationFormat(data.durations.p99Us);
  const durationLines: ChartLine[] = [
    { key: "p50", label: "Median", values: data.durations.p50Us },
    { key: "p95", label: "95th percentile", values: data.durations.p95Us },
    { key: "p99", label: "99th percentile", values: data.durations.p99Us },
  ].map((line, index) => ({ ...line, color: SLOTS[index + 5] ?? "" }));
  return (
    <div className="grid gap-4">
      <ChartCard
        title="Requests per second"
        description={`Per ${step}, by status class: ${classes.map((name) => STATUS_LABELS[name]).join(", ")}.`}
        frame={data}
        subject={subject}
        lines={requestLines}
        formatValue={(value) => `${formatNumber(value)}/s`}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Failed (%)"
          description={`The share of requests with status Error, per ${step}; a gap where no request arrived.`}
          frame={data}
          subject={subject}
          lines={failedLines}
          formatValue={formatShare}
          domain={{ min: 0, max: 100 }}
        />
        <ChartCard
          title={`Duration (${duration.unit})`}
          description={`The median, 95th, and 99th percentile of the requests' durations, per ${step}.`}
          frame={data}
          subject={subject}
          lines={durationLines}
          formatValue={duration.format}
        />
      </div>
    </div>
  );
}

/** The period's totals, as on the Services page, with the requests by status class as a bar and a table. */
function Totals({ data, subject }: { data: ServiceChart; subject: string }) {
  const { totals } = data;
  const figures = [
    ["Requests", formatWhole(totals.requests)],
    ["Failed", formatConversion(totals.failed / totals.requests)],
    ["Median", formatDuration(totals.p50Us)],
    ["95th percentile", formatDuration(totals.p95Us)],
    ["99th percentile", formatDuration(totals.p99Us)],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>In this period</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {figures.map(([name, value]) => (
            <div key={name} className="flex flex-col gap-1">
              <dt className="text-xs text-ink-subtle">{name}</dt>
              <dd className="text-lg font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-2">
          <StatusLegend />
          <StatusBar statuses={totals.statuses} label={`Status classes of ${subject}`} />
        </div>
        <table className="w-full max-w-md text-sm">
          <caption className="sr-only">Requests by status class</caption>
          <thead>
            <tr className="text-xs text-ink-subtle">
              <th scope="col" className="pb-2 text-left font-normal">
                Status class
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                Requests
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {STATUS_CLASSES.map((name) => (
              <tr key={name} className="border-t border-hairline">
                <th scope="row" className="py-1.5 text-left font-normal text-ink">
                  {STATUS_LABELS[name]}
                </th>
                <td className="py-1.5 text-right text-ink tabular-nums">
                  {formatWhole(totals.statuses[name])}
                </td>
                <td className="py-1.5 text-right text-ink tabular-nums">
                  {formatConversion(totals.statuses[name] / totals.requests)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/**
 * One service's requests, or one of its routes', over the period: the
 * totals the Services page shows, then requests per second by status
 * class, the failed share, and the median, 95th, and 99th percentile, in
 * the time buckets the API chose. Links to the requests' traces and to a
 * new alert rule on them.
 */
export function ServicePage({
  projectId,
  service,
  route,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  service: string;
  route?: string | undefined;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const chart = useQuery(serviceChartQuery(projectId, range, environment, service, route));
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/services/$service",
      params: { projectId, service },
      search: serviceSearchOf({
        range: next.range ?? range,
        environment: next.environment ?? environment,
        route,
      }),
    });

  if (chart.error instanceof ApiError && chart.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = chart.data;
  const subject = route === undefined ? service : `${route} in ${service}`;
  const linkClass = "flex items-center gap-1 text-sm text-link hover:underline";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            to="/projects/$projectId/services"
            params={{ projectId }}
            search={servicesSearchOf({ range, environment })}
            className={linkClass}
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            All services
          </Link>
          {route !== undefined && (
            <Link
              to="/projects/$projectId/services/$service"
              params={{ projectId, service }}
              search={serviceSearchOf({ range, environment })}
              className={`${linkClass} break-all`}
            >
              Every route of {service}
            </Link>
          )}
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-mono text-lg font-medium break-all text-ink">{route ?? service}</h2>
            <p className="text-sm text-ink-subtle">
              {route === undefined ? (
                "A service: every route of its server spans."
              ) : (
                <>
                  A route of <span className="font-mono break-all">{service}</span>: its{" "}
                  <code className="font-mono">http.route</code> attribute, or its span&apos;s name.
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              to="/projects/$projectId/traces"
              params={{ projectId }}
              search={tracesSearchOf({
                range,
                environment,
                filters: routeTraceFilters(service, route),
              })}
              className={linkClass}
            >
              <WaypointsIcon aria-hidden="true" className="size-4" />
              Traces
              <span className="sr-only"> of {subject}</span>
            </Link>
            <WhenAllowed area="uptime_alerts" level="manage">
              <Link
                to="/projects/$projectId/alerts"
                params={{ projectId }}
                search={addRuleSearch(environment, service, route)}
                className={linkClass}
              >
                <BellPlusIcon aria-hidden="true" className="size-4" />
                Add an alert rule
                <span className="sr-only"> for {subject}</span>
              </Link>
            </WhenAllowed>
          </div>
        </div>
      </div>

      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />

      {chart.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined ? "The charts could not load" : "The charts could not refresh"}
          </AlertTitle>
          <AlertDescription>
            {chart.error.message}
            {data !== undefined && " The charts below are from the last successful load."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void chart.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {data === undefined ? (
        !chart.isError && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        )
      ) : data.totals.requests === 0 ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>No requests in this period</EmptyTitle>
            <EmptyDescription>
              No server span of {subject} arrived
              {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period.
              Traces are kept {data.retentionDays} days.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={chart.isPlaceholderData}
          aria-busy={chart.isPlaceholderData}
        >
          <Totals data={data} subject={subject} />
          <Charts data={data} subject={subject} />
        </div>
      )}
    </div>
  );
}
