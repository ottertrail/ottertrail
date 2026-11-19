import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, DatabaseIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
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
  type DatabaseSort,
  type DatabaseSummary,
  databasesQuery,
  DEFAULT_DATABASE_SORT,
} from "@/lib/databases-api";

import { formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { databaseLabel, formatFailed, formatPerSecond, servicesText } from "./database-format";
import { formatDuration } from "./format";
import { DatabasesTrend } from "./report-trends";
import { databasesSearchOf, shapeSearchOf } from "./search";
import { SendTelemetry } from "./send-telemetry";

/** The columns a shape table sorts by, with what each sort is called in sentences. */
const SORT_COLUMNS: Record<DatabaseSort, { header: string; phrase: string }> = {
  time: { header: "Total time", phrase: "with the most time spent" },
  p95: { header: "95th percentile", phrase: "with the slowest 95th percentile" },
  calls: { header: "Calls", phrase: "with the most calls" },
  failures: { header: "Failed", phrase: "with the most failed calls" },
};

/**
 * A column header the shapes sort by: a button, the column sorted by
 * marked (aria-sort), largest first. Sorting asks the API again: it keeps
 * a database's first 200 shapes in that order.
 */
function SortHeader({
  sort,
  current,
  onSort,
}: {
  sort: DatabaseSort;
  current: DatabaseSort;
  onSort: (sort: DatabaseSort) => void;
}) {
  const active = sort === current;
  return (
    <TableHead className="text-right" aria-sort={active ? "descending" : "none"}>
      <button
        type="button"
        onClick={() => onSort(sort)}
        className="inline-flex items-center gap-1 rounded-sm text-right hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[active=true]:text-ink"
        data-active={active}
      >
        {SORT_COLUMNS[sort].header}
        <ArrowDownIcon aria-hidden="true" className={active ? "size-3.5" : "size-3.5 opacity-0"} />
      </button>
    </TableHead>
  );
}

/** One database: its numbers, and a table of its query shapes. */
function DatabaseCard({
  projectId,
  range,
  environment,
  database,
  sort,
  onSort,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  database: DatabaseSummary;
  sort: DatabaseSort;
  onSort: (sort: DatabaseSort) => void;
}) {
  const label = databaseLabel(database.system, database.database);
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 border-t pt-5">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="text-base font-medium break-all text-ink">
          {label}
        </h3>
        <p className="text-sm text-ink-subtle">
          {formatWhole(database.calls)} {database.calls === 1 ? "call" : "calls"} (
          {formatPerSecond(database.perSecond)}), {formatDuration(database.totalUs)} in all,{" "}
          {formatFailed(database)} failed; median {formatDuration(database.p50Us)}, 95th percentile{" "}
          {formatDuration(database.p95Us)}, 99th percentile {formatDuration(database.p99Us)}. From{" "}
          {servicesText(database)}.
        </p>
      </div>
      <ScrollHint>
        <Table className="max-sm:min-w-[52rem]">
          <caption className="sr-only">
            Query shapes of {label}, those {SORT_COLUMNS[sort].phrase} first
          </caption>
          <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
            <TableRow>
              <TableHead className={`pl-0 ${PINNED}`}>Query shape</TableHead>
              <SortHeader sort="calls" current={sort} onSort={onSort} />
              <TableHead className="text-right">Per second</TableHead>
              <SortHeader sort="time" current={sort} onSort={onSort} />
              <TableHead className="text-right">Median</TableHead>
              <SortHeader sort="p95" current={sort} onSort={onSort} />
              <TableHead className="text-right">99th percentile</TableHead>
              <SortHeader sort="failures" current={sort} onSort={onSort} />
              <TableHead>Services</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {database.shapes.map((shape) => (
              <TableRow key={shape.id}>
                <TableCell className={`max-w-md min-w-48 pl-0 max-sm:max-w-48 ${PINNED}`}>
                  <Link
                    to="/projects/$projectId/databases/$shapeId"
                    params={{ projectId, shapeId: shape.id }}
                    search={shapeSearchOf({ range, environment })}
                    className="line-clamp-2 font-mono text-xs break-all whitespace-normal text-link hover:underline"
                    title={shape.shape}
                  >
                    {shape.shape}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatWhole(shape.calls)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatPerSecond(shape.perSecond)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDuration(shape.totalUs)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDuration(shape.p50Us)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDuration(shape.p95Us)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatDuration(shape.p99Us)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatFailed(shape)}</TableCell>
                <TableCell className="max-w-48 text-xs whitespace-normal text-ink-subtle">
                  {servicesText(shape)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollHint>
      {database.shapeCount > database.shapes.length && (
        <p className="text-sm text-ink-subtle">
          The {formatWhole(database.shapes.length)} query shapes {SORT_COLUMNS[sort].phrase}, of{" "}
          {formatWhole(database.shapeCount)}.
        </p>
      )}
    </section>
  );
}

/** What the page reads, and how a server sends it: shown above the list and when it is empty. */
function WhatIsRead() {
  return (
    <>
      A database call is a CLIENT span from a trace with a database system attribute (
      <code className="font-mono">db.system.name</code>, or the older{" "}
      <code className="font-mono">db.system</code>). Calls are grouped by system, database, and
      query shape. The query shape uses <code className="font-mono">db.query.summary</code> if sent.
      Otherwise, it uses query text without literals, IN lists, or comments. If query text is
      absent, it uses the operation and collection.
    </>
  );
}

/**
 * The database calls inside the project's traces: each database (system
 * and name), the most time spent first, with its calls, calls per second,
 * time spent, durations, and failed share, and a table of its query
 * shapes, sorted by a column the reader chooses (total time by default).
 * A shape opens its page.
 */
export function DatabasesPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  sort = DEFAULT_DATABASE_SORT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  sort?: DatabaseSort;
}) {
  const navigate = useNavigate();
  const list = useQuery(databasesQuery(projectId, range, environment, sort));
  const show = (next: { range?: PageRange; environment?: string; sort?: DatabaseSort }) =>
    void navigate({
      to: "/projects/$projectId/databases",
      params: { projectId },
      search: databasesSearchOf({
        range: next.range ?? range,
        environment: next.environment ?? environment,
        sort: next.sort ?? sort,
      }),
    });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;

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
              {data === undefined
                ? "The databases could not load"
                : "The databases could not refresh"}
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
        {data?.received !== false && data?.databases.length !== 0 && (
          <DatabasesTrend projectId={projectId} range={range} environment={environment} />
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
        ) : data.databases.length === 0 ? (
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DatabaseIcon />
              </EmptyMedia>
              <EmptyTitle>No database calls in this period</EmptyTitle>
              <EmptyDescription className="flex flex-col gap-2">
                <span>
                  <WhatIsRead />
                </span>
                <span>
                  No such span arrived
                  {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period.
                  Most OpenTelemetry database client instrumentations record one span per query.
                  Enable your SDK's instrumentation for your app's database client. Use automatic
                  instrumentation or the package for that client. Calls then appear here with their
                  traces. Traces are kept for {data.retentionDays} days.
                </span>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
            data-stale={list.isPlaceholderData}
            aria-busy={list.isPlaceholderData}
          >
            <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
              <WhatIsRead /> Failed means the call's status is Error. Durations measure the calls.
              Total time is the sum of all call durations. Select a column with an arrow to sort
              query shapes. Select a shape to open its charts for the period.
            </p>
            {data.databases.map((database) => (
              <DatabaseCard
                key={`${database.system}\u0000${database.database}`}
                projectId={projectId}
                range={range}
                environment={environment}
                database={database}
                sort={data.sort}
                onSort={(next) => show({ sort: next })}
              />
            ))}
            {data.truncated && (
              <p className="text-sm text-ink-subtle">
                More than {formatWhole(data.databases.length)} databases were called: these are the{" "}
                {formatWhole(data.databases.length)} with the most time spent.
              </p>
            )}
          </div>
        )}
        {data !== undefined && !data.received && (
          <p className="text-sm text-ink-subtle">
            This page shows the database calls in those traces. <WhatIsRead />
          </p>
        )}
      </div>
    </div>
  );
}
