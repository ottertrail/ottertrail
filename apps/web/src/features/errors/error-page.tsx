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

import { DayCountCard } from "../analytics/day-count-card";
import { formatWhole } from "../analytics/format";
import { RankedList } from "../analytics/ranked-list";
import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment } from "../users/format";
import { ErrorStatusBadge } from "./error-status";
import { RangeControls } from "./range-controls";
import { type ErrorsSearch, errorsSearchOf } from "./search";

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
  const when = group.resolvedAt === null ? "" : formatMoment(group.resolvedAt, timeZone);
  const by = group.resolvedBy === null ? "" : ` by ${group.resolvedBy}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ErrorStatusBadge status={group.status} />
        <Button
          variant={resolved ? "outline" : "default"}
          size="sm"
          disabled={change.isPending}
          onClick={() => change.mutate(resolved ? "unresolved" : "resolved")}
        >
          {change.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {resolved ? "Reopen" : "Resolve"}
        </Button>
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

const BREAKDOWN_CARDS: { name: ErrorBreakdown; title: string; heading: string }[] = [
  { name: "path", title: "Pages", heading: "Path" },
  { name: "browser", title: "Browsers", heading: "Browser" },
  { name: "os", title: "Operating systems", heading: "Operating system" },
  { name: "release", title: "Releases", heading: "Release" },
];

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

function StackCard({ stack }: { stack: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Stack trace</h3>
        </CardTitle>
        <CardDescription>
          The latest occurrence&apos;s stack, as the browser reported it. Source maps, to show your
          original files and lines, are planned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {stack === null ? (
          <p className="text-sm text-ink-subtle">The browser gave no stack trace for this error.</p>
        ) : (
          <pre className="max-h-96 overflow-auto rounded-lg bg-canvas p-4 font-mono text-code text-ink-muted ring-1 ring-border">
            {stack}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

/** "Firefox 132.0", or whichever part is known. */
const browserText = (occurrence: Occurrence) =>
  [occurrence.browser, occurrence.browserVersion].filter((part) => part !== null).join(" ");

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
              <TableHead>Page</TableHead>
              <TableHead>Browser</TableHead>
              <TableHead>Operating system</TableHead>
              <TableHead>Release</TableHead>
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
                      <Badge variant="secondary" title="Reported with captureError()">
                        Caught
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="max-w-48 truncate">
                  {occurrence.userId === null ? (
                    <span className="text-ink-subtle">Anonymous</span>
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
                <TableCell>{browserText(occurrence) || "(unknown)"}</TableCell>
                <TableCell>{occurrence.os ?? "(unknown)"}</TableCell>
                <TableCell>{occurrence.release ?? "(unknown)"}</TableCell>
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
      <DayCountCard
        days={detail.days.map((day) => ({ day: day.day, count: day.occurrences }))}
        noun="Occurrences"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {BREAKDOWN_CARDS.map((card) => (
          <BreakdownCard
            key={card.name}
            title={card.title}
            heading={card.heading}
            rows={breakdowns[card.name]}
            mono={card.name === "path"}
          />
        ))}
      </div>
      <StackCard stack={detail.stack} />
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
 * trend for a period, where it happens, the latest stack trace, and its
 * latest occurrences.
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
