import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { useAccess } from "@/lib/access";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  type ErrorBreakdown,
  type ErrorBreakdownRow,
  type ErrorDetail,
  errorQuery,
  isUnknownProject,
  type Occurrence,
  setErrorStatus,
} from "@/lib/errors-api";

import { AlertRulesCard } from "../alerts/alert-rules-card";
import { DayCountCard } from "../analytics/day-count-card";
import { formatWhole } from "../analytics/format";
import { RankedList } from "../analytics/ranked-list";
import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment } from "../users/format";
import { ErrorStatusBadge } from "./error-status";
import { OccurrenceReplayCell } from "./occurrence-replay";
import { RangeControls } from "./range-controls";
import { type ErrorsSearch, errorsSearchOf } from "./search";
import { StackCard } from "./stack-card";

/** The group's status, and the button that changes it. */
function Resolution({ projectId, detail }: { projectId: string; detail: ErrorDetail }) {
  const { group, timeZone } = detail;
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (status: "resolved" | "unresolved") =>
      setErrorStatus(projectId, group.fingerprint, status),
    // Pending until both pages have the new status, so the button never shows the old one.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["errors", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["error", projectId, group.fingerprint] }),
      ]),
  });
  const resolved = group.status === "resolved";
  // Resolving and reopening need errors at manage (docs/access.md).
  const canChange = useAccess().canUse("errors", "manage");
  const when = group.resolvedAt === null ? "" : formatMoment(group.resolvedAt, timeZone);
  const by = group.resolvedBy === null ? "" : ` by ${group.resolvedBy}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ErrorStatusBadge status={group.status} />
        {canChange && (
          <Button
            variant={resolved ? "outline" : "default"}
            size="sm"
            disabled={change.isPending}
            onClick={() => change.mutate(resolved ? "unresolved" : "resolved")}
          >
            {change.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
        {group.status === "resolved" && when !== "" && (
          <p className="text-sm text-ink-subtle">
            Resolved{by}, {when}
          </p>
        )}
        {group.status === "regressed" && (
          <p className="text-sm text-ink-subtle">
            Regressed: seen again after it was resolved{by}
            {when === "" ? "" : `, ${when}`}.
          </p>
        )}
      </div>
      {change.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {resolved ? "The error could not be reopened" : "The error could not be resolved"}
          </AlertTitle>
          <AlertDescription>{change.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function Stats({ detail }: { detail: ErrorDetail }) {
  const { group, timeZone } = detail;
  const stats = [
    { label: "Occurrences", value: formatWhole(group.occurrences) },
    { label: "Users", value: formatWhole(group.users) },
    { label: "Visitors", value: formatWhole(group.visitors) },
    { label: "First seen", value: formatMoment(group.firstSeen, timeZone) },
    { label: "Last seen", value: formatMoment(group.lastSeen, timeZone) },
  ];
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1">
              <dt className="text-xs text-ink-subtle">{stat.label}</dt>
              <dd className="text-xl font-semibold tracking-tight text-ink tabular-nums">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-ink-subtle">
          Occurrences, users (your site&apos;s user IDs), and visitors count this period. First and
          last seen cover all the time the project keeps.
        </p>
      </CardContent>
    </Card>
  );
}

const known = (rows: ErrorBreakdownRow[]) => rows.some((row) => row.value !== null);

/** Whether the group happens on servers, in browsers, or both, from its breakdowns. */
function sourcesOf(detail: ErrorDetail) {
  const servers = known(detail.breakdowns.service);
  const browsers = !servers || known(detail.breakdowns.browser) || known(detail.breakdowns.os);
  return { servers, browsers };
}

/** The breakdowns the group has: a browser's, a server's, or both. */
function breakdownCards(detail: ErrorDetail) {
  const { servers, browsers } = sourcesOf(detail);
  const cards: { name: ErrorBreakdown; title: string; heading: string }[] = [
    servers && browsers
      ? { name: "path", title: "Pages and routes", heading: "Path or route" }
      : servers
        ? { name: "path", title: "Routes", heading: "Route" }
        : { name: "path", title: "Pages", heading: "Path" },
  ];
  if (browsers) {
    cards.push(
      { name: "browser", title: "Browsers", heading: "Browser" },
      { name: "os", title: "Operating systems", heading: "Operating system" },
    );
  }
  if (servers) cards.push({ name: "service", title: "Services", heading: "Service" });
  cards.push({ name: "release", title: "Releases", heading: "Release" });
  return cards;
}

function BreakdownCard({
  title,
  heading,
  rows,
  mono,
}: {
  title: string;
  heading: string;
  rows: ErrorBreakdownRow[];
  mono: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <RankedList
          rows={rows.map((row) => ({
            key: row.value ?? "\u0000unknown",
            label:
              row.value === null ? (
                <span className="text-ink-subtle">(unknown)</span>
              ) : (
                <span className={mono ? "font-mono" : undefined}>{row.value}</span>
              ),
            title: row.value ?? "(unknown)",
            primary: row.occurrences,
          }))}
          caption={`${title}, most occurrences first`}
          nameHeading={heading}
          primaryHeading="Occurrences"
          empty="No occurrences in this period."
        />
      </CardContent>
    </Card>
  );
}

/** "Firefox 132.0", or whichever part is known. */
const browserText = (occurrence: Occurrence) =>
  [occurrence.browser, occurrence.browserVersion].filter((part) => part !== null).join(" ");

const isServer = (occurrence: Occurrence) => occurrence.service !== null;

/** A column's heading for browsers' occurrences, servers', or both. */
function columnHeading(occurrences: Occurrence[], browser: string, server: string, both: string) {
  const servers = occurrences.some(isServer);
  const browsers = occurrences.some((occurrence) => !isServer(occurrence));
  return servers && browsers ? both : servers ? server : browser;
}

/** The trace and span IDs, as a tooltip. */
const traceTitle = (occurrence: Occurrence) =>
  `Trace ${occurrence.traceId ?? "(none)"}, span ${occurrence.spanId ?? "(none)"}`;

/** A server occurrence's trace, as a link to the trace's page, opened on its span. */
function TraceLink({
  projectId,
  occurrence,
  className,
}: {
  projectId: string;
  occurrence: Occurrence & { traceId: string };
  className?: string;
}) {
  // Traces belong to monitoring: without it, the ID shows as text (docs/access.md).
  const canOpen = useAccess().canUse("monitoring");
  if (!canOpen) {
    return <span className="font-mono">{occurrence.traceId}</span>;
  }
  return (
    <Link
      to="/projects/$projectId/traces/$traceId"
      params={{ projectId, traceId: occurrence.traceId }}
      search={{
        at: occurrence.occurredAt,
        ...(occurrence.spanId === null ? {} : { span: occurrence.spanId }),
      }}
      className={className ?? "font-mono text-link hover:underline"}
      aria-label={`Open trace ${occurrence.traceId}`}
    >
      {occurrence.traceId}
    </Link>
  );
}

const hasTrace = (occurrence: Occurrence): occurrence is Occurrence & { traceId: string } =>
  occurrence.traceId !== null;

/**
 * The latest occurrence's service, trace, and span, for a server's
 * exception. The trace ID opens the trace's page, with its spans and logs,
 * on the span the exception happened in.
 */
function ServerCard({ projectId, occurrence }: { projectId: string; occurrence: Occurrence }) {
  const items = [
    { label: "Service", value: occurrence.service },
    {
      label: "Trace ID",
      value: hasTrace(occurrence) ? (
        <TraceLink projectId={projectId} occurrence={occurrence} />
      ) : null,
    },
    { label: "Span ID", value: occurrence.spanId },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Server</h3>
        </CardTitle>
        <CardDescription>
          The latest occurrence came from a server, over OpenTelemetry. Its trace shows the spans
          and logs around it, while the trace is kept.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          {items.map((item) => (
            <div key={item.label} className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-ink-subtle">{item.label}</dt>
              <dd className="font-mono text-sm break-all text-ink">
                {item.value ?? <span className="font-sans text-ink-subtle">(none)</span>}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function OccurrencesCard({
  projectId,
  detail,
  environment,
}: {
  projectId: string;
  detail: ErrorDetail;
  environment: string;
}) {
  const userSearch = environment === DEFAULT_ENVIRONMENT ? {} : { env: environment };
  // Links into other areas only for those who have them (docs/access.md).
  const { canUse } = useAccess();
  const showUsers = canUse("users");
  const showReplays = canUse("replays");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Latest occurrences</h3>
        </CardTitle>
        <CardDescription>
          The {detail.occurrences.length === 1 ? "latest" : `latest ${detail.occurrences.length}`}{" "}
          in this period, newest first, in {detail.timeZone}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <caption className="sr-only">Latest occurrences, newest first</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>
                {columnHeading(detail.occurrences, "Page", "Route", "Page or route")}
              </TableHead>
              <TableHead>
                {columnHeading(detail.occurrences, "Browser", "Service", "Browser or service")}
              </TableHead>
              <TableHead>
                {columnHeading(detail.occurrences, "Operating system", "Trace", "System or trace")}
              </TableHead>
              <TableHead>Release</TableHead>
              {showReplays && <TableHead>Replay</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.occurrences.map((occurrence) => (
              <TableRow key={occurrence.eventId} title={occurrence.message}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <time dateTime={occurrence.occurredAt} className="tabular-nums">
                      {formatMoment(occurrence.occurredAt, detail.timeZone)}
                    </time>
                    {occurrence.handled && (
                      <Badge
                        variant="secondary"
                        title={
                          isServer(occurrence)
                            ? "On a span that did not fail, or logged below the error level"
                            : "Reported with captureError()"
                        }
                      >
                        Caught
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="max-w-48 truncate">
                  {occurrence.userId === null ? (
                    <span className="text-ink-subtle">Anonymous</span>
                  ) : !showUsers ? (
                    <span className="font-mono">{occurrence.userId}</span>
                  ) : (
                    <Link
                      to="/projects/$projectId/users/$userId"
                      params={{ projectId, userId: occurrence.userId }}
                      search={userSearch}
                      className="font-mono text-link hover:underline"
                    >
                      {occurrence.userId}
                    </Link>
                  )}
                </TableCell>
                <TableCell className="max-w-64 truncate font-mono" title={occurrence.path}>
                  {occurrence.path === "" ? (
                    <span className="font-sans text-ink-subtle">(none)</span>
                  ) : (
                    occurrence.path
                  )}
                </TableCell>
                {isServer(occurrence) ? (
                  <>
                    <TableCell className="max-w-48 truncate font-mono">
                      {occurrence.service}
                    </TableCell>
                    <TableCell
                      className="max-w-40 truncate font-mono"
                      title={traceTitle(occurrence)}
                    >
                      {hasTrace(occurrence) ? (
                        <TraceLink
                          projectId={projectId}
                          occurrence={occurrence}
                          className="text-link hover:underline"
                        />
                      ) : (
                        <span className="font-sans text-ink-subtle">(none)</span>
                      )}
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>{browserText(occurrence) || "(unknown)"}</TableCell>
                    <TableCell>{occurrence.os ?? "(unknown)"}</TableCell>
                  </>
                )}
                <TableCell>{occurrence.release ?? "(unknown)"}</TableCell>
                {showReplays && (
                  <TableCell className="py-1">
                    <OccurrenceReplayCell
                      projectId={projectId}
                      occurrence={occurrence}
                      timeZone={detail.timeZone}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Detail({
  projectId,
  detail,
  environment,
}: {
  projectId: string;
  detail: ErrorDetail;
  environment: string;
}) {
  const { group, breakdowns } = detail;
  const latest = detail.occurrences[0];
  const { canUse } = useAccess();
  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold break-words text-ink">{group.type}</h2>
          {group.message !== "" && (
            <p className="font-mono text-sm break-words whitespace-pre-wrap text-ink-muted">
              {group.message}
            </p>
          )}
        </div>
        <Resolution projectId={projectId} detail={detail} />
      </div>
      <Stats detail={detail} />
      {canUse("uptime_alerts") && (
        <AlertRulesCard
          projectId={projectId}
          watched={{ fingerprint: group.fingerprint, environment }}
        />
      )}
      <DayCountCard
        days={detail.days.map((day) => ({ day: day.day, count: day.occurrences }))}
        noun="Occurrences"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {breakdownCards(detail).map((card) => (
          <BreakdownCard
            key={card.name}
            title={card.title}
            heading={card.heading}
            rows={breakdowns[card.name]}
            mono={card.name === "path"}
          />
        ))}
      </div>
      {detail.source === "server" && latest !== undefined && (
        <ServerCard projectId={projectId} occurrence={latest} />
      )}
      <StackCard
        projectId={projectId}
        source={detail.source}
        stack={detail.stack}
        frames={detail.frames}
        sourceMaps={detail.sourceMaps}
      />
      <OccurrencesCard projectId={projectId} detail={detail} environment={environment} />
    </>
  );
}

/** The group has no occurrence in the period and environment shown. */
function NoOccurrence({
  projectId,
  fingerprint,
  search,
}: {
  projectId: string;
  fingerprint: string;
  search: ErrorsSearch;
}) {
  const isYear = "period" in search.range && search.range.period === "12m";
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No occurrence in this period</EmptyTitle>
        <EmptyDescription>
          This error did not happen
          {search.environment === DEFAULT_ENVIRONMENT ? "" : ` in ${search.environment}`} in this
          period. Choose a longer one, or go back to the list.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <ButtonLink
          variant="outline"
          to="/projects/$projectId/errors"
          params={{ projectId }}
          search={errorsSearchOf(search)}
        >
          All errors
        </ButtonLink>
        {!isYear && (
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/errors/$fingerprint"
            params={{ projectId, fingerprint }}
            search={errorsSearchOf({ ...search, range: { period: "12m" } })}
          >
            Show the last 12 months
          </ButtonLink>
        )}
      </EmptyContent>
    </Empty>
  );
}

/**
 * One error group: its status (with Resolve or Reopen), its numbers and a
 * trend for a period, where it happens, the latest occurrence's server (for
 * a server's exception), the latest stack trace (a browser's mapped with
 * the release's source maps where it can be), and its latest occurrences.
 */
export function ErrorPage({
  projectId,
  fingerprint,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  fingerprint: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const query = useQuery(errorQuery(projectId, fingerprint, range, environment));
  const search: ErrorsSearch = { range, environment };
  const show = (next: Partial<ErrorsSearch>) =>
    void navigate({
      to: "/projects/$projectId/errors/$fingerprint",
      params: { projectId, fingerprint },
      search: errorsSearchOf({ ...search, ...next }),
    });

  if (isUnknownProject(query.error)) {
    return <NoSuchProject />;
  }
  const data = query.data;
  const notFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <Link
        to="/projects/$projectId/errors"
        params={{ projectId }}
        search={errorsSearchOf(search)}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All errors
      </Link>
      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />

      {notFound ? (
        <NoOccurrence projectId={projectId} fingerprint={fingerprint} search={search} />
      ) : query.isPending ? (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The error could not load</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <Detail projectId={projectId} detail={query.data} environment={environment} />
      )}
    </div>
  );
}
