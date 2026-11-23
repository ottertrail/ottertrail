import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { Missing } from "@/components/missing";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { TruncatedText } from "@/components/truncated-text";
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

import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatPreciseMoment } from "./format";
import { KIND_LABELS, unitText } from "./metric-format";
import { MetricSparkline, SPARKLINE_MAX_DAYS } from "./metric-sparkline";
import { DEFAULT_STAT, environmentSearch, metricSearchOf, rangeSearch } from "./search";
import { SendTelemetry } from "./send-telemetry";

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
  const days =
    data === undefined
      ? 0
      : (Date.parse(data.lastDay) - Date.parse(data.firstDay)) / 86_400_000 + 1;

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
          <SendTelemetry
            projectId={projectId}
            signal="metrics"
            retentionDays={data.retentionDays}
          />
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
                    {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this
                    period. Metrics are kept {data.retentionDays} days.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ScrollHint>
                  <Table className="max-sm:min-w-[52rem]">
                    <caption className="sr-only">Metrics, by name</caption>
                    <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
                      <TableRow>
                        <TableHead className={`pl-0 ${PINNED}`}>Metric</TableHead>
                        <TableHead>Over the period</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead>Services</TableHead>
                        <TableHead>Last seen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.metrics.map((metric) => (
                        <TableRow
                          key={`${metric.kind} ${metric.name}`}
                          {...clickableRow(undefined, metric.name !== "")}
                        >
                          <TableCell className={`max-w-sm pl-0 max-sm:max-w-48 ${PINNED}`}>
                            {metric.name === "" ? (
                              <span className="text-ink-subtle">(no name)</span>
                            ) : (
                              <TruncatedText
                                text={metric.name}
                                className="font-mono text-xs text-link hover:underline"
                                render={
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
                                    {...ROW_LINK}
                                  />
                                }
                              />
                            )}
                          </TableCell>
                          <TableCell className="w-28">
                            <MetricSparkline
                              projectId={projectId}
                              range={range}
                              environment={environment}
                              metric={metric}
                              days={list.isPlaceholderData ? undefined : days}
                            />
                          </TableCell>
                          <TableCell>{KIND_LABELS[metric.kind]}</TableCell>
                          <TableCell className="max-w-32">
                            {unitText(metric.unit) === "" ? (
                              <Missing label="No unit" className="text-ink-subtle" />
                            ) : (
                              <TruncatedText text={unitText(metric.unit)} />
                            )}
                          </TableCell>
                          <TableCell className="max-w-64">
                            <TruncatedText
                              text={`${metric.services.join(", ")}${
                                metric.serviceCount > metric.services.length
                                  ? ` and ${metric.serviceCount - metric.services.length} more`
                                  : ""
                              }`}
                              lines={[
                                ...metric.services,
                                ...(metric.serviceCount > metric.services.length
                                  ? [`and ${metric.serviceCount - metric.services.length} more`]
                                  : []),
                              ]}
                            />
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
                </ScrollHint>
                <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
                  Each line shows the metric over the period, as its chart opens: a gauge&apos;s
                  average, an up-down counter&apos;s total, a counter&apos;s rate per second, and a
                  histogram&apos;s 95th percentile. Each line has its own scale, from its lowest to
                  its highest value, and the dot is the latest. A dash means nothing to draw. Lines
                  are drawn for periods of up to {SPARKLINE_MAX_DAYS} days.
                </p>
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
    </div>
  );
}
