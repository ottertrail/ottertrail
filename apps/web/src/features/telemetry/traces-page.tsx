import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
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
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { MIN_DURATIONS, type TraceFilters, tracesQuery } from "@/lib/traces-api";

import { formatWhole } from "../analytics/format";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "./filters";
import { formatDuration, formatPreciseMoment } from "./format";
import { type TracesSearch, tracesSearchOf } from "./search";
import { SendTelemetry } from "./send-telemetry";

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
 * A project's recent traces: one row per root span, newest first, for a
 * period and an environment, filtered by service, name, errors, and
 * duration; a hundred at a time, with older ones on request.
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
  const search: TracesSearch = { range, environment, filters };
  const show = (next: Partial<TracesSearch>) =>
    void navigate({
      to: "/projects/$projectId/traces",
      params: { projectId },
      search: tracesSearchOf({ ...search, ...next }),
    });
  const filter = (next: Partial<TraceFilters>) => show({ filters: { ...filters, ...next } });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const first = list.data?.pages[0];
  const traces = (list.data?.pages ?? []).flatMap((page) => page.traces);
  const filtered =
    filters.service !== undefined ||
    filters.name !== undefined ||
    filters.errors === true ||
    filters.minDuration !== undefined;

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
            <ChoiceFilter
              label="Service"
              anyLabel="Any service"
              choices={(first?.services ?? []).map((name) => ({ value: name, label: name }))}
              value={filters.service}
              onChange={(service) => filter({ service })}
            />
            <TextFilter
              label="Span name contains"
              placeholder="Name contains…"
              value={filters.name}
              onChange={(name) => filter({ name })}
            />
            <ChoiceFilter
              label="Minimum duration"
              anyLabel="Any duration"
              choices={DURATION_CHOICES}
              value={filters.minDuration === undefined ? undefined : String(filters.minDuration)}
              onChange={(value) =>
                filter({ minDuration: value === undefined ? undefined : Number(value) })
              }
            />
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                id="traces-errors"
                checked={filters.errors === true}
                onCheckedChange={(checked) => filter({ errors: checked ? true : undefined })}
              />
              <Label htmlFor="traces-errors">With errors only</Label>
            </div>
          </div>
        )}
      </div>

      {list.isError && (
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
        <SendTelemetry projectId={projectId} signal="traces" retentionDays={first.retentionDays} />
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={list.isPlaceholderData}
          aria-busy={list.isPlaceholderData}
        >
          {traces.length === 0 ? (
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
          ) : (
            <Table>
              <caption className="sr-only">Traces, newest first, by their root span</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Trace</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Spans</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traces.map((trace) => (
                  <TableRow key={`${trace.traceId}-${trace.spanId}-${trace.start}`}>
                    <TableCell className="max-w-sm">
                      <Link
                        to="/projects/$projectId/traces/$traceId"
                        params={{ projectId, traceId: trace.traceId }}
                        search={{ at: trace.start }}
                        className="block truncate font-medium text-link hover:underline"
                        title={trace.name}
                      >
                        {trace.name === "" ? "(no name)" : trace.name}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-48 truncate">{trace.service}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      <time dateTime={trace.start}>
                        {formatPreciseMoment(trace.start, first.timeZone)}
                      </time>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(trace.durationUs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatWhole(trace.spans)}
                    </TableCell>
                    <TableCell>
                      <TraceStatus error={trace.error} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
              Load older traces
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
