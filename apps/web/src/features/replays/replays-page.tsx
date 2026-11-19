import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FilmIcon, LoaderCircleIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { StatusBadge } from "@/components/status-badge";
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
import { WhenAllowed } from "@/components/when-allowed";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  MIN_REPLAY_DURATIONS,
  type ReplayFilters,
  replayListQuery,
  replaysQuery,
  type ReplaySummary,
} from "@/lib/replays-api";

import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "../telemetry/filters";
import { dayKey, formatMoment } from "../users/format";
import { clientText, formatReplayDuration, pagesText } from "./format";
import { type ReplaysSearch, replaysSearchOf } from "./search";

const DURATION_CHOICES = MIN_REPLAY_DURATIONS.map((ms) => ({
  value: String(ms),
  label: `${formatReplayDuration(ms)} or longer`,
}));

/** A user ID as the API takes it: no control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const USER_ID = /^[^\u0000-\u001F\u007F-\u009F]{1,200}$/u;

/** The error a replay shows, linked to its group's page, on days that include it. */
export function ReplayErrorLink({
  projectId,
  replay,
  timeZone,
}: {
  projectId: string;
  replay: ReplaySummary;
  timeZone: string;
}) {
  const { error } = replay;
  if (error === null) {
    return (
      <span className="text-ink-subtle">
        {replay.linked ? "Error not found" : "Looking for its error…"}
      </span>
    );
  }
  const text = `${error.type}${error.message === "" ? "" : `: ${error.message}`}`;
  const environment = replay.environment ?? DEFAULT_ENVIRONMENT;
  return (
    <WhenAllowed
      area="errors"
      fallback={
        <span className="block truncate" title={text}>
          <span className="font-medium">{error.type}</span>
          {error.message !== "" && `: ${error.message}`}
        </span>
      }
    >
      <Link
        to="/projects/$projectId/errors/$fingerprint"
        params={{ projectId, fingerprint: error.fingerprint }}
        // The error's own day, where it surely has an occurrence.
        search={{
          from: dayKey(error.occurredAt, timeZone),
          to: dayKey(error.occurredAt, timeZone),
          ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
        }}
        className="block truncate text-link hover:underline"
        title={text}
      >
        <span className="font-medium">{error.type}</span>
        {error.message !== "" && `: ${error.message}`}
      </Link>
    </WhenAllowed>
  );
}

/**
 * A project's session replays, newest first: each one recorded around an
 * error (docs/session-replay.md), for a period and an environment, filtered
 * by a path visited, a user, an error group, and a minimum length; fifty at
 * a time, with older ones on request.
 */
