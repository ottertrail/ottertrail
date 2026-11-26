import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, InfoIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { PageTitle } from "@/components/page-header";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
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
import { ApiError } from "@/lib/api";
import { isTraceId } from "@/lib/logs-api";
import { type TraceDetail, traceQuery, type WaterfallSpan } from "@/lib/traces-api";
import { cn } from "@/lib/utils";

import { formatWhole } from "../analytics/format";
import { NoSuchProject } from "../projects/no-such-project";
import { BrowserPart } from "./browser-part";
import { formatDuration, formatOffset, formatPreciseMoment } from "./format";
import { LogList } from "./log-list";
import { SpanDetailCard } from "./span-detail";
import { type WaterfallRow, waterfallRows } from "./waterfall";

const MAX_INDENT = 12;

function barPlace(span: WaterfallSpan, totalUs: number) {
  if (totalUs <= 0) return { left: 0, width: 100 };
  const left = Math.min(100, (span.offsetUs / totalUs) * 100);
  const width = Math.max(0, Math.min(100 - left, (span.durationUs / totalUs) * 100));
  return { left, width };
}

/** Hide decorative bars from screen readers because adjacent text gives the same values. */
function Waterfall({
  trace,
  rows,
  selected,
  onSelect,
}: {
  trace: TraceDetail;
  rows: WaterfallRow[];
  selected: WaterfallSpan | undefined;
  onSelect: (span: WaterfallSpan) => void;
}) {
  return (
    <ScrollHint>
      <Table className="min-w-[32rem] table-fixed">
        <caption className="sr-only">
          Spans appear under their parents in start order. Select a span to see its details.
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead className={`w-[38%] ${PINNED}`}>Span</TableHead>
            <TableHead className="w-20 text-right">Start</TableHead>
            <TableHead className="w-20 text-right">Duration</TableHead>
            <TableHead aria-hidden="true">
              <span className="flex justify-between text-xs font-normal text-ink-subtle">
                <span>0</span>
                <span>{formatDuration(trace.durationUs)}</span>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ span, depth, orphan }) => {
            const isSelected = selected === span;
            const { left, width } = barPlace(span, trace.durationUs);
            return (
              <TableRow
                key={`${span.spanId}-${span.startNs}`}
                data-state={isSelected ? "selected" : undefined}
                {...clickableRow(cn({ "bg-surface-3": isSelected }))}
              >
                <TableCell className={cn("py-1", PINNED, isSelected && "max-sm:bg-surface-3")}>
                  <div
                    className="flex min-w-0 items-center gap-2"
                    style={{ paddingLeft: `${Math.min(depth, MAX_INDENT) * 14}px` }}
                  >
                    <TruncatedText
                      text={span.name === "" ? "(no name)" : span.name}
                      className="rounded-sm text-left text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      render={
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          {...ROW_LINK}
                          onClick={() => onSelect(span)}
                        />
                      }
                    >
                      <span className="sr-only">
                        {depth === 0 ? "Top level" : `Level ${depth + 1}`}
                        {orphan ? ", parent not received" : ""}:{" "}
                      </span>
                      {span.name === "" ? "(no name)" : span.name}
                    </TruncatedText>
                    <TruncatedText
                      text={span.service}
                      className="max-w-40 shrink-0 text-xs text-ink-subtle"
                    />

                    {span.status === "error" && <StatusBadge tone="critical">Error</StatusBadge>}
                  </div>
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                  {formatOffset(span.offsetUs)}
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                  {formatDuration(span.durationUs)}
                </TableCell>
                <TableCell className="py-1" aria-hidden="true">
                  <div className="relative h-3 rounded-sm bg-hairline/40">
                    <div
                      className={cn(
                        "absolute inset-y-0 min-w-0.5 rounded-sm",
                        span.status === "error" ? "bg-danger" : "bg-chart-1",
                      )}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollHint>
  );
}

