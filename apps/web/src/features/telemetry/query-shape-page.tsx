import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { PageTitle } from "@/components/page-header";
import { PINNED, PINNED_END } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { StatStrip } from "@/components/stat-strip";
import { StatusBadge } from "@/components/status-badge";
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
import {
  canonicalShapeId,
  isShapeId,
  type ShapeDetail,
  type ShapeKind,
  shapeQuery,
} from "@/lib/databases-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChartSection } from "./chart-card";
import { stepText } from "./chart-time";
import { databaseLabel, formatFailed, formatPerSecond } from "./database-format";
import { formatDuration, formatPreciseMoment } from "./format";
import { durationFormat, formatNumber } from "./metric-format";
import {
  databasesSearchOf,
  isLinkableService,
  isNamedRoute,
  serviceSearchOf,
  shapeSearchOf,
} from "./search";
import { SLOTS } from "./split-colors";
import type { ChartLine } from "./time-chart";

const KIND_TEXT: Record<ShapeKind, React.ReactNode> = {
  summary: (
    <>
      The <code className="font-mono">db.query.summary</code> the calls sent.
    </>
  ),
  query: (
    <>
      The calls' query text (<code className="font-mono">db.query.text</code>, or the older{" "}
      <code className="font-mono">db.statement</code>), normalized with string literals, number
      literals, and IN lists replaced by <code className="font-mono">?</code>. Comments are removed.
      Whitespace is collapsed. Text is limited to 1,000 characters.
    </>
  ),
  operation: (
    <>
      The calls sent no query text: their operation and collection (
      <code className="font-mono">db.operation.name</code>,{" "}
      <code className="font-mono">db.collection.name</code>, or the older names), or their
      span&apos;s name.
    </>
  ),
};

const formatShare = (percent: number) => `${formatNumber(percent)}%`;

/** Match service chart color slots: calls 1, failure share 5, percentiles 6 to 8. */
function Charts({ data, subject }: { data: ShapeDetail; subject: string }) {
  const step = stepText(data.stepSeconds);
  const duration = durationFormat(data.durations.p99Us);
  const durationLines: ChartLine[] = [
    { key: "p50", label: "Median", values: data.durations.p50Us },
    { key: "p95", label: "95th percentile", values: data.durations.p95Us },
    { key: "p99", label: "99th percentile", values: data.durations.p99Us },
  ].map((line, index) => ({ ...line, color: SLOTS[index + 5] ?? "" }));
  return (
    <>
      <ChartSection
        title="Calls per second"
        description={`Per ${step}.`}
        frame={data}
        subject={subject}
        lines={[{ key: "calls", label: "Calls", color: SLOTS[0] ?? "", values: data.perSecond }]}
        formatValue={(value) => `${formatNumber(value)}/s`}
      />
      <ChartSection
        title="Failed (%)"
        description={`The share of calls with status Error, per ${step}. A gap means no call was made.`}
        frame={data}
        subject={subject}
        lines={[
          {
            key: "failed",
            label: "Failed",
            color: SLOTS[4] ?? "",
            values: data.failedShare.map((share) => (share === null ? null : share * 100)),
          },
        ]}
        formatValue={formatShare}
        domain={{ min: 0, max: 100 }}
      />
      <ChartSection
        title={`Duration (${duration.unit})`}
        description={`The median, 95th, and 99th percentile of the calls' durations, per ${step}.`}
        frame={data}
        subject={subject}
        lines={durationLines}
        formatValue={duration.format}
      />
    </>
  );
}

function Totals({ data }: { data: ShapeDetail }) {
  const { totals } = data;
  const figures = [
    ["Calls", formatWhole(totals.calls)],
    ["Per second", formatPerSecond(totals.perSecond)],
    ["Total time", formatDuration(totals.totalUs)],
    ["Failed", formatFailed(totals)],
    ["Median", formatDuration(totals.p50Us)],
    ["95th percentile", formatDuration(totals.p95Us)],
    ["99th percentile", formatDuration(totals.p99Us)],
  ] as const;
  return (
    <section aria-labelledby="shape-totals" className="flex flex-col gap-3">
      <h3 id="shape-totals" className="text-sm font-medium text-ink">
        In this period
      </h3>
      <StatStrip label="Totals" stats={figures.map(([label, value]) => ({ label, value }))} />
    </section>
  );
}

