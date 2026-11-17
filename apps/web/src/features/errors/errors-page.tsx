import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BugIcon, CircleCheckIcon, InfoIcon, OctagonAlertIcon } from "lucide-react";

import { CopyableCode } from "@/components/copyable-code";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  type ErrorList,
  errorsQuery,
  isStatusFilter,
  STATUS_FILTERS,
  type StatusFilter,
} from "@/lib/errors-api";

import { formatWhole } from "../analytics/format";
import { NoSuchProject } from "../projects/no-such-project";
import { formatDay, formatMoment, timeAgo } from "../users/format";
import { ErrorStatusBadge } from "./error-status";
import { RangeControls } from "./range-controls";
import { type ErrorsSearch, errorsSearchOf } from "./search";

/** How a site reports an error it caught. */
const CAPTURE_EXAMPLE = `try {
  await saveOrder(order);
} catch (error) {
  window.ottertrail?.captureError(error);
}`;

function NoErrors({ status, environment }: { status: StatusFilter; environment: string }) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  if (status === "unresolved") {
    return (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BugIcon />
          </EmptyMedia>
          <EmptyTitle>No unresolved errors in this period</EmptyTitle>
          <EmptyDescription>
            The tracking snippet reports uncaught errors and unhandled promise rejections{where} on
            its own. To report an error your code catches, call{" "}
            <code className="font-mono">window.ottertrail.captureError(error)</code>. To turn the
            automatic reports off, add{" "}
            <code className="font-mono">data-errors=&quot;off&quot;</code> to the snippet.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-2xl text-left">
          <CopyableCode text={CAPTURE_EXAMPLE} copyLabel="Copy the example" />
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {status === "resolved" ? <CircleCheckIcon /> : <BugIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {status === "resolved" ? "No resolved errors in this period" : "No errors in this period"}
        </EmptyTitle>
        <EmptyDescription>
          {status === "resolved"
            ? "An error you mark resolved is listed here until it is seen again."
            : `No error arrived${where} in this period. Choose a longer one to see earlier errors.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ErrorTable({
  list,
  projectId,
  search,
}: {
  list: ErrorList;
  projectId: string;
  search: ErrorsSearch;
}) {
  const detailSearch = errorsSearchOf({ range: search.range, environment: search.environment });
  return (
    <Table>
      <caption className="sr-only">Errors, most recently seen first</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Error</TableHead>
          <TableHead className="text-right">Occurrences</TableHead>
          <TableHead className="text-right" title="Known users: your site's user IDs">
            Users
          </TableHead>
          <TableHead className="text-right">Visitors</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>First seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.groups.map((group) => (
          <TableRow key={group.fingerprint}>
            <TableCell className="max-w-md">
              <div className="flex min-w-0 items-center gap-2">
                <Link
                  to="/projects/$projectId/errors/$fingerprint"
                  params={{ projectId, fingerprint: group.fingerprint }}
                  search={detailSearch}
                  className="min-w-0 truncate text-link hover:underline"
                  title={`${group.type}: ${group.message}`}
                >
                  <span className="font-medium">{group.type}</span>
                  {group.message !== "" && <span>: {group.message}</span>}
                </Link>
                {group.status !== "unresolved" && <ErrorStatusBadge status={group.status} />}
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatWhole(group.occurrences)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatWhole(group.users)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatWhole(group.visitors)}</TableCell>
            <TableCell title={formatMoment(group.lastSeen, list.timeZone)}>
              {timeAgo(new Date(group.lastSeen))}
            </TableCell>
            <TableCell>{formatDay(group.firstSeen, list.timeZone)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The project's errors: one row per group (occurrences with one
 * fingerprint), latest seen first, for a period and an environment, by
 * status. Counts are for the period; first and last seen for all time.
 */
export function ErrorsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  status,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  status: StatusFilter;
}) {
  const navigate = useNavigate();
  const query = useQuery(errorsQuery(projectId, range, environment, status));
  const search: ErrorsSearch = { range, environment, status };
  const show = (next: Partial<ErrorsSearch>) =>
    void navigate({
      to: "/projects/$projectId/errors",
      params: { projectId },
      search: errorsSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <Tabs
        value={status}
        onValueChange={(value) => {
          if (isStatusFilter(value)) show({ status: value });
        }}
        className="gap-6"
      >
        <RangeControls
          range={range}
          environment={environment}
          answered={data}
          onRange={(next) => show({ range: next })}
          onEnvironment={(next) => show({ environment: next })}
        >
          <TabsList aria-label="Status">
            {STATUS_FILTERS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </RangeControls>

        <TabsContent value={status} className="flex flex-col gap-4">
          {query.isError && (
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>
                {data === undefined ? "The errors could not load" : "The errors could not refresh"}
              </AlertTitle>
              <AlertDescription>
                {query.error.message}
                {data !== undefined && " The list below is from the last successful load."}
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          )}
          {data === undefined ? (
            !query.isError && (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )
          ) : (
            <div
              className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
              data-stale={query.isPlaceholderData}
              aria-busy={query.isPlaceholderData}
            >
              {data.truncated && (
                <Alert>
                  <InfoIcon />
                  <AlertTitle>More than 1,000 errors in this period</AlertTitle>
                  <AlertDescription>
                    Only the 1,000 seen most recently are listed. Choose a shorter period to see the
                    others.
                  </AlertDescription>
                </Alert>
              )}
              {data.groups.length === 0 ? (
                <NoErrors status={status} environment={environment} />
              ) : (
                <ErrorTable list={data} projectId={projectId} search={search} />
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
