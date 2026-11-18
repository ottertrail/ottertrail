import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { OctagonAlertIcon, SearchXIcon } from "lucide-react";

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
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { metricsQuery } from "@/lib/metrics-api";

import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatPreciseMoment } from "./format";
import { KIND_LABELS, unitText } from "./metric-format";
import { DEFAULT_STAT, environmentSearch, metricSearchOf, rangeSearch } from "./search";
import { SendTelemetry } from "./send-telemetry";

/** The project's metrics in a period and environment, by name; each opens its chart. */
export function MetricsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const list = useQuery(metricsQuery(projectId, range, environment));
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/metrics",
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
            {data === undefined ? "The metrics could not load" : "The metrics could not refresh"}
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
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )
      ) : !data.received ? (
        <SendTelemetry projectId={projectId} signal="metrics" retentionDays={data.retentionDays} />
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={list.isPlaceholderData}
          aria-busy={list.isPlaceholderData}
        >
          {data.metrics.length === 0 ? (
            <Empty className="border border-dashed p-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon />
                </EmptyMedia>
                <EmptyTitle>No metrics in this period</EmptyTitle>
                <EmptyDescription>
                  No data point arrived
                  {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period.
                  Metrics are kept {data.retentionDays} days.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <Table>
                <caption className="sr-only">Metrics, by name</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Services</TableHead>
                    <TableHead>Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.metrics.map((metric) => (
                    <TableRow key={`${metric.kind} ${metric.name}`}>
                      <TableCell className="max-w-sm">
                        {metric.name === "" ? (
                          <span className="text-ink-subtle">(no name)</span>
                        ) : (
                          <Link
                            to="/projects/$projectId/metrics/$name"
                            params={{ projectId, name: metric.name }}
                            search={metricSearchOf({
                              range,
                              environment,
                              kind: metric.kind,
                              split: undefined,
                              stat: DEFAULT_STAT[metric.kind],
                            })}
                            className="block truncate font-mono text-xs text-link hover:underline"
                            title={metric.name}
                          >
                            {metric.name}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell>{KIND_LABELS[metric.kind]}</TableCell>
                      <TableCell className="max-w-32 truncate">
                        {unitText(metric.unit) === "" ? (
                          <span className="text-ink-subtle">–</span>
                        ) : (
                          unitText(metric.unit)
                        )}
                      </TableCell>
                      <TableCell className="max-w-64 truncate" title={metric.services.join(", ")}>
                        {metric.services.join(", ")}
                        {metric.serviceCount > metric.services.length &&
                          ` and ${metric.serviceCount - metric.services.length} more`}
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        <time dateTime={metric.lastSeen}>
                          {formatPreciseMoment(metric.lastSeen, data.timeZone)}
                        </time>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.truncated && (
                <p className="text-sm text-ink-subtle">
                  The project sent more than {data.metrics.length.toLocaleString("en-US")} metrics
                  in this period: these are the first by name.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
