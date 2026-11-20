import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ExternalLinkIcon, LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Workbench,
  WorkbenchKeyHints,
  type WorkbenchListProps,
  WorkbenchStartHint,
} from "@/components/workbench";
import {
  atLeast,
  GUTTER_END,
  GUTTER_START,
  LIST_HEAD,
  ROW_LINK,
  selectOnPlainClick,
  workbenchRow,
} from "@/components/workbench-rows";
import { NARROW_WORKBENCH, useMediaQuery } from "@/hooks/use-media-query";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  MIN_DURATIONS,
  type TraceFilters,
  type TraceList,
  tracesQuery,
  type TraceSummary,
} from "@/lib/traces-api";

import { formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "./filters";
import { formatDuration, formatPreciseMoment } from "./format";
import { type TracesSearch, tracesSearchOf } from "./search";
import { SendTelemetry } from "./send-telemetry";
import { TraceView } from "./trace-page";
import { TracesChart } from "./traces-chart";

const DURATION_CHOICES = MIN_DURATIONS.map((ms) => ({
  value: String(ms),
  label: `${formatDuration(ms * 1000)} or longer`,
}));

/** A trace's status: whether any of its spans failed. */
export function TraceStatus({ error }: { error: boolean }) {
  return error ? (
    <StatusBadge tone="critical">Error</StatusBadge>
  ) : (
    <StatusBadge tone="good">No errors</StatusBadge>
  );
}

/**
 * The listed traces, newest first, by their root span: its name (the row's
 * link, to the trace's own page; in the workbench a plain click selects the
 * row instead), service, start, and whether a span failed, then the
 * duration and the number of spans.
 */
function TraceTable({
  traces,
  projectId,
  timeZone,
  selected,
  select,
}: {
  traces: readonly TraceSummary[];
  projectId: string;
  timeZone: string;
} & WorkbenchListProps) {
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Traces, newest first, by their root span</caption>
      <colgroup>
        <col />
        <col className="w-20" />
        <col className="w-20" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            Trace
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
            Duration
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} text-right ${GUTTER_END}`}>
            Spans
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {traces.map((trace) => {
          const chosen = trace.traceId === selected;
          return (
            <TableRow
              key={`${trace.traceId}-${trace.spanId}-${trace.start}`}
              {...workbenchRow(trace.traceId, chosen)}
            >
              <TableCell className={`${GUTTER_START} py-2.5 align-top whitespace-normal`}>
                <TruncatedText
                  text={trace.name === "" ? "(no name)" : trace.name}
                  className="rounded-sm font-medium text-link hover:underline"
                  render={
                    <Link
                      to="/projects/$projectId/traces/$traceId"
                      params={{ projectId, traceId: trace.traceId }}
                      search={{ at: trace.start }}
                      aria-current={chosen ? "true" : undefined}
                      {...ROW_LINK}
                      onClick={selectOnPlainClick(select, trace.traceId)}
                    />
                  }
                />
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
                  <TruncatedText text={trace.service} className="max-w-48" />
                  <time dateTime={trace.start} className="font-mono">
                    {formatPreciseMoment(trace.start, timeZone)}
                  </time>
                  {trace.error && <TraceStatus error />}
                </p>
              </TableCell>
              <TableCell className="py-2.5 text-right align-top whitespace-nowrap tabular-nums">
                {formatDuration(trace.durationUs)}
              </TableCell>
              <TableCell className={`py-2.5 text-right align-top tabular-nums ${GUTTER_END}`}>
                {formatWhole(trace.spans)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The most traces the summary names, slowest first. */
const TOP_TRACES = 5;

/**
 * With nothing selected, the detail pane sums up the traces loaded (so "at
 * least" while older ones wait), the period's services (which the API
 * counts whole), and the slowest of those loaded, each a link that selects it.
 */
function Summary({
  first,
  traces,
  more,
  projectId,
}: {
  first: TraceList;
  traces: readonly TraceSummary[];
  more: boolean;
  projectId: string;
}) {
  const failed = traces.filter((trace) => trace.error).length;
  const stats: Stat[] = [
    { label: "Traces", value: atLeast(traces.length, more) },
    { label: "With errors", value: atLeast(failed, more) },
    { label: "Services", value: formatWhole(first.services.length) },
  ];
  const slowest = traces.toSorted((a, b) => b.durationUs - a.durationUs).slice(0, TOP_TRACES);
  const headingId = React.useId();
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">This period</h2>
        <FilterBarRange
          firstDay={first.firstDay}
          lastDay={first.lastDay}
          timeZone={first.timeZone}
        />
      </div>
      <section aria-label="Traces in the list" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Traces in the list" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          {more
            ? `Traces and errors count the ${formatWhole(traces.length)} newest traces loaded, so each is at least that many. Load older traces to count more. `
            : "Traces and errors count every trace in the list. "}
          Services counts those with traces in this period and environment.
        </p>
      </section>
      <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-base font-medium text-ink">
            Slowest
          </h3>
          <p className="text-sm text-muted-foreground">
            {more
              ? `The slowest of the ${formatWhole(traces.length)} traces loaded.`
              : "The slowest traces in the list."}
          </p>
        </div>
        <Table className="table-fixed">
          <caption className="sr-only">The slowest traces, slowest first</caption>
          <colgroup>
            <col />
            <col className="w-24" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={`${LIST_HEAD} pl-0`}>
                Trace
              </TableHead>
              <TableHead scope="col" className={`${LIST_HEAD} pr-0 text-right`}>
                Duration
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {slowest.map((trace) => (
              <TableRow
                key={`${trace.traceId}-${trace.spanId}-${trace.start}`}
                className="hover:bg-transparent"
              >
                <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                  <TruncatedText
                    text={trace.name === "" ? "(no name)" : trace.name}
                    className="font-medium text-link hover:underline"
                    render={
                      <Link
                        to="/projects/$projectId/traces"
                        params={{ projectId }}
                        search={(previous) => ({
                          ...previous,
                          trace: trace.traceId,
                          span: undefined,
                          at: trace.start,
                        })}
                      />
                    }
                  />
                  <TruncatedText
                    text={trace.service}
                    className="text-xs text-ink-subtle"
                    render={<div />}
                  />
                </th>
                <TableCell className="py-1.5 pr-0 text-right align-top tabular-nums">
                  {formatDuration(trace.durationUs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <WorkbenchStartHint noun="a trace" />
    </div>
  );
}

/**
 * A project's recent traces as a workbench (docs/design-system.md,
 * "Workbench"): one row per root span, newest first, for a period and an
 * environment, filtered by service, name, errors, and duration, a hundred
 * at a time with older ones on request; beside the selected trace's
 * waterfall, span detail, and logs or, with none selected, a summary. The
 * selected span is in the address too (`span`). Under 64rem a row opens the
 * trace's own page.
 */
export function TracesPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  filters,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  filters: TraceFilters;
}) {
  const navigate = useNavigate();
  const list = useInfiniteQuery(tracesQuery(projectId, range, environment, filters));
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  // The selected trace's span, and when it ran, for a trace the list does not hold
  // (a link from a log record).
  const { span, at } = useSearch({
    strict: false,
    select: (search: Record<string, unknown>) => ({
      span: typeof search.span === "string" ? search.span : undefined,
      at: typeof search.at === "string" ? search.at : undefined,
    }),
  });
  const search: TracesSearch = { range, environment, filters };
  const traces = (list.data?.pages ?? []).flatMap((page) => page.traces);
  // When a trace ran: its row's start, else what the address says (a link from a log record).
  const startOf = (traceId: string) =>
    traces.find((trace) => trace.traceId === traceId)?.start ?? at;

  // A filter keeps the selected trace beside the list, listed or not.
  const show = (next: Partial<TracesSearch>) =>
    void navigate({
      to: "/projects/$projectId/traces",
      params: { projectId },
      search: (previous: Record<string, unknown>) => ({
        ...tracesSearchOf({ ...search, ...next }),
        trace: typeof previous.trace === "string" ? previous.trace : undefined,
        span: typeof previous.span === "string" ? previous.span : undefined,
        // When the trace ran, so it is still found once the new list leaves it out.
        at: typeof previous.trace === "string" ? startOf(previous.trace) : undefined,
      }),
    });
  const filter = (next: Partial<TraceFilters>) => show({ filters: { ...filters, ...next } });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const first = list.data?.pages[0];
  const filtered =
    filters.service !== undefined ||
    filters.name !== undefined ||
    filters.errors === true ||
    filters.minDuration !== undefined;
  const openPage = (traceId: string) => {
    const start = startOf(traceId);
    void navigate({
      to: "/projects/$projectId/traces/$traceId",
      params: { projectId, traceId },
      search: {
        ...(start === undefined ? {} : { at: start }),
        ...(span === undefined ? {} : { span }),
      },
    });
  };
  const selectSpan = (spanId: string) =>
    navigate({
      to: "/projects/$projectId/traces",
      params: { projectId },
      search: (previous: Record<string, unknown>) => ({ ...previous, span: spanId }),
      replace: true,
      resetScroll: false,
    });

  const filterBar = (
    <ReportFilterBar
      label="Period, environment, and filters"
      range={range}
      environment={environment}
      answered={first}
      onRange={(next) => show({ range: next })}
      onEnvironment={(next) =>
        show({ environment: next, filters: { ...filters, service: undefined } })
      }
      filters={
        first?.received !== false && (
          <>
            <ChoiceFilter
              label="Service"
              anyLabel="Any service"
              choices={(first?.services ?? []).map((name) => ({ value: name, label: name }))}
              value={filters.service}
              onChange={(service) => filter({ service })}
              className="w-36"
            />
            <TextFilter
              label="Span name contains"
              placeholder="Name contains…"
              value={filters.name}
              onChange={(name) => filter({ name })}
              className="w-44"
            />
            <ChoiceFilter
              label="Minimum duration"
              anyLabel="Any duration"
              choices={DURATION_CHOICES}
              value={filters.minDuration === undefined ? undefined : String(filters.minDuration)}
              onChange={(value) =>
                filter({ minDuration: value === undefined ? undefined : Number(value) })
              }
              className="w-40"
            />
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                id="traces-errors"
                checked={filters.errors === true}
                onCheckedChange={(checked) => filter({ errors: checked ? true : undefined })}
              />
              <Label htmlFor="traces-errors" className="whitespace-nowrap">
                With errors only
              </Label>
            </div>
          </>
        )
      }
      actions={first?.received === true && <WorkbenchKeyHints />}
    />
  );

  const failure = list.isError && (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {first === undefined ? "The traces could not load" : "The traces could not refresh"}
      </AlertTitle>
      <AlertDescription>
        {list.error.message}
        {first !== undefined && " The list below is from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );

  if (first === undefined || !first.received) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="px-gutter py-5">
          {first !== undefined ? (
            <SendTelemetry
              projectId={projectId}
              signal="traces"
              retentionDays={first.retentionDays}
            />
          ) : list.isError ? (
            failure
          ) : (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }

  const empty = traces.length === 0;
  const guidance = (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "No trace matches these filters" : "No traces in this period"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Change or clear a filter to see more."
            : `No root span arrived${environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period. Traces are kept ${first.retentionDays} days.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      {filterBar}
      <Workbench
        label="Traces"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={[...new Set(traces.map((trace) => trace.traceId))]}
        param="trace"
        // A trace chosen runs at its row's start, with no span of the one before.
        selectionSearch={(id) => ({
          span: undefined,
          at: id === undefined ? undefined : startOf(id),
        })}
        filterKey={JSON.stringify([range, environment, filters])}
        onOpenPage={openPage}
        renderList={(props) => (
          <div className="flex flex-col">
            <TracesChart
              projectId={projectId}
              range={range}
              environment={environment}
              filters={filters}
              onRange={(next) => show({ range: next })}
            />
            <div
              className="flex flex-col transition-opacity data-[stale=true]:opacity-60"
              data-stale={list.isPlaceholderData}
              aria-busy={list.isPlaceholderData}
            >
              {list.isError && <div className="px-gutter pt-4">{failure}</div>}
              {empty ? (
                narrow ? (
                  <div className="px-gutter py-5">{guidance}</div>
                ) : (
                  <p className="px-gutter py-6 text-sm text-ink-subtle">
                    {filtered ? "No trace matches these filters." : "No traces in this period."}
                  </p>
                )
              ) : (
                <TraceTable
                  traces={traces}
                  projectId={projectId}
                  timeZone={first.timeZone}
                  {...props}
                />
              )}
              {list.hasNextPage && (
                <Button
                  variant="outline"
                  className="my-4 self-center"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage && (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="animate-spin motion-reduce:animate-none"
                    />
                  )}
                  Load older traces
                </Button>
              )}
            </div>
          </div>
        )}
        summary={
          empty ? (
            <div className="px-gutter py-5">{guidance}</div>
          ) : (
            <Summary first={first} traces={traces} more={list.hasNextPage} projectId={projectId} />
          )
        }
        renderDetail={(traceId) => {
          const start = startOf(traceId);
          return (
            <div className="px-gutter py-5">
              <TraceView
                key={traceId}
                projectId={projectId}
                traceId={traceId}
                at={start}
                spanId={span}
                onSpan={selectSpan}
                inWorkbench
                actions={
                  <ButtonLink
                    variant="ghost"
                    size="sm"
                    to="/projects/$projectId/traces/$traceId"
                    params={{ projectId, traceId }}
                    search={{
                      ...(start === undefined ? {} : { at: start }),
                      ...(span === undefined ? {} : { span }),
                    }}
                  >
                    <ExternalLinkIcon aria-hidden="true" />
                    Open the trace&apos;s page
                  </ButtonLink>
                }
              />
            </div>
          );
        }}
      />
    </div>
  );
}