function ServiceLink({
  projectId,
  service,
  route,
  range,
  environment,
}: {
  projectId: string;
  service: string;
  route?: string | undefined;
  range: PageRange;
  environment: string;
}) {
  const text = route ?? service;
  if (!isLinkableService(service) || (route !== undefined && !isNamedRoute(route))) {
    return <span className="font-mono text-xs break-all">{text}</span>;
  }
  return (
    <Link
      to="/projects/$projectId/services/$service"
      params={{ projectId, service }}
      search={serviceSearchOf({ range, environment, route })}
      className="font-mono text-xs break-all text-link hover:underline"
    >
      {text}
    </Link>
  );
}

export function QueryShapePage({
  projectId,
  shapeId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  shapeId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const valid = isShapeId(shapeId);
  // The API normalizes equivalent shape IDs, such as 007 and 7, to 7.
  const id = valid ? canonicalShapeId(shapeId) : shapeId;
  const detail = useQuery({
    ...shapeQuery(projectId, range, environment, id),
    enabled: valid,
  });
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/databases/$shapeId",
      params: { projectId, shapeId },
      search: shapeSearchOf({
        range: next.range ?? range,
        environment: next.environment ?? environment,
      }),
    });

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = detail.data;
  const shape = data?.shape ?? null;
  const subject = shape === null ? "this query shape" : databaseLabel(shape.system, shape.database);
  const shapeTitle = shape === null ? "Query shape" : `Query shape in ${subject}`;
  const linkClass = "flex items-center gap-1 text-sm text-link hover:underline";

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
        <div className="flex flex-col gap-2">
          <nav aria-label="Breadcrumb">
            <Link
              to="/projects/$projectId/databases"
              params={{ projectId }}
              search={databasesSearchOf({ range, environment })}
              className={linkClass}
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
              All databases
            </Link>
          </nav>
          <PageTitle title={shapeTitle} />
          {shape !== null && (
            <>
              <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-ink ring-1 ring-border">
                {shape.text}
              </pre>
              <p className="text-sm text-ink-subtle">{KIND_TEXT[shape.kind]}</p>
            </>
          )}
        </div>

        {!valid && (
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon />
              </EmptyMedia>
              <EmptyTitle>Not a query shape</EmptyTitle>
              <EmptyDescription>
                This address does not name a query shape. Shapes are listed on the Databases page.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {valid && detail.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined
                ? "The query shape could not load"
                : "The query shape could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {detail.error.message}
              {data !== undefined && " The page below is from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {!valid ? null : data === undefined ? (
          !detail.isError && (
            <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
            </div>
          )
        ) : data.totals.calls === 0 ? (
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon />
              </EmptyMedia>
              <EmptyTitle>No calls of this query shape in this period</EmptyTitle>
              <EmptyDescription>
                No database call of this shape was made
                {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period.
                Another period may have calls. Traces are kept for {data.retentionDays} days.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            className="flex flex-col gap-6 transition-opacity data-[stale=true]:opacity-60"
            data-stale={detail.isPlaceholderData}
            aria-busy={detail.isPlaceholderData}
          >
            <Totals data={data} />
            <Charts data={data} subject={subject} />

            <section aria-labelledby="slowest-calls" className="flex flex-col gap-3 border-t pt-5">
              <div className="flex flex-col gap-1">
                <h3 id="slowest-calls" className="text-sm font-medium text-ink">
                  Slowest calls
                </h3>
                <p className="text-xs text-ink-subtle">
                  The {formatWhole(data.slowest.length)} slowest in this period. Each opens its span
                  on its trace&apos;s page.
                </p>
              </div>
              <ScrollHint>
                {/* Pin only the trace link to leave room for other columns. */}
                <Table className="max-sm:min-w-[36rem]">
                  <caption className="sr-only">Slowest calls, slowest first</caption>
                  <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
                    <TableRow>
                      <TableHead className="pl-0">Started</TableHead>
                      <TableHead className="text-right">Duration</TableHead>
                      <TableHead>Service</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className={PINNED_END}>
                        <span className="sr-only">Trace</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.slowest.map((call) => (
                      <TableRow key={`${call.traceId}-${call.spanId}-${call.start}`}>
                        <TableCell className="pl-0 whitespace-nowrap tabular-nums">
                          {formatPreciseMoment(call.start, data.timeZone)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDuration(call.durationUs)}
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          {call.service}
                        </TableCell>
                        <TableCell>
                          {call.failed ? (
                            <StatusBadge tone="critical">Error</StatusBadge>
                          ) : (
                            <span className="text-sm text-ink-subtle">No error</span>
                          )}
                        </TableCell>
                        <TableCell className={PINNED_END}>
                          <Link
                            to="/projects/$projectId/traces/$traceId"
                            params={{ projectId, traceId: call.traceId }}
                            search={{ at: call.start, span: call.spanId }}
                            className="text-sm text-link hover:underline"
                          >
                            Open its trace
                            <span className="sr-only">
                              {" "}
                              ({formatDuration(call.durationUs)},{" "}
                              {formatPreciseMoment(call.start, data.timeZone)})
                            </span>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollHint>
            </section>

            {/* Use content width for the columns. */}
            <div className="@container border-t pt-5">
              <div className="grid gap-x-8 gap-y-8 @5xl:grid-cols-2">
                <section aria-labelledby="shape-services" className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <h3 id="shape-services" className="text-sm font-medium text-ink">
                      Services
                    </h3>
                    <p className="text-xs text-ink-subtle">
                      The services that make these calls, most calls first.
                    </p>
                  </div>
                  <ScrollHint>
                    <Table className="max-sm:min-w-[30rem]">
                      <caption className="sr-only">Services that make these calls</caption>
                      <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
                        <TableRow>
                          <TableHead className={`pl-0 ${PINNED}`}>Service</TableHead>
                          <TableHead className="text-right">Calls</TableHead>
                          <TableHead className="text-right">Total time</TableHead>
                          <TableHead className="text-right">95th percentile</TableHead>
                          <TableHead className="text-right">Failed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.services.map((item) => (
                          <TableRow key={item.service}>
                            <TableCell className={`pl-0 ${PINNED}`}>
                              <ServiceLink
                                projectId={projectId}
                                service={item.service}
                                range={range}
                                environment={environment}
                              />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatWhole(item.calls)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatDuration(item.totalUs)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatDuration(item.p95Us)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatFailed(item)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollHint>
                  {data.servicesTruncated && (
                    <p className="text-sm text-ink-subtle">
                      The {formatWhole(data.services.length)} services with the most calls, of{" "}
                      {formatWhole(data.totals.serviceCount)}.
                    </p>
                  )}
                </section>

                <section aria-labelledby="shape-routes" className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <h3 id="shape-routes" className="text-sm font-medium text-ink">
                      Routes
                    </h3>
                    <p className="text-xs text-ink-subtle">
                      The requests behind the {formatWhole(data.sampled)} latest calls: the route of
                      the request (a span of kind SERVER) of the same trace and service.
                    </p>
                  </div>
                  <ScrollHint>
                    <Table className="max-sm:min-w-[28rem]">
                      <caption className="sr-only">Routes that make these calls</caption>
                      <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
                        <TableRow>
                          <TableHead className={`pl-0 ${PINNED}`}>Route</TableHead>
                          <TableHead>Service</TableHead>
                          <TableHead className="text-right">Calls</TableHead>
                          <TableHead className="text-right">Share</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.callers.map((caller) => (
                          <TableRow key={`${caller.service}\u0000${caller.route ?? ""}`}>
                            <TableCell className={`max-w-64 pl-0 ${PINNED}`}>
                              {caller.route === null ? (
                                <span className="text-sm text-ink-subtle">No request found</span>
                              ) : (
                                <ServiceLink
                                  projectId={projectId}
                                  service={caller.service}
                                  route={caller.route}
                                  range={range}
                                  environment={environment}
                                />
                              )}
                            </TableCell>
                            <TableCell>
                              <ServiceLink
                                projectId={projectId}
                                service={caller.service}
                                range={range}
                                environment={environment}
                              />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatWhole(caller.calls)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatConversion(caller.calls / Math.max(data.sampled, 1))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollHint>
                </section>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
