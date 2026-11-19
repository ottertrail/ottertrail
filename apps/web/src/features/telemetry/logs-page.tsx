import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { InfoIcon, LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Workbench,
  WorkbenchKeyHints,
  type WorkbenchListProps,
  WorkbenchStartHint,
} from "@/components/workbench";
import { atLeast, SELECTED_ROW } from "@/components/workbench-rows";
import { NARROW_WORKBENCH, useMediaQuery } from "@/hooks/use-media-query";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  isSeverity,
  type LogFilters,
  type LogList as LogListAnswer,
  logsQuery,
  type LogSummary,
  SEVERITIES,
  severityOf,
} from "@/lib/logs-api";
import { cn } from "@/lib/utils";

import { formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "./filters";
import { formatPreciseMoment } from "./format";
import { LogList, LogRecordView, SeverityBadge } from "./log-list";
import { type LogsSearch, logsSearchOf } from "./search";
import { SendTelemetry } from "./send-telemetry";

const SEVERITY_CHOICES = SEVERITIES.map((item) => ({
  value: item.value,
  label: item.value === "fatal" ? "Fatal" : `${item.label} and above`,
}));

/** The lowest severity number of warnings. */
const WARN = SEVERITIES.find((item) => item.value === "warn")?.from ?? 13;
const ERROR = SEVERITIES.find((item) => item.value === "error")?.from ?? 17;

/**
 * The listed records, newest first, each a button that selects it: its
 * time, severity, service, and the start of its body. A record has no page
 * of its own; under 64rem the list is `LogList`, whose rows open in place.
 */
function LogRows({
  logs,
  timeZone,
  selected,
  select,
}: {
  logs: readonly LogSummary[];
  timeZone: string;
} & WorkbenchListProps) {
  return (
    <ul aria-label="Log records, newest first" className="flex flex-col">
      {logs.map((log) => {
        const chosen = log.id === selected;
        return (
          <li
            key={log.id}
            data-workbench-id={log.id}
            data-state={chosen ? "selected" : undefined}
            className={cn("border-b", SELECTED_ROW, chosen && "bg-muted")}
          >
            <button
              type="button"
              aria-current={chosen ? "true" : undefined}
              onClick={() => select(log.id)}
              className="flex w-full flex-col gap-1 px-gutter py-2 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
            >
              <span className="flex min-w-0 items-center gap-2">
                <time dateTime={log.time} className="shrink-0 font-mono text-xs text-ink-muted">
                  {formatPreciseMoment(log.time, timeZone)}
                </time>
                <SeverityBadge log={log} />
                {log.service !== "" && (
                  <span className="min-w-0 truncate text-xs text-ink-subtle">{log.service}</span>
                )}
              </span>
              <span className="line-clamp-2 font-mono text-xs break-words text-ink">
                {log.body === "" ? (
                  <span className="font-sans text-ink-subtle">(empty)</span>
                ) : (
                  log.body
                )}
                {log.bodyTruncated && "…"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * With nothing selected, the detail pane sums up the records loaded (so "at
 * least" while older ones wait): how many, how many are warnings and how
 * many errors or worse (only what the severity filter can list), and the
 * period's services, which the API counts whole.
 */
function Summary({
  first,
  logs,
  more,
  filters,
}: {
  first: LogListAnswer;
  logs: readonly LogSummary[];
  more: boolean;
  filters: LogFilters;
}) {
  const minimum = SEVERITIES.find((item) => item.value === filters.severity)?.from ?? 0;
  const warnings = logs.filter(
    (log) => log.severityNumber >= WARN && log.severityNumber < ERROR,
  ).length;
  const errors = logs.filter((log) => log.severityNumber >= ERROR).length;
  const stats: Stat[] = [
    { label: "Records", value: atLeast(logs.length, more) },
    // A filter at error or above lists no warnings.
    ...(minimum < ERROR ? [{ label: "Warnings", value: atLeast(warnings, more) }] : []),
    { label: "Errors or worse", value: atLeast(errors, more) },
    { label: "Services", value: formatWhole(first.services.length) },
  ];
  const latestError = logs.find((log) => (severityOf(log.severityNumber)?.from ?? 0) >= ERROR);
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
      <section aria-label="Records in the list" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Records in the list" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          {more
            ? `Records, warnings, and errors count the ${formatWhole(logs.length)} newest records loaded, so each is at least that many. Load older logs to count more. `
            : "Records, warnings, and errors count every record in the list. "}
          Services counts those with logs in this period and environment.
        </p>
      </section>
      {latestError !== undefined && (
        <section aria-label="The latest error" className="flex flex-col gap-2 border-t pt-5">
          <h3 className="text-base font-medium text-ink">The latest error</h3>
          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
            <SeverityBadge log={latestError} />
            <time dateTime={latestError.time} className="font-mono">
              {formatPreciseMoment(latestError.time, first.timeZone)}
            </time>
            {latestError.service}
          </p>
          <p className="line-clamp-3 font-mono text-xs break-words text-ink">{latestError.body}</p>
        </section>
      )}
      <WorkbenchStartHint noun="a record" />
    </div>
  );
}

/**
 * A project's log records as a workbench (docs/design-system.md,
 * "Workbench"), newest first, for a period and an environment, filtered by
 * service, minimum severity, words in the body, and trace; fifty at a time
 * with older ones on request; beside the selected record's body,
 * attributes, resource attributes, and its trace (a link into the Traces
 * workbench) or, with none selected, a summary. A record has no page of its
 * own: under 64rem each row opens in place, as on a trace's page.
 */
export function LogsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  filters,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  filters: LogFilters;
}) {
  const navigate = useNavigate();
  const list = useInfiniteQuery(logsQuery(projectId, range, environment, filters));
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  // On a narrow screen, the record an address named, open in the list.
  const [openOnArrival, setOpenOnArrival] = React.useState<string | undefined>(undefined);
  const search: LogsSearch = { range, environment, filters };
  // A filter keeps the selected record beside the list, listed or not.
  const show = (next: Partial<LogsSearch>) =>
    void navigate({
      to: "/projects/$projectId/logs",
      params: { projectId },
      search: (previous: Record<string, unknown>) => ({
        ...logsSearchOf({ ...search, ...next }),
        log: typeof previous.log === "string" ? previous.log : undefined,
      }),
    });
  const filter = (next: Partial<LogFilters>) => show({ filters: { ...filters, ...next } });

  // Every record listed so far, so one a filter leaves out still shows beside the list:
  // a cache that only grows, kept for the page's life.
  const [seen] = React.useState(() => new Map<string, LogSummary>());
  for (const page of list.data?.pages ?? []) {
    for (const log of page.logs) seen.set(log.id, log);
  }

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const first = list.data?.pages[0];
  const logs = (list.data?.pages ?? []).flatMap((page) => page.logs);
  const filtered = Object.values(filters).some((value) => value !== undefined);

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
            <TextFilter
              label="Words in the message"
              placeholder="Words in the message…"
              value={filters.search}
              onChange={(text) => filter({ search: text })}
              className="w-56"
            />
            <ChoiceFilter
              label="Service"
              anyLabel="Any service"
              choices={(first?.services ?? []).map((name) => ({ value: name, label: name }))}
              value={filters.service}
              onChange={(service) => filter({ service })}
              className="w-36"
            />
            <ChoiceFilter
              label="Minimum severity"
              anyLabel="Any severity"
              choices={SEVERITY_CHOICES}
              value={filters.severity}
              onChange={(value) => filter({ severity: isSeverity(value) ? value : undefined })}
              className="w-40"
            />
            <TextFilter
              label="Trace ID"
              placeholder="Trace ID"
              value={filters.traceId}
              onChange={(traceId) => filter({ traceId: traceId?.toLowerCase() })}
              maxLength={32}
              pattern={/^[0-9a-fA-F]{32}$/}
              invalidMessage="A trace ID is 32 hexadecimal digits."
              className="w-72 max-w-full font-mono"
            />
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
        {first === undefined ? "The logs could not load" : "The logs could not refresh"}
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
              signal="logs"
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

  const empty = logs.length === 0;
  const guidance = (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "No log record matches these filters" : "No logs in this period"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Change or clear a filter to see more."
            : `No log record arrived${environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period. Logs are kept ${first.retentionDays} days.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
  const searchHint = (
    <p className="px-gutter pt-3 text-xs text-ink-subtle">
      The message must contain every word. Matching ignores letter case and includes parts of longer
      words.
    </p>
  );
  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      {filterBar}
      <Workbench
        label="Logs"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={logs.map((log) => log.id)}
        param="log"
        filterKey={JSON.stringify([range, environment, filters])}
        onOpenPage={setOpenOnArrival}
        renderList={(props) => (
          <div
            className="flex flex-col transition-opacity data-[stale=true]:opacity-60"
            data-stale={list.isPlaceholderData}
            aria-busy={list.isPlaceholderData}
          >
            {searchHint}
            {list.isError && <div className="px-gutter pt-4">{failure}</div>}
            {empty ? (
              narrow ? (
                <div className="px-gutter py-5">{guidance}</div>
              ) : (
                <p className="px-gutter py-6 text-sm text-ink-subtle">
                  {filtered ? "No log record matches these filters." : "No logs in this period."}
                </p>
              )
            ) : narrow ? (
              // No room beside the list: a record opens in place, as on a trace's page.
              <div className="flex flex-col gap-3 px-gutter py-3">
                {openOnArrival !== undefined && !logs.some((log) => log.id === openOnArrival) && (
                  <Alert>
                    <InfoIcon />
                    <AlertTitle>The linked log record is not in the list</AlertTitle>
                    <AlertDescription>
                      It is not among the records loaded for these filters. Load older logs, or
                      choose a longer period, to find it.
                    </AlertDescription>
                  </Alert>
                )}
                <LogList
                  key={openOnArrival}
                  logs={logs}
                  timeZone={first.timeZone}
                  projectId={projectId}
                  label="Log records, newest first"
                  openId={openOnArrival}
                />
              </div>
            ) : (
              <LogRows logs={logs} timeZone={first.timeZone} {...props} />
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
                Load older logs
              </Button>
            )}
          </div>
        )}
        summary={
          empty ? (
            <div className="px-gutter py-5">{guidance}</div>
          ) : (
            <Summary first={first} logs={logs} more={list.hasNextPage} filters={filters} />
          )
        }
        renderDetail={(id) => {
          const log = logs.find((item) => item.id === id) ?? seen.get(id);
          if (log === undefined) {
            return (
              <div className="px-gutter py-5">
                <Empty className="border border-dashed p-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchXIcon />
                    </EmptyMedia>
                    <EmptyTitle>This record is not in the list</EmptyTitle>
                    <EmptyDescription>
                      The list holds the newest records loaded for these filters. Load older logs,
                      or change the filters, to find it.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <ButtonLink
                      variant="outline"
                      to="/projects/$projectId/logs"
                      params={{ projectId }}
                      search={(previous) => ({ ...previous, log: undefined })}
                    >
                      All logs
                    </ButtonLink>
                  </EmptyContent>
                </Empty>
              </div>
            );
          }
          return (
            <div className="flex flex-col gap-4 px-gutter py-5">
              <div className="flex flex-col gap-2">
                <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold text-ink">
                  <time dateTime={log.time} className="tabular-nums">
                    {formatPreciseMoment(log.time, first.timeZone)}
                  </time>
                  <SeverityBadge log={log} />
                </h2>
                <p className="text-sm text-ink-subtle">
                  {log.service === "" ? "No service named" : log.service}, in {log.environment}.
                  Times in {first.timeZone}.
                </p>
              </div>
              <LogRecordView
                key={id}
                summary={log}
                timeZone={first.timeZone}
                projectId={projectId}
                onSpan={undefined}
                spanName={undefined}
                inWorkbench
              />
            </div>
          );
        }}
      />
    </div>
  );
}
