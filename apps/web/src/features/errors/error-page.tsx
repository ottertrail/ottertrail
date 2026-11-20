import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { ButtonLink } from "@/components/button-link";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { StatStrip } from "@/components/stat-strip";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
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
import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment } from "../users/format";
import { ErrorStatusBadge } from "./error-status";
import { OccurrenceReplayCell } from "./occurrence-replay";
import { EnvironmentSelect, PeriodSelect } from "./range-controls";
import { type ErrorsSearch, errorsSearchOf } from "./search";
import { StackCard } from "./stack-card";

/**
 * The shared cards (stack, trend, alert rules) as flat sections, parted by
 * a hairline rather than set in a card: the detail reads top to bottom.
 */
const SECTION_LOOK =
  "gap-3 overflow-visible rounded-none border-t bg-transparent pt-5 pb-0 ring-0 [--card-spacing:0]";

/**
 * Where the detail is narrower than 48rem (a phone, or the pane beside the
 * errors list), a wide table's rows stack into blocks, each value after its
 * column's name, which CSS draws from `data-label` so the cell's text stays
 * its value. By the detail's own width (`@container`), not the window's.
 */
const stackTable = "@max-3xl:block";
const stackRow = "@max-3xl:flex @max-3xl:flex-col @max-3xl:py-2";
const stackCell =
  "@max-3xl:flex @max-3xl:items-center @max-3xl:justify-between @max-3xl:gap-3 @max-3xl:px-0 @max-3xl:py-0.5 @max-3xl:before:shrink-0 @max-3xl:before:font-sans @max-3xl:before:text-ink-subtle @max-3xl:before:content-[attr(data-label)]";