export function ReplaysPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  filters,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  filters: ReplayFilters;
}) {
  const navigate = useNavigate();
  const list = useInfiniteQuery(replayListQuery(projectId, range, environment, filters));
  const overview = useQuery(replaysQuery(projectId));
  const search: ReplaysSearch = { range, environment, filters };
  const show = (next: Partial<ReplaysSearch>) =>
    void navigate({
      to: "/projects/$projectId/replays",
      params: { projectId },
      search: replaysSearchOf({ ...search, ...next }),
    });
  const filter = (next: Partial<ReplayFilters>) => show({ filters: { ...filters, ...next } });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const first = list.data?.pages[0];
  const replays = (list.data?.pages ?? []).flatMap((page) => page.replays);
  const filtered =
    filters.path !== undefined ||
    filters.userId !== undefined ||
    filters.fingerprint !== undefined ||
    filters.minDuration !== undefined;
  const recordingOff = overview.data?.mode === "off";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-3">
        <RangeControls
          range={range}
          environment={environment}
          answered={first}
          onRange={(next) => show({ range: next })}
          onEnvironment={(next) =>
            show({ environment: next, filters: { ...filters, fingerprint: undefined } })
          }
        />
        {first?.configured !== false && (
          <div className="flex flex-wrap items-center gap-2">
            <TextFilter
              label="Path contains"
              placeholder="Path contains…"
              value={filters.path}
              onChange={(path) => filter({ path })}
            />
            <TextFilter
              label="User ID"
              placeholder="User ID…"
              value={filters.userId}
              onChange={(userId) => filter({ userId })}
              pattern={USER_ID}
              invalidMessage="A user ID has no control characters."
              className="w-44"
            />
            <ChoiceFilter
              label="Error"
              anyLabel="Any error"
              choices={(first?.errorGroups ?? []).map((group) => ({
                value: group.fingerprint,
                label: `${group.type}${group.message === "" ? "" : `: ${group.message}`}`,
              }))}
              value={filters.fingerprint}
              onChange={(fingerprint) => filter({ fingerprint })}
              className="w-64"
            />
            <ChoiceFilter
              label="Minimum length"
              anyLabel="Any length"
              choices={DURATION_CHOICES}
              value={filters.minDuration === undefined ? undefined : String(filters.minDuration)}
              onChange={(value) =>
                filter({ minDuration: value === undefined ? undefined : Number(value) })
              }
            />
          </div>
        )}
      </div>

      {list.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {first === undefined ? "The replays could not load" : "The replays could not refresh"}
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
      ) : !first.configured ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FilmIcon />
            </EmptyMedia>
            <EmptyTitle>Session replay is disabled on this instance</EmptyTitle>
            <EmptyDescription>
              This instance has no object store for recordings. The project's settings explain how
              to configure one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={list.isPlaceholderData}
          aria-busy={list.isPlaceholderData}
        >
          {replays.length === 0 ? (
            <Empty className="border border-dashed p-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">{filtered ? <SearchXIcon /> : <FilmIcon />}</EmptyMedia>
                <EmptyTitle>
                  {filtered
                    ? "No replay matches these filters"
                    : recordingOff
                      ? "Replays are off for this project"
                      : "No replays in this period"}
                </EmptyTitle>
                <EmptyDescription>
                  {filtered
                    ? "Change or clear a filter to see more."
                    : recordingOff
                      ? "An admin can enable replays around errors in the project's settings. Pages then send recordings of the 30 to 60 seconds before an error. The visitor's browser masks the recordings."
                      : `No page sent a replay of an error${environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period. Replays are kept 30 days.`}
                </EmptyDescription>
              </EmptyHeader>
              {!filtered && recordingOff && (
                <WhenAllowed permission="projects">
                  <EmptyContent>
                    <ButtonLink
                      variant="outline"
                      to="/projects/$projectId/settings"
                      params={{ projectId }}
                      search={{ tab: "replay" }}
                    >
                      Open the project&apos;s settings
                    </ButtonLink>
                  </EmptyContent>
                </WhenAllowed>
              )}
            </Empty>
          ) : (
            <Table>
              <caption className="sr-only">Session replays, newest first</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Length</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Pages</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Browser</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {replays.map((replay) => (
                  <TableRow key={replay.id}>
                    <TableCell className="whitespace-nowrap">
                      <Link
                        to="/projects/$projectId/replays/$replayId"
                        params={{ projectId, replayId: replay.id }}
                        className="font-medium text-link hover:underline"
                        aria-label={`Replay at ${formatMoment(replay.startedAt, first.timeZone)}`}
                      >
                        <time dateTime={replay.startedAt}>
                          {formatMoment(replay.startedAt, first.timeZone)}
                        </time>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      <span className="inline-flex items-center gap-2">
                        {replay.cut && (
                          <StatusBadge
                            tone="neutral"
                            title="The recording reached its size limit, or the visitor left before the entire recording was sent."
                          >
                            Cut
                          </StatusBadge>
                        )}
                        {formatReplayDuration(replay.durationMs)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-64">
                      <ReplayErrorLink
                        projectId={projectId}
                        replay={replay}
                        timeZone={first.timeZone}
                      />
                    </TableCell>
                    <TableCell className="max-w-40">
                      {replay.userId === null ? (
                        <span className="text-ink-subtle">Anonymous</span>
                      ) : (
                        <WhenAllowed
                          area="users"
                          fallback={
                            <span
                              className="block truncate font-mono text-xs"
                              title={replay.userId}
                            >
                              {replay.userId}
                            </span>
                          }
                        >
                          <Link
                            to="/projects/$projectId/users/$userId"
                            params={{ projectId, userId: replay.userId }}
                            search={
                              replay.environment === null ||
                              replay.environment === DEFAULT_ENVIRONMENT
                                ? {}
                                : { env: replay.environment }
                            }
                            className="block truncate font-mono text-xs text-link hover:underline"
                            title={replay.userId}
                          >
                            {replay.userId}
                          </Link>
                        </WhenAllowed>
                      )}
                    </TableCell>
                    <TableCell
                      className="max-w-64 truncate font-mono text-xs"
                      title={pagesText(replay.pages)}
                    >
                      {pagesText(replay.pages)}
                    </TableCell>
                    <TableCell>{replay.environment ?? "—"}</TableCell>
                    <TableCell className="max-w-48 truncate">
                      {clientText(replay) === "" ? "—" : clientText(replay)}
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
              Load older replays
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
