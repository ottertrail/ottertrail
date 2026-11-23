import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import type * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { Missing } from "@/components/missing";
import { PageTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { usePanePolling } from "@/components/workbench-pane";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { MISSING } from "@/lib/missing";
import {
  type Check,
  checkQuery,
  checkResultsQuery,
  type CheckResults,
  incidentsQuery,
} from "@/lib/uptime-api";

import { AlertRulesCard } from "../alerts/alert-rules-card";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChartCard } from "../telemetry/chart-card";
import { stepText } from "../telemetry/chart-time";
import { rangeSearch } from "../telemetry/search";
import { SLOTS } from "../telemetry/split-colors";
import { CheckActions } from "./check-actions";
import {
  CAUSE_TEXT,
  formatMoment,
  formatMs,
  formatSpan,
  formatUptime,
  intervalText,
} from "./format";
import { CheckStateBadge } from "./state-badge";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-card p-4 ring-1 ring-border">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="text-xl font-semibold text-ink tabular-nums">{value}</dd>
      {note !== undefined && <dd className="text-xs text-ink-subtle">{note}</dd>}
    </div>
  );
}

function StateLine({ check, timeZone }: { check: Check; timeZone: string }) {
  if (check.paused) return <span>Paused: it does not run until it is resumed.</span>;
  if (check.state === "pending") {
    return <span>Not enough runs yet to say whether it is up.</span>;
  }
  if (check.state === "down" && check.failingSince !== null) {
    return (
      <span>
        Down since{" "}
        <time dateTime={check.failingSince}>{formatMoment(check.failingSince, timeZone)}</time>
        {check.failingCause === null ? "" : `: ${CAUSE_TEXT[check.failingCause]}`}.
      </span>
    );
  }
  if (check.consecutiveFailures > 0) {
    return (
      <span>
        Up, but the last{" "}
        {check.consecutiveFailures === 1 ? "run" : `${check.consecutiveFailures} runs`} failed: down
        after {check.failuresBeforeDown} in a row.
      </span>
    );
  }
  return <span>Up.</span>;
}

function Stats({
  check,
  results,
  timeZone,
}: {
  check: Check;
  results: CheckResults | undefined;
  timeZone: string;
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @5xl:grid-cols-5">
      <Stat
        label="Uptime in this period"
        value={results === undefined ? "…" : formatUptime(results.uptime)}
        note={
          results === undefined ? undefined : `${results.runs} runs, ${results.failures} failed`
        }
      />
      <Stat label="Last 24 hours" value={formatUptime(check.uptime.day)} />
      <Stat label="Last 7 days" value={formatUptime(check.uptime.week)} />
      <Stat label="Last 30 days" value={formatUptime(check.uptime.month)} />
      <Stat
        label="Certificate expires"
        value={
          check.tlsExpiresAt === null
            ? MISSING
            : (formatMoment(check.tlsExpiresAt, timeZone).split(",")[0] ?? MISSING)
        }
        note={check.tlsExpiresAt === null ? "Seen on HTTPS answers" : undefined}
      />
    </dl>
  );
}