/** A section of the detail: a hairline, its heading, an optional line under it. */
function DetailSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 border-t pt-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={headingId} className="text-base font-medium text-ink">
            {title}
          </h3>
          {description !== undefined && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The group's status, and the button that changes it. `buttonRef` lets a
 * workbench's `e` key press it, so the key and the button are one action.
 */
function Resolution({
  projectId,
  detail,
  buttonRef,
  keyHint = false,
}: {
  projectId: string;
  detail: ErrorDetail;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Shows the key that presses the button, in a workbench. */
  keyHint?: boolean;
}) {
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
          <span className="flex items-center gap-2">
            <Button
              ref={buttonRef}
              variant={resolved ? "outline" : "default"}
              size="sm"
              disabled={change.isPending}
              aria-keyshortcuts={keyHint ? "e" : undefined}
              onClick={() => change.mutate(resolved ? "unresolved" : "resolved")}
            >
              {change.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              {resolved ? "Reopen" : "Resolve"}
            </Button>
            {keyHint && <Kbd aria-hidden="true">e</Kbd>}
          </span>
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

/** The counts in the period, then when it was first and last seen. */
function Stats({ detail }: { detail: ErrorDetail }) {
  const { group, timeZone } = detail;
  // A moment may wrap to two lines in a narrow column; a count never does.
  const moment = (iso: string) => (
    <span className="whitespace-normal">{formatMoment(iso, timeZone)}</span>
  );
  return (
    <section aria-label="Numbers" className="flex flex-col gap-4 border-t pt-5">
      <StatStrip
        label="In this period"
        stats={[
          { label: "Occurrences", value: formatWhole(group.occurrences) },
          { label: "Users", value: formatWhole(group.users) },
          { label: "Visitors", value: formatWhole(group.visitors) },
        ]}
      />
      <StatStrip
        label="Seen"
        stats={[
          { label: "First seen", value: moment(group.firstSeen) },
          { label: "Last seen", value: moment(group.lastSeen) },
        ]}
      />
      <p className="text-xs text-ink-subtle">
        Occurrences, users (your site's user IDs), and visitors count within this period. First and
        last seen cover the project's full retention period.
      </p>
    </section>
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

/** Where the group happens: its pages or routes, browsers, systems, services, and releases. */
function Breakdowns({ detail }: { detail: ErrorDetail }) {
  return (
    <DetailSection title="Where it happens">
      <div className="@container">
        <div className="grid gap-x-8 gap-y-6 @xl:grid-cols-2">
          {breakdownCards(detail).map((card) => (
            <BreakdownTable
              key={card.name}
              title={card.title}
              headingLevel={4}
              caption={`${card.title}, most occurrences first`}
              nameHeading={card.heading}
              figureHeadings={["Occurrences"]}
              rows={detail.breakdowns[card.name].map((row: ErrorBreakdownRow) => ({
                key: row.value ?? "\u0000unknown",
                label:
                  row.value === null ? (
                    <span className="text-ink-subtle">(unknown)</span>
                  ) : (
                    <span className={card.name === "path" ? "font-mono" : undefined}>
                      {row.value}
                    </span>
                  ),
                title: row.value ?? "(unknown)",
                bar: row.occurrences,
                figures: [formatWhole(row.occurrences)],
              }))}
              empty="No occurrences in this period."
              layout="stack"
            />
          ))}
        </div>
      </div>
    </DetailSection>
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
function ServerSection({ projectId, occurrence }: { projectId: string; occurrence: Occurrence }) {
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
    <DetailSection
      title="Server"
      description="The latest occurrence came from a server over OpenTelemetry. Its trace shows nearby spans and logs during the trace's retention period."
    >
      <dl className="grid gap-x-6 gap-y-4 @xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-xs text-ink-subtle">{item.label}</dt>
            <dd className="font-mono text-sm break-all text-ink">
              {item.value ?? <span className="font-sans text-ink-subtle">(none)</span>}
            </dd>
          </div>
        ))}
      </dl>
    </DetailSection>
  );
}

function Occurrences({
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
  const headings = {
    page: columnHeading(detail.occurrences, "Page", "Route", "Page or route"),
    browser: columnHeading(detail.occurrences, "Browser", "Service", "Browser or service"),
    system: columnHeading(detail.occurrences, "Operating system", "Trace", "System or trace"),
  };
  return (
    <DetailSection
      title="Latest occurrences"
      description={`The ${detail.occurrences.length === 1 ? "latest" : `latest ${detail.occurrences.length}`} in this period, newest first, in ${detail.timeZone}.`}
    >
      {/* In a narrow detail each occurrence stacks into a block, every value labelled. */}
      <Table className={stackTable}>
        <caption className="sr-only">Latest occurrences, newest first</caption>
        <TableHeader className="@max-3xl:sr-only">
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>User</TableHead>
            <TableHead>{headings.page}</TableHead>
            <TableHead>{headings.browser}</TableHead>
            <TableHead>{headings.system}</TableHead>
            <TableHead>Release</TableHead>
            {showReplays && <TableHead>Replay</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody className={stackTable}>
          {detail.occurrences.map((occurrence) => (
            <TableRow key={occurrence.eventId} title={occurrence.message} className={stackRow}>
              <TableCell data-label="Time" className={stackCell}>
                <div className="flex items-center gap-2">
                  <time dateTime={occurrence.occurredAt} className="tabular-nums">
                    {formatMoment(occurrence.occurredAt, detail.timeZone)}
                  </time>
                  {occurrence.handled && (
                    <Badge
                      variant="secondary"
                      title={
                        isServer(occurrence)
                          ? "Reported on a span without failure status, or logged below the error level"
                          : "Reported with captureError()"
                      }
                    >
                      Caught
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell data-label="User" className={stackCell}>
                {occurrence.userId === null ? (
                  <span className="text-ink-subtle">Anonymous</span>
                ) : !showUsers ? (
                  <TruncatedText text={occurrence.userId} className="max-w-48 font-mono" />
                ) : (
                  <TruncatedText
                    text={occurrence.userId}
                    className="max-w-48 font-mono text-link hover:underline"
                    render={
                      <Link
                        to="/projects/$projectId/users/$userId"
                        params={{ projectId, userId: occurrence.userId }}
                        search={userSearch}
                      />
                    }
                  />
                )}
              </TableCell>
              <TableCell data-label={headings.page} className={`font-mono ${stackCell}`}>
                {occurrence.path === "" ? (
                  <span className="font-sans text-ink-subtle">(none)</span>
                ) : (
                  <TruncatedText text={occurrence.path} className="max-w-64" />
                )}
              </TableCell>
              {isServer(occurrence) ? (
                <>
                  <TableCell data-label={headings.browser} className={`font-mono ${stackCell}`}>
                    <TruncatedText text={occurrence.service ?? ""} className="max-w-48" />
                  </TableCell>
                  <TableCell data-label={headings.system} className={`font-mono ${stackCell}`}>
                    {/* The tooltip names the span too. */}
                    <TruncatedText text={traceTitle(occurrence)} className="max-w-40">
                      {hasTrace(occurrence) ? (
                        <TraceLink
                          projectId={projectId}
                          occurrence={occurrence}
                          className="text-link hover:underline"
                        />
                      ) : (
                        <span className="font-sans text-ink-subtle">(none)</span>
                      )}
                    </TruncatedText>
                  </TableCell>
                </>
              ) : (
                <>
                  <TableCell data-label={headings.browser} className={stackCell}>
                    {browserText(occurrence) || "(unknown)"}
                  </TableCell>
                  <TableCell data-label={headings.system} className={stackCell}>
                    {occurrence.os ?? "(unknown)"}
                  </TableCell>
                </>
              )}
              <TableCell data-label="Release" className={stackCell}>
                {occurrence.release ?? "(unknown)"}
              </TableCell>
              {showReplays && (
                <TableCell data-label="Replay" className={`py-1 ${stackCell}`}>
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
    </DetailSection>
  );
}

/**
 * One error group in full: its status (with Resolve or Reopen), its numbers,
 * the latest occurrence's server (for a server's exception), the latest
 * stack (a browser's mapped with the release's source maps where it can be),
 * its latest occurrences, a trend, where it happens, and the alert rules that
 * watch it. The page and the errors workbench both show it.
 */
function Detail({
  projectId,
  detail,
  environment,
  resolveRef,
  actions,
}: {
  projectId: string;
  detail: ErrorDetail;
  environment: string;
  resolveRef?: React.Ref<HTMLButtonElement>;
  actions?: React.ReactNode;
}) {
  const { group } = detail;
  const latest = detail.occurrences[0];
  const { canUse } = useAccess();
  return (
    <div className="@container flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-xl font-semibold break-words text-ink">{group.type}</h2>
            {group.message !== "" && (
              <p className="font-mono text-sm break-words whitespace-pre-wrap text-ink-muted">
                {group.message}
              </p>
            )}
          </div>
          {actions}
        </div>
        <Resolution
          projectId={projectId}
          detail={detail}
          buttonRef={resolveRef}
          keyHint={resolveRef !== undefined}
        />
      </div>
      <Stats detail={detail} />
      {detail.source === "server" && latest !== undefined && (
        <ServerSection projectId={projectId} occurrence={latest} />
      )}
      <StackCard
        projectId={projectId}
        source={detail.source}
        stack={detail.stack}
        frames={detail.frames}
        sourceMaps={detail.sourceMaps}
        className={SECTION_LOOK}
      />
      <Occurrences projectId={projectId} detail={detail} environment={environment} />
      <DayCountCard
        days={detail.days.map((day) => ({ day: day.day, count: day.occurrences }))}
        noun="Occurrences"
        className={SECTION_LOOK}
      />
      <Breakdowns detail={detail} />
      {canUse("uptime_alerts") && (
        <AlertRulesCard
          projectId={projectId}
          watched={{ fingerprint: group.fingerprint, environment, status: group.status }}
          className={SECTION_LOOK}
        />
      )}
    </div>
  );
}

/** The group has no occurrence in the period and environment shown. */
function NoOccurrence({
  projectId,
  fingerprint,
  search,
  inWorkbench,
}: {
  projectId: string;
  fingerprint: string;
  search: ErrorsSearch;
  /** Beside the errors list: its links change the list's address and stay on it. */
  inWorkbench: boolean;
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
      {inWorkbench ? (
        <EmptyContent className="flex-row flex-wrap justify-center">
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/errors"
            params={{ projectId }}
            search={(previous) => ({ ...previous, error: undefined })}
          >
            All errors
          </ButtonLink>
          {!isYear && (
            <ButtonLink
              variant="outline"
              to="/projects/$projectId/errors"
              params={{ projectId }}
              search={(previous) => ({
                ...previous,
                period: "12m",
                from: undefined,
                to: undefined,
              })}
            >
              Show the last 12 months
            </ButtonLink>
          )}
        </EmptyContent>
      ) : (
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
      )}
    </Empty>
  );
}

/**
 * An error group's detail for a period and environment, with its loading,
 * failed, and empty states: on its own page, and in the errors workbench
 * beside the list.
 */
export function ErrorView({
  projectId,
  fingerprint,
  range,
  environment,
  resolveRef,
  actions,
}: {
  projectId: string;
  fingerprint: string;
  range: PageRange;
  environment: string;
  /** The Resolve or Reopen button, for a key that presses it. */
  resolveRef?: React.Ref<HTMLButtonElement>;
  /** Beside the error's name, such as a link to its own page. */
  actions?: React.ReactNode;
}) {
  const query = useQuery(errorQuery(projectId, fingerprint, range, environment));
  const search: ErrorsSearch = { range, environment };
  if (isUnknownProject(query.error)) {
    return <NoSuchProject />;
  }
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <NoOccurrence
        projectId={projectId}
        fingerprint={fingerprint}
        search={search}
        inWorkbench={resolveRef !== undefined}
      />
    );
  }
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="grid grid-cols-3 gap-4 border-t pt-5">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
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
    );
  }
  return (
    <Detail
      projectId={projectId}
      detail={query.data}
      environment={environment}
      resolveRef={resolveRef}
      actions={actions}
    />
  );
}

/**
 * One error group on its own page, for deep links and narrow screens: the
 * period and environment in the filter bar, then its detail.
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

  return (
    <div className="flex flex-col">
      <FilterBar
        label="Period and environment"
        period={
          <PeriodSelect range={range} answered={data} onRange={(next) => show({ range: next })} />
        }
        environment={
          <EnvironmentSelect
            environment={environment}
            answered={data}
            onEnvironment={(next) => show({ environment: next })}
          />
        }
        range={
          data !== undefined && (
            <FilterBarRange
              firstDay={data.firstDay}
              lastDay={data.lastDay}
              timeZone={data.timeZone}
            />
          )
        }
      />
      <div className="flex flex-col gap-4 px-gutter py-5">
        <Link
          to="/projects/$projectId/errors"
          params={{ projectId }}
          search={errorsSearchOf(search)}
          className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          All errors
        </Link>
        <ErrorView
          projectId={projectId}
          fingerprint={fingerprint}
          range={range}
          environment={environment}
        />
      </div>
    </div>
  );
}
