import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { OctagonAlertIcon, SearchXIcon } from "lucide-react";

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
import { environmentSearch, rangeSearch, tracesSearchOf } from "./search";
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

/**
 * Each service of the project, busiest first, with its server spans'
 * routes: requests, the share that failed, and the median and 95th
 * percentile duration. A route opens the Traces page filtered by it.
 */
export function ServicesPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const list = useQuery(servicesQuery(projectId, range, environment));
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/services",
      params: { projectId },
      search: {
        ...rangeSearch(next.range ?? range),
        ...environmentSearch(next.environment ?? environment),
      },
    });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;

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
          {data.services.length === 0 ? (
            <Empty className="border border-dashed p-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon />
                </EmptyMedia>
                <EmptyTitle>No requests in this period</EmptyTitle>
                <EmptyDescription>
                  No server span arrived
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
              {data.services.map((service) => (
                <Card key={service.service}>
                  <CardHeader>
                    <CardTitle>
                      <h3 className="break-all">{service.service}</h3>
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
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {service.routes.map((route) => (
                          <TableRow key={route.route}>
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
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
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
