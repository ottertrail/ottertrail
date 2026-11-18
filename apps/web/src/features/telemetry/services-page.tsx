import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BellPlusIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type RouteStats, servicesQuery } from "@/lib/services-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatDuration } from "./format";
import { servicesSearchOf, tracesSearchOf } from "./search";
import { SendTelemetry } from "./send-telemetry";

/** The longest name the Traces page's filter takes. */
const MAX_NAME_FILTER = 200;

/** Requests, the share failed, and the durations, as cells of a row. */
function StatCells({ stats }: { stats: RouteStats }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatWhole(stats.requests)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {stats.requests === 0 ? "–" : formatConversion(stats.failed / stats.requests)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatDuration(stats.p50Us)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatDuration(stats.p95Us)}</TableCell>
    </>
  );
}

/** The Alerts page's address that opens the form for a route rule, filled in. */
const addRuleSearch = (environment: string, service: string, route?: string) => ({
  add: "route_latency" as const,
  service,
  ...(route === undefined || route === "" ? {} : { route }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
});

/**
 * Each service of the project, busiest first, with its server spans'
 * routes: requests, the share that failed, and the median and 95th
 * percentile duration. A route opens the Traces page filtered by it, and
 * each service and route links to a new alert rule on it. An address
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
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />

      {list.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined ? "The services could not load" : "The services could not refresh"}
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
                  {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period.
                  A request is a span of kind SERVER. Traces are kept {data.retentionDays} days.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <p className="text-sm text-ink-subtle">
                A request is a span of kind SERVER; its route is its{" "}
                <code className="font-mono">http.route</code> attribute, or its name. Failed: its
                status is Error. The median and 95th percentile are of the requests&apos; durations.
              </p>
              {shown.map((service) => (
                <Card key={service.service}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="break-all">{service.service}</h3>
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
                    </CardTitle>
                    <CardDescription>
                      {formatWhole(service.requests)}{" "}
                      {service.requests === 1 ? "request" : "requests"},{" "}
                      {formatConversion(service.failed / service.requests)} failed, median{" "}
                      {formatDuration(service.p50Us)}, 95th percentile{" "}
                      {formatDuration(service.p95Us)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <Table>
                      <caption className="sr-only">
                        Routes of {service.service}, busiest first
                      </caption>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Route</TableHead>
                          <TableHead className="text-right">Requests</TableHead>
                          <TableHead className="text-right">Failed</TableHead>
                          <TableHead className="text-right">Median</TableHead>
                          <TableHead className="text-right">95th percentile</TableHead>
                          <TableHead>
                            <span className="sr-only">Alert rule</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {service.routes.map((route) => (
                          <TableRow
                            key={route.route}
                            aria-current={
                              only === service.service && marked === route.route
                                ? "true"
                                : undefined
                            }
                            className="aria-[current=true]:bg-muted"
                          >
                            <TableCell className="max-w-md">
                              <Link
                                to="/projects/$projectId/traces"
                                params={{ projectId }}
                                search={tracesSearchOf({
                                  range,
                                  environment,
                                  filters: {
                                    service: service.service,
                                    name:
                                      route.route.trim() === "" ||
                                      route.route.length > MAX_NAME_FILTER
                                        ? undefined
                                        : route.route.trim(),
                                  },
                                })}
                                className="block truncate font-mono text-xs text-link hover:underline"
                                title={`Traces of ${service.service} named like ${route.route}`}
                              >
                                {route.route === "" ? "(no name)" : route.route}
                              </Link>
                            </TableCell>
                            <StatCells stats={route} />
                            <TableCell>
                              {/* A route without a name cannot be named in a rule. */}
                              {route.route.trim() !== "" && (
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
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
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
                        The {formatWhole(service.routes.length)} busiest of{" "}
                        {formatWhole(service.routeCount)} routes.
                      </p>
                    )}
                  </CardContent>
                </Card>
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
  );
}