function IncidentsCard({
  projectId,
  check,
  range,
}: {
  projectId: string;
  check: Check;
  range: PageRange;
}) {
  const incidents = useQuery(incidentsQuery(projectId, check.id, range));
  const data = incidents.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Incidents</h3>
        </CardTitle>
        <CardDescription>
          Periods when the check was down in this period, newest first. Each starts at the first
          failure in the sequence that caused the incident. It ends at the first successful check.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {incidents.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertDescription>{incidents.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void incidents.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : data === undefined ? (
          <Skeleton className="h-20 w-full" aria-label="Loading" />
        ) : data.incidents.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-subtle">No incidents in this period.</p>
        ) : (
          <Table>
            <caption className="sr-only">Incidents, newest first</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead className="text-right">Lasted</TableHead>
                <TableHead>First cause</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.incidents.map((incident) => (
                <TableRow key={incident.id}>
                  <TableCell className="whitespace-normal">
                    <time dateTime={incident.startedAt}>
                      {formatMoment(incident.startedAt, data.timeZone)}
                    </time>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {incident.endedAt === null ? (
                      <StatusBadge tone="critical">Ongoing</StatusBadge>
                    ) : (
                      <time dateTime={incident.endedAt}>
                        {formatMoment(incident.endedAt, data.timeZone)}
                      </time>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSpan(
                      // Measure ongoing incidents through the response time.
                      (incident.endedAt === null
                        ? incidents.dataUpdatedAt
                        : Date.parse(incident.endedAt)) - Date.parse(incident.startedAt),
                    )}
                    {incident.endedAt === null ? " so far" : ""}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <span className="font-medium text-ink">{CAUSE_TEXT[incident.cause]}</span>
                    {incident.detail !== "" && (
                      <span className="block text-xs break-words text-ink-subtle">
                        {incident.detail}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {data?.truncated === true && (
          <p className="pt-3 text-sm text-ink-subtle">
            These are the latest 100 incidents of the period.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function FailuresCard({ results }: { results: CheckResults }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Latest failures</h3>
        </CardTitle>
        <CardDescription>
          The latest 20 runs in this period that failed, with their cause, newest first. Results are
          kept {results.retentionDays} days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {results.latestFailures.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-subtle">No run failed in this period.</p>
        ) : (
          <Table>
            <caption className="sr-only">Latest failures, newest first</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Cause</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="text-right">Took</TableHead>
                <TableHead>What happened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.latestFailures.map((failure) => (
                <TableRow key={failure.at}>
                  <TableCell className="whitespace-normal">
                    <time dateTime={failure.at}>{formatMoment(failure.at, results.timeZone)}</time>
                  </TableCell>
                  <TableCell>{CAUSE_TEXT[failure.cause]}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {failure.statusCode ?? <Missing label="No answer" />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMs(failure.responseMs)}
                  </TableCell>
                  <TableCell className="max-w-md text-xs break-words text-ink-subtle">
                    {failure.detail}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** Shared by the check page and workbench. A missing check clears the workbench selection. */
export function CheckView({
  projectId,
  checkId,
  range,
  onRange,
  onDeleted,
  actions,
  inWorkbench = false,
}: {
  projectId: string;
  checkId: string;
  range: PageRange;
  onRange: (range: PageRange) => void;
  onDeleted: () => void;
  actions?: React.ReactNode;
  inWorkbench?: boolean;
}) {
  // Beside the list, polling stops while the pane is hidden.
  const checkAnswer = useQuery({ ...checkQuery(projectId, checkId), ...usePanePolling() });
  const results = useQuery(checkResultsQuery(projectId, checkId, range));

  const error = checkAnswer.error;
  if (error instanceof ApiError && error.status === 404) {
    if (error.code === "check_not_found") {
      return (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>No such check</EmptyTitle>
            <EmptyDescription>
              The project has no check with this ID. It may have been deleted.
            </EmptyDescription>
          </EmptyHeader>
          {inWorkbench && (
            <EmptyContent>
              <ButtonLink
                variant="outline"
                to="/projects/$projectId/uptime"
                params={{ projectId }}
                search={(previous) => ({ ...previous, check: undefined })}
              >
                All checks
              </ButtonLink>
            </EmptyContent>
          )}
        </Empty>
      );
    }
    return <NoSuchProject />;
  }
  const answer = checkAnswer.data;
  const data = results.data;

  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      {answer === undefined ? (
        checkAnswer.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>The check could not load</AlertTitle>
            <AlertDescription>{checkAnswer.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void checkAnswer.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <Skeleton className="h-16 w-full" aria-label="Loading" />
        )
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {!inWorkbench && <PageTitle title={answer.check.name} />}
            {inWorkbench && (
              <h2 className="text-lg font-medium break-all text-ink">{answer.check.name}</h2>
            )}
            <p className="text-sm break-all text-ink-subtle">
              {answer.check.method} {answer.check.url},{" "}
              {intervalText(answer.check.intervalSeconds).toLowerCase()}
              {answer.check.word === null
                ? ""
                : `; "${answer.check.word}" ${answer.check.wordMode === "present" ? "must" : "must not"} be in the body`}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              <CheckStateBadge check={answer.check} />
              <StateLine check={answer.check} timeZone={answer.timeZone} />
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <CheckActions projectId={projectId} check={answer.check} onDeleted={onDeleted} />
            {actions}
          </div>
        </div>
      )}

      <RangeControls
        range={range}
        environment={DEFAULT_ENVIRONMENT}
        answered={data}
        onRange={onRange}
        onEnvironment={() => undefined}
      />

      {answer !== undefined && (
        <Stats check={answer.check} results={data} timeZone={answer.timeZone} />
      )}

      {answer !== undefined && (
        <AlertRulesCard projectId={projectId} watched={{ checkId: answer.check.id }} />
      )}

      {results.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined ? "The results could not load" : "The results could not refresh"}
          </AlertTitle>
          <AlertDescription>
            {results.error.message}
            {data !== undefined && " The chart below is from the last successful load."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {data === undefined ? (
        !results.isError && (
          <Skeleton className="h-72 w-full" aria-busy="true" aria-label="Loading" />
        )
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={results.isPlaceholderData}
          aria-busy={results.isPlaceholderData}
        >
          <ChartCard
            title="Response time"
            description={`Average time to response headers for runs with a response, including redirects, per ${stepText(data.stepSeconds)}. Runs without a response are excluded. They are listed among the failures below.`}
            frame={{
              start: data.start,
              stepSeconds: data.stepSeconds,
              buckets: data.buckets,
              timeZone: data.timeZone,
            }}
            subject={answer?.check.name ?? "the check"}
            lines={[
              {
                key: "response",
                label: "Response time",
                color: SLOTS[0] ?? "var(--chart-1)",
                values: data.responseMs,
              },
            ]}
            formatValue={formatMs}
            missing={
              data.responseMs.every((value) => value === null)
                ? data.runs === 0
                  ? "The check did not run in this period."
                  : "No run got an answer in this period."
                : undefined
            }
          />
          <div className="grid gap-4 @5xl:grid-cols-2">
            {answer !== undefined && (
              <IncidentsCard projectId={projectId} check={answer.check} range={range} />
            )}
            <FailuresCard results={data} />
          </div>
        </div>
      )}
    </div>
  );
}

export function CheckPage({
  projectId,
  checkId,
  range,
}: {
  projectId: string;
  checkId: string;
  range: PageRange;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-4 px-gutter py-5">
      <Link
        to="/projects/$projectId/uptime"
        params={{ projectId }}
        className="flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All checks
      </Link>
      <CheckView
        projectId={projectId}
        checkId={checkId}
        range={range}
        onRange={(next) =>
          void navigate({
            to: "/projects/$projectId/uptime/$checkId",
            params: { projectId, checkId },
            search: rangeSearch(next),
          })
        }
        onDeleted={() =>
          void navigate({ to: "/projects/$projectId/uptime", params: { projectId } })
        }
      />
    </div>
  );
}
