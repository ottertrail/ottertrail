import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ActivityIcon, OctagonAlertIcon, PlusIcon } from "lucide-react";
import * as React from "react";

import { Missing } from "@/components/missing";
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
import { useAccess } from "@/lib/access";
import { ApiError } from "@/lib/api";
import { type Check, checksQuery } from "@/lib/uptime-api";

import { NoSuchProject } from "../projects/no-such-project";
import { CheckActions } from "./check-actions";
import { CheckFormDialog } from "./check-form-dialog";
import { CAUSE_TEXT, formatMoment, formatMs, formatUptime, intervalText } from "./format";
import { CheckStateBadge } from "./state-badge";

/** The latest run in words: its response time, or why it failed. */
function LatestCell({ check }: { check: Check }) {
  if (check.lastCheckedAt === null) {
    return <span className="text-ink-subtle">Not run yet</span>;
  }
  if (check.lastUp === false && check.lastCause !== null) {
    return (
      <span>
        {CAUSE_TEXT[check.lastCause]}
        {check.lastStatusCode === null ? "" : ` (${check.lastStatusCode})`}
      </span>
    );
  }
  return <span className="tabular-nums">{formatMs(check.lastResponseMs ?? 0)}</span>;
}

/**
 * The project's uptime checks: each with its state in words, its uptime
 * over the last 24 hours, 7 days, and 30 days, its latest response time,
 * and when it last ran; add, edit, pause, and delete.
 */
export function UptimePage({ projectId }: { projectId: string }) {
  const list = useQuery(checksQuery(projectId));
  const [adding, setAdding] = React.useState(false);
  const canManage = useAccess().canUse("uptime_alerts", "manage");

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;
  const full = data !== undefined && data.checks.length >= data.maxChecks;
  const addButton = canManage && (
    <Button onClick={() => setAdding(true)} disabled={full}>
      <PlusIcon aria-hidden="true" />
      Add check
    </Button>
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      {list.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined ? "The checks could not load" : "The checks could not refresh"}
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
            <Skeleton className="h-40 w-full" />
          </div>
        )
      ) : data.checks.length === 0 ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyTitle>No uptime checks yet</EmptyTitle>
            <EmptyDescription>
              This instance requests your site or API URL on a schedule. The check is marked down
              when it fails. You can see when the URL stopped responding and for how long.
            </EmptyDescription>
          </EmptyHeader>
          {canManage && <EmptyContent>{addButton}</EmptyContent>}
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-subtle">
              {data.checks.length} of at most {data.maxChecks} checks. Uptime is the share of the
              time not inside an incident.
            </p>
            {addButton}
          </div>
          <Table>
            <caption className="sr-only">Uptime checks</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">24 hours</TableHead>
                <TableHead className="text-right">7 days</TableHead>
                <TableHead className="text-right">30 days</TableHead>
                <TableHead>Latest</TableHead>
                <TableHead>Last checked</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.checks.map((check) => (
                <TableRow key={check.id}>
                  <TableCell className="max-w-xs">
                    <Link
                      to="/projects/$projectId/uptime/$checkId"
                      params={{ projectId, checkId: check.id }}
                      className="block truncate text-link hover:underline"
                    >
                      {check.name}
                    </Link>
                    <span className="block truncate text-xs text-ink-subtle" title={check.url}>
                      {check.method} {check.url},{" "}
                      {intervalText(check.intervalSeconds).toLowerCase()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <CheckStateBadge check={check} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUptime(check.uptime.day)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUptime(check.uptime.week)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUptime(check.uptime.month)}
                  </TableCell>
                  <TableCell>
                    <LatestCell check={check} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {check.lastCheckedAt === null ? (
                      <Missing label="Not checked yet" className="text-ink-subtle" />
                    ) : (
                      <time dateTime={check.lastCheckedAt}>
                        {formatMoment(check.lastCheckedAt, data.timeZone)}
                      </time>
                    )}
                  </TableCell>
                  <TableCell>
                    <CheckActions projectId={projectId} check={check} compact />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {full && (
            <p className="text-sm text-ink-subtle">
              The project reached its check limit. Delete a check to add another.
            </p>
          )}
        </>
      )}
      <CheckFormDialog open={adding} onOpenChange={setAdding} projectId={projectId} />
    </div>
  );
}
