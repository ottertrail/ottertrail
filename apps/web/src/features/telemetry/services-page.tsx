import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BellPlusIcon, OctagonAlertIcon, SearchXIcon, WaypointsIcon } from "lucide-react";
import * as React from "react";

import { PINNED, PINNED_END } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WhenAllowed } from "@/components/when-allowed";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { MISSING } from "@/lib/missing";
import {
  type RouteStats,
  STATUS_CLASSES,
  type ServiceSummary,
  servicesQuery,
} from "@/lib/services-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatDuration } from "./format";
import {
  addRuleSearch,
  isLinkableService,
  isNamedRoute,
  routeTraceFilters,
  serviceSearchOf,
  servicesSearchOf,
  tracesSearchOf,
} from "./search";
import { SendTelemetry } from "./send-telemetry";
import { StatusBar, StatusLegend } from "./status-classes";
import { STATUS_LABELS } from "./status-format";

/** A pinned cell of the marked row keeps the row's highlight, over its own opaque surface. */
const MARKED = "max-sm:group-aria-[current=true]/row:bg-muted";

/**
 * Requests, the share failed, the durations, and the requests by status
 * class, as cells of a row: a bar, or each class's count when the numbers
 * are shown.
 */
function StatCells({
  stats,
  label,
  numbers,
}: {
  stats: RouteStats;
  label: string;
  numbers: boolean;
}) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatWhole(stats.requests)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {stats.requests === 0 ? MISSING : formatConversion(stats.failed / stats.requests)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatDuration(stats.p50Us)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatDuration(stats.p95Us)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatDuration(stats.p99Us)}</TableCell>
      {numbers ? (
        STATUS_CLASSES.map((name) => (
          <TableCell key={name} className="text-right tabular-nums">
            {formatWhole(stats.statuses[name])}
          </TableCell>
        ))
      ) : (
        <TableCell className="w-32">
          <StatusBar statuses={stats.statuses} label={`Status classes of ${label}`} />
        </TableCell>
      )}
    </>
  );
}

