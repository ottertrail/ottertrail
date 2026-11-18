import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";

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
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { isSeverity, type LogFilters, logsQuery, SEVERITIES } from "@/lib/logs-api";

import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "./filters";
import { LogList } from "./log-list";
import { type LogsSearch, logsSearchOf } from "./search";
import { SendTelemetry } from "./send-telemetry";

const SEVERITY_CHOICES = SEVERITIES.map((item) => ({
  value: item.value,
  label: item.value === "fatal" ? "Fatal" : `${item.label} and above`,
}));

/**
 * A project's log records, newest first, for a period and an environment,
 * filtered by service, minimum severity, words in the body, and trace;
 * fifty at a time, with older ones on request. Each opens to its
 * attributes and its trace.
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
  const search: LogsSearch = { range, environment, filters };
  const show = (next: Partial<LogsSearch>) =>
    void navigate({
      to: "/projects/$projectId/logs",
      params: { projectId },
      search: logsSearchOf({ ...search, ...next }),
    });
  const filter = (next: Partial<LogFilters>) => show({ filters: { ...filters, ...next } });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const first = list.data?.pages[0];
  const logs = (list.data?.pages ?? []).flatMap((page) => page.logs);
  const filtered = Object.values(filters).some((value) => value !== undefined);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-3">
        <RangeControls
          range={range}
          environment={environment}
          answered={first}
          onRange={(next) => show({ range: next })}
          onEnvironment={(next) =>
            show({ environment: next, filters: { ...filters, service: undefined } })
          }
        />
        {first?.received !== false && (
          <div className="flex flex-wrap items-center gap-2">
            <TextFilter
              label="Words in the message"
              placeholder="Words in the message…"
              value={filters.search}
              onChange={(text) => filter({ search: text })}
              className="w-72"
            />
            <ChoiceFilter
              label="Service"
              anyLabel="Any service"
              choices={(first?.services ?? []).map((name) => ({ value: name, label: name }))}
              value={filters.service}
              onChange={(service) => filter({ service })}
            />
            <ChoiceFilter
              label="Minimum severity"
              anyLabel="Any severity"
              choices={SEVERITY_CHOICES}
              value={filters.severity}
              onChange={(value) => filter({ severity: isSeverity(value) ? value : undefined })}
            />
            <TextFilter
              label="Trace ID"
              placeholder="Trace ID"
              value={filters.traceId}
              onChange={(traceId) => filter({ traceId: traceId?.toLowerCase() })}
              maxLength={32}
              pattern={/^[0-9a-fA-F]{32}$/}
              invalidMessage="A trace ID is 32 hexadecimal digits."
              className="w-80 font-mono"
            />
          </div>
        )}
        {first?.received !== false && (
          <p className="text-xs text-ink-subtle">
            Each word must be in the message, in any case, whole or as part of a longer word.
          </p>
        )}
      </div>

      {list.isError && (
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
      )}
      {first === undefined ? (
        !list.isError && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )
      ) : !first.received ? (
        <SendTelemetry projectId={projectId} signal="logs" retentionDays={first.retentionDays} />
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={list.isPlaceholderData}
          aria-busy={list.isPlaceholderData}
        >
          {logs.length === 0 ? (
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
          ) : (
            <LogList
              logs={logs}
              timeZone={first.timeZone}
              projectId={projectId}
              label="Log records, newest first"
            />
          )}
          {list.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage && (
                <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
              )}
              Load older logs
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