function NoSpans({ trace, at }: { trace: TraceDetail; at: string | undefined }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-lg">
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No spans of this trace are kept</EmptyTitle>
        <EmptyDescription>
          Traces are kept {trace.retentionDays} days, so this one may be older, or its spans never
          arrived. Errors are kept longer than traces, so an error can name a trace that is gone.
          {at !== undefined &&
            ` Ottertrail looked a day either side of ${formatPreciseMoment(at, trace.timeZone)}.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Detail({
  projectId,
  trace,
  at,
  spanId,
  onSpan,
  actions,
  inWorkbench,
}: {
  projectId: string;
  trace: TraceDetail;
  at: string | undefined;
  spanId: string | undefined;
  onSpan: (spanId: string) => Promise<void>;
  actions: React.ReactNode;
  inWorkbench: boolean;
}) {
  const detailRef = React.useRef<HTMLElement>(null);
  const rows = React.useMemo(
    () => waterfallRows(trace.traceId, trace.spans),
    [trace.traceId, trace.spans],
  );
  const browserAt = trace.start ?? at;
  const names = React.useMemo(
    () => new Map(trace.spans.map((span) => [span.spanId, span.name])),
    [trace.spans],
  );
  const selected = rows.find((row) => row.span.spanId === spanId)?.span ?? rows[0]?.span;
  const root = rows[0]?.span;
  const failed = trace.spans.filter((span) => span.status === "error").length;
  const traceName = root === undefined ? "Trace" : root.name || "(no name)";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-2">
          {!inWorkbench && <PageTitle title={traceName} />}
          {inWorkbench && (
            <h2 className="text-xl font-semibold break-words text-ink">{traceName}</h2>
          )}
          <p className="font-mono text-sm break-all text-ink-muted">{trace.traceId}</p>
        </div>
        {actions}
      </div>
      {trace.start === null ? (
        <>
          <NoSpans trace={trace} at={at} />
          {browserAt !== undefined && (
            <BrowserPart projectId={projectId} traceId={trace.traceId} at={browserAt} />
          )}
        </>
      ) : (
        <>
          <Card>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-4">
                {[
                  { label: "Start", value: formatPreciseMoment(trace.start, trace.timeZone) },
                  { label: "Duration", value: formatDuration(trace.durationUs) },
                  { label: "Spans", value: formatWhole(trace.totalSpans) },
                  {
                    label: "Failed spans",
                    value:
                      failed === 0 ? (
                        <StatusBadge tone="good">None</StatusBadge>
                      ) : (
                        <StatusBadge tone="critical">{formatWhole(failed)}</StatusBadge>
                      ),
                  },
                ].map((fact) => (
                  <div key={fact.label} className="flex flex-col gap-1">
                    <dt className="text-xs text-ink-subtle">{fact.label}</dt>
                    <dd className="text-base font-semibold text-ink tabular-nums">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
          {browserAt !== undefined && (
            <BrowserPart projectId={projectId} traceId={trace.traceId} at={browserAt} />
          )}
          {trace.totalSpans > trace.spans.length && (
            <Alert>
              <InfoIcon />
              <AlertTitle>
                The first {formatWhole(trace.spans.length)} of {formatWhole(trace.totalSpans)} spans
              </AlertTitle>
              <AlertDescription>
                A trace&apos;s page shows its first {formatWhole(trace.spans.length)} spans by
                start. Spans whose parent is among the others show at the top level.
              </AlertDescription>
            </Alert>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                <h3>Waterfall</h3>
              </CardTitle>
              <CardDescription>
                Each span appears under its parent. Its bar shows when it ran within the trace.
                Spans with missing parents appear at the top level, as does a span under a
                browser&apos;s request. Times in {trace.timeZone}.
              </CardDescription>
            </CardHeader>
            <CardContent className="[--block-surface:var(--card)]">
              <Waterfall
                trace={trace}
                rows={rows}
                selected={selected}
                onSelect={(span) => void onSpan(span.spanId)}
              />
            </CardContent>
          </Card>
          {selected !== undefined && (
            <SpanDetailCard
              key={`${selected.spanId}-${selected.startNs}`}
              ref={detailRef}
              projectId={projectId}
              traceId={trace.traceId}
              span={selected}
              parentName={names.get(selected.parentSpanId)}
              inWorkbench={inWorkbench}
            />
          )}
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Logs</h3>
          </CardTitle>
          <CardDescription>
            {trace.logs.length === 0
              ? "No log record of this trace is kept."
              : `The trace's log records, oldest first${trace.logsTruncated ? `: the first ${formatWhole(trace.logs.length)}` : ""}.`}
          </CardDescription>
        </CardHeader>
        {trace.logs.length > 0 && (
          <CardContent>
            <LogList
              logs={trace.logs}
              timeZone={trace.timeZone}
              projectId={projectId}
              label="The trace's log records, oldest first"
              spanNames={names}
              onSpan={(id) =>
                void onSpan(id).then(() =>
                  window.requestAnimationFrame(() => {
                    detailRef.current?.scrollIntoView({ block: "start" });
                    detailRef.current?.focus({ preventScroll: true });
                  }),
                )
              }
            />
          </CardContent>
        )}
      </Card>
    </>
  );
}

/** `at` narrows the trace lookup to a day on either side of the known time. Embedded trace links stay in the workbench. */
export function TraceView({
  projectId,
  traceId,
  at,
  spanId,
  onSpan,
  actions,
  inWorkbench = false,
}: {
  projectId: string;
  traceId: string;
  at: string | undefined;
  spanId: string | undefined;
  onSpan: (spanId: string) => Promise<void>;
  actions?: React.ReactNode;
  inWorkbench?: boolean;
}) {
  const valid = isTraceId(traceId);
  const query = useQuery({ ...traceQuery(projectId, traceId.toLowerCase(), at), enabled: valid });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      {!valid ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>Not a trace ID</EmptyTitle>
            <EmptyDescription>
              A trace ID is 32 hexadecimal digits. The link may be cut short.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : query.isPending ? (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The trace could not load</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <Detail
          projectId={projectId}
          trace={query.data}
          at={at}
          spanId={spanId}
          onSpan={onSpan}
          actions={actions}
          inWorkbench={inWorkbench}
        />
      )}
    </div>
  );
}

export function TracePage({
  projectId,
  traceId,
  at,
  spanId,
}: {
  projectId: string;
  traceId: string;
  at: string | undefined;
  spanId: string | undefined;
}) {
  const navigate = useNavigate();
  const selectSpan = (id: string) =>
    navigate({
      to: "/projects/$projectId/traces/$traceId",
      params: { projectId, traceId },
      search: { ...(at === undefined ? {} : { at }), span: id },
      replace: true,
      resetScroll: false,
    });

  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <Link
        to="/projects/$projectId/traces"
        params={{ projectId }}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All traces
      </Link>
      <TraceView
        projectId={projectId}
        traceId={traceId}
        at={at}
        spanId={spanId}
        onSpan={selectSpan}
      />
    </div>
  );
}