/** One service's card: its numbers, and a table of its routes. */
function ServiceCard({
  projectId,
  range,
  environment,
  service,
  only,
  marked,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  service: ServiceSummary;
  only: string | undefined;
  marked: string | undefined;
}) {
  const [numbers, setNumbers] = React.useState(false);
  const tableId = React.useId();
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 border-t pt-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={headingId} className="text-base font-medium break-all text-ink">
            {isLinkableService(service.service) ? (
              <Link
                to="/projects/$projectId/services/$service"
                params={{ projectId, service: service.service }}
                search={serviceSearchOf({ range, environment })}
                className="text-link hover:underline"
              >
                {service.service}
              </Link>
            ) : (
              // A browser drops "." and ".." from a path: no page can be addressed for them.
              service.service
            )}
          </h3>
          <WhenAllowed area="uptime_alerts" level="manage">
            <Link
              to="/projects/$projectId/alerts"
              params={{ projectId }}
              search={addRuleSearch(environment, service.service)}
              className="flex items-center gap-1 text-sm font-normal text-link hover:underline"
            >
              <BellPlusIcon aria-hidden="true" className="size-4" />
              Add an alert rule
              <span className="sr-only"> for {service.service}</span>
            </Link>
          </WhenAllowed>
        </div>
        <div className="flex flex-col gap-2 text-sm text-ink-subtle">
          <span>
            {formatWhole(service.requests)} {service.requests === 1 ? "request" : "requests"},{" "}
            {formatConversion(service.failed / service.requests)} failed, median{" "}
            {formatDuration(service.p50Us)}, 95th percentile {formatDuration(service.p95Us)}, 99th
            percentile {formatDuration(service.p99Us)}
          </span>
          <StatusBar
            statuses={service.statuses}
            label={`Status classes of ${service.service}`}
            className="max-w-sm"
          />
        </div>
      </div>
      <ScrollHint>
        <Table id={tableId} className="max-sm:min-w-[40rem]">
          <caption className="sr-only">Routes of {service.service}, busiest first</caption>
          <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
            <TableRow>
              <TableHead className={`pl-0 ${PINNED}`}>Route</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Median</TableHead>
              <TableHead className="text-right">95th percentile</TableHead>
              <TableHead className="text-right">99th percentile</TableHead>
              {numbers ? (
                STATUS_CLASSES.map((name) => (
                  <TableHead key={name} className="text-right">
                    {STATUS_LABELS[name]}
                  </TableHead>
                ))
              ) : (
                <TableHead>Status classes</TableHead>
              )}
              <TableHead className={PINNED_END}>
                <span className="sr-only">Traces and alert rule</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {service.routes.map((route) => (
              <TableRow
                key={route.route}
                aria-current={
                  only === service.service && marked === route.route ? "true" : undefined
                }
                className="group/row aria-[current=true]:bg-muted"
              >
                <TableCell className={`max-w-md pl-0 ${PINNED} ${MARKED}`}>
                  {!isNamedRoute(route.route) || !isLinkableService(service.service) ? (
                    // A route without a name (or only spaces) has no page: its address could not name it.
                    <span className="block truncate font-mono text-xs text-ink-subtle">
                      {isNamedRoute(route.route) ? route.route : "(no name)"}
                    </span>
                  ) : (
                    <Link
                      to="/projects/$projectId/services/$service"
                      params={{ projectId, service: service.service }}
                      search={serviceSearchOf({ range, environment, route: route.route })}
                      className="block truncate font-mono text-xs text-link hover:underline"
                      title={route.route}
                    >
                      {route.route}
                    </Link>
                  )}
                </TableCell>
                <StatCells
                  stats={route}
                  label={isNamedRoute(route.route) ? route.route : "(no name)"}
                  numbers={numbers}
                />
                <TableCell className={`${PINNED_END} ${MARKED}`}>
                  <span className="flex items-center gap-1">
                    <Link
                      to="/projects/$projectId/traces"
                      params={{ projectId }}
                      search={tracesSearchOf({
                        range,
                        environment,
                        filters: routeTraceFilters(service.service, route.route),
                      })}
                      aria-label={`Traces of ${isNamedRoute(route.route) ? route.route : "(no name)"} in ${service.service}`}
                      title="Traces"
                      className="inline-flex size-7 items-center justify-center rounded-md text-ink-subtle hover:bg-muted hover:text-ink"
                    >
                      <WaypointsIcon aria-hidden="true" className="size-4" />
                    </Link>
                    {/* A route without a name cannot be named in a rule. */}
                    {isNamedRoute(route.route) && (
                      <WhenAllowed area="uptime_alerts" level="manage">
                        <Link
                          to="/projects/$projectId/alerts"
                          params={{ projectId }}
                          search={addRuleSearch(environment, service.service, route.route)}
                          aria-label={`Add an alert rule for ${route.route} in ${service.service}`}
                          title="Add an alert rule"
                          className="inline-flex size-7 items-center justify-center rounded-md text-ink-subtle hover:bg-muted hover:text-ink"
                        >
                          <BellPlusIcon aria-hidden="true" className="size-4" />
                        </Link>
                      </WhenAllowed>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollHint>
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5"
          aria-expanded={numbers}
          aria-controls={tableId}
          onClick={() => setNumbers((shown) => !shown)}
        >
          {numbers ? "Show status classes as bars" : "Show status classes as numbers"}
        </Button>
      </div>
      {only === service.service &&
        marked !== undefined &&
        !service.routes.some((route) => route.route === marked) && (
          <p className="text-sm text-ink-subtle">
            {service.routeCount > service.routes.length
              ? `The route ${marked} is not among the ${formatWhole(service.routes.length)} busiest listed here.`
              : `No request of the route ${marked} arrived in this period.`}
          </p>
        )}
      {service.routeCount > service.routes.length && (
        <p className="text-sm text-ink-subtle">
          The {formatWhole(service.routes.length)} busiest of {formatWhole(service.routeCount)}{" "}
          routes.
        </p>
      )}
    </section>
  );
}

/**
 * Each service of the project, busiest first, with its server spans'
 * routes: requests, the share that failed, the median, 95th, and 99th
 * percentile duration, and the requests by status class. A service or
 * route opens its page of charts; each route links to its traces, and
 * each service and route to a new alert rule on it. An address
 * that names a service (as an alert's link does) shows only it, its
 * route marked.
 */
export function ServicesPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  service: only,
  route: marked,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  service?: string | undefined;
  route?: string | undefined;
}) {
  const navigate = useNavigate();
  const list = useQuery(servicesQuery(projectId, range, environment));
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/services",
      params: { projectId },
      search: servicesSearchOf({
        range: next.range ?? range,
        environment: next.environment ?? environment,
        service: only,
        route: marked,
      }),
    });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;
  const shown =
    only === undefined
      ? (data?.services ?? [])
      : (data?.services ?? []).filter((item) => item.service === only);

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
        {list.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined
                ? "The services could not load"
                : "The services could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {list.error.message}
              {data !== undefined && " The list below is from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {data === undefined ? (
          !list.isError && (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : !data.received ? (
          <SendTelemetry projectId={projectId} signal="traces" retentionDays={data.retentionDays} />
        ) : (
          <div
            className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
            data-stale={list.isPlaceholderData}
            aria-busy={list.isPlaceholderData}
          >
            {only !== undefined && (
              <p className="text-sm text-ink-subtle">
                Only <span className="font-mono">{only}</span>
                {marked === undefined ? "" : ", its route marked"}.{" "}
                <Link
                  to="/projects/$projectId/services"
                  params={{ projectId }}
                  search={servicesSearchOf({ range, environment })}
                  className="text-link hover:underline"
                >
                  Show all services
                </Link>
              </p>
            )}
            {shown.length === 0 && only !== undefined && data.truncated ? (
              <Empty className="border border-dashed p-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchXIcon />
                  </EmptyMedia>
                  <EmptyTitle>{only} is not in the list</EmptyTitle>
                  <EmptyDescription>
                    More than {formatWhole(data.services.length)} services sent requests in this
                    period, and the list holds the first by name: {only} may be among the rest. Its
                    requests are on the Traces page.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : shown.length === 0 ? (
              <Empty className="border border-dashed p-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchXIcon />
                  </EmptyMedia>
                  <EmptyTitle>No requests in this period</EmptyTitle>
                  <EmptyDescription>
                    No server span
                    {only === undefined ? "" : ` of ${only}`} arrived
                    {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this
                    period. A request is a span of kind SERVER. Traces are kept {data.retentionDays}{" "}
                    days.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
                  A request is a span of kind SERVER. Its route is its{" "}
                  <code className="font-mono">http.route</code> attribute, or its name if the
                  attribute is absent. Failed means its status is Error. The median, 95th, and 99th
                  percentile measure request durations. A status class comes from{" "}
                  <code className="font-mono">http.response.status_code</code>, else{" "}
                  <code className="font-mono">http.status_code</code>. Select a service or route to
                  open its charts for the period.
                </p>
                <StatusLegend />
                {shown.map((service) => (
                  <ServiceCard
                    key={service.service}
                    projectId={projectId}
                    range={range}
                    environment={environment}
                    service={service}
                    only={only}
                    marked={marked}
                  />
                ))}
                {data.truncated && (
                  <p className="text-sm text-ink-subtle">
                    More than {formatWhole(data.services.length)} services sent requests: these are
                    the first by name.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
