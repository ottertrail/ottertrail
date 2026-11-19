import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  FilmIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  SearchXIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
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
import {
  Workbench,
  WorkbenchKeyHints,
  type WorkbenchListProps,
  WorkbenchStartHint,
} from "@/components/workbench";
import {
  atLeast,
  GUTTER_END,
  GUTTER_START,
  LIST_HEAD,
  SELECTED_ROW,
  selectOnPlainClick,
} from "@/components/workbench-rows";
import { NARROW_WORKBENCH, useMediaQuery } from "@/hooks/use-media-query";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  MIN_REPLAY_DURATIONS,
  type ReplayFilters,
  replayListQuery,
  type ReplayList,
  replaysQuery,
  type ReplaySummary,
} from "@/lib/replays-api";

import { formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "../telemetry/filters";
import { formatMoment } from "../users/format";
import { formatReplayDuration, pagesText } from "./format";
import { ReplayView } from "./replay-page";
import { type ReplaysSearch, replaysSearchOf } from "./search";

const DURATION_CHOICES = MIN_REPLAY_DURATIONS.map((ms) => ({
  value: String(ms),
  label: `${formatReplayDuration(ms)} or longer`,
}));

/** A user ID as the API takes it: no control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const USER_ID = /^[^\u0000-\u001F\u007F-\u009F]{1,200}$/u;

/** The error a replay shows, as plain text in the list: its link is in the detail. */
function errorText(replay: ReplaySummary): string {
  const { error } = replay;
  if (error === null) return replay.linked ? "Error not found" : "Looking for its error…";
  return `${error.type}${error.message === "" ? "" : `: ${error.message}`}`;
}

/**
 * The listed replays, newest first: when (the row's link, to the replay's
 * own page; in the workbench a plain click selects the row instead), its
 * error, user, and pages under it, and its length.
 */
function ReplayTable({
  replays,
  projectId,
  timeZone,
  selected,
  select,
}: {
  replays: readonly ReplaySummary[];
  projectId: string;
  timeZone: string;
} & WorkbenchListProps) {
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Session replays, newest first</caption>
      <colgroup>
        <col />
        <col className="w-24" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            Replay
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} text-right ${GUTTER_END}`}>
            Length
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {replays.map((replay) => {
          const chosen = replay.id === selected;
          const when = formatMoment(replay.startedAt, timeZone);
          const error = errorText(replay);
          const pages = pagesText(replay.pages);
          return (
            <TableRow
              key={replay.id}
              data-workbench-id={replay.id}
              data-state={chosen ? "selected" : undefined}
              className={SELECTED_ROW}
            >
              <TableCell className={`${GUTTER_START} py-2.5 align-top whitespace-normal`}>
                <Link
                  to="/projects/$projectId/replays/$replayId"
                  params={{ projectId, replayId: replay.id }}
                  aria-current={chosen ? "true" : undefined}
                  onClick={selectOnPlainClick(select, replay.id)}
                  className="rounded-sm font-medium text-link hover:underline"
                  aria-label={`Replay at ${when}`}
                >
                  <time dateTime={replay.startedAt}>{when}</time>
                </Link>
                <p
                  className={
                    replay.error === null
                      ? "mt-1 truncate text-sm text-ink-subtle"
                      : "mt-1 truncate text-sm text-ink"
                  }
                  title={error}
                >
                  {error}
                </p>
                <p className="mt-0.5 flex min-w-0 gap-x-3 text-xs text-ink-subtle">
                  <span
                    className={
                      replay.userId === null ? "shrink-0" : "max-w-40 shrink-0 truncate font-mono"
                    }
                    title={replay.userId ?? undefined}
                  >
                    {replay.userId ?? "Anonymous"}
                  </span>
                  <span className="min-w-0 truncate font-mono" title={pages}>
                    {pages}
                  </span>
                </p>
              </TableCell>
              <TableCell
                className={`py-2.5 text-right align-top whitespace-nowrap tabular-nums ${GUTTER_END}`}
              >
                <span className="flex flex-col items-end gap-1">
                  {formatReplayDuration(replay.durationMs)}
                  {replay.cut && (
                    <StatusBadge
                      tone="neutral"
                      title="The recording reached its size limit, or the visitor left before the entire recording was sent."
                    >
                      Cut
                    </StatusBadge>
                  )}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The most errors the summary names, by replays. */
const TOP_ERRORS = 5;

/**
 * With nothing selected, the detail pane sums up the replays listed (only
 * those loaded, so "at least" while older ones wait), then the errors with
 * the most replays in the period, which the API counts whatever the other
 * filters: each name filters the list by its error.
 */
function Summary({
  first,
  replays,
  more,
  projectId,
}: {
  first: ReplayList;
  replays: readonly ReplaySummary[];
  more: boolean;
  projectId: string;
}) {
  const users = new Set(replays.flatMap((replay) => replay.userId ?? [])).size;
  const errors = new Set(replays.flatMap((replay) => replay.error?.fingerprint ?? [])).size;
  const stats: Stat[] = [
    { label: "Replays", value: atLeast(replays.length, more) },
    { label: "Cut short", value: atLeast(replays.filter((replay) => replay.cut).length, more) },
    { label: "Known users", value: atLeast(users, more) },
    { label: "Errors", value: atLeast(errors, more) },
  ];
  const ranked = first.errorGroups.slice(0, TOP_ERRORS);
  const headingId = React.useId();
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">This period</h2>
        <FilterBarRange
          firstDay={first.firstDay}
          lastDay={first.lastDay}
          timeZone={first.timeZone}
        />
      </div>
      <section aria-label="Replays in the list" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Replays in the list" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          {more
            ? `These count the ${formatWhole(replays.length)} newest replays loaded, so each is at least that many. Load older replays to count more. `
            : "These count every replay in the list. "}
          Known users have your site&apos;s user ID. Errors counts error groups, once each.
        </p>
      </section>
      {ranked.length > 0 && (
        <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t pt-5">
          <div className="flex flex-col gap-1">
            <h3 id={headingId} className="text-base font-medium text-ink">
              Errors with the most replays
            </h3>
            <p className="text-sm text-muted-foreground">
              In this period and environment, whatever the other filters. Choose one to list only
              its replays.
            </p>
          </div>
          <Table className="table-fixed">
            <caption className="sr-only">Errors with the most replays, most first</caption>
            <colgroup>
              <col />
              <col className="w-20" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={`${LIST_HEAD} pl-0`}>
                  Error
                </TableHead>
                <TableHead scope="col" className={`${LIST_HEAD} pr-0 text-right`}>
                  Replays
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((group) => (
                <TableRow key={group.fingerprint} className="hover:bg-transparent">
                  <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                    <Link
                      to="/projects/$projectId/replays"
                      params={{ projectId }}
                      search={(previous) => ({
                        ...previous,
                        error: group.fingerprint,
                        replay: undefined,
                      })}
                      className="block truncate font-medium text-link hover:underline"
                      title={`${group.type}: ${group.message}`}
                    >
                      {group.type}
                    </Link>
                    {group.message !== "" && (
                      <div className="truncate text-ink-muted" title={group.message}>
                        {group.message}
                      </div>
                    )}
                  </th>
                  <TableCell className="py-1.5 pr-0 text-right align-top tabular-nums">
                    {formatWhole(group.replays)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <WorkbenchStartHint noun="a replay" />
    </div>
  );
}

/** Why the list is empty: replays off, none in the period, or none that match. */
function NoReplays({
  projectId,
  filtered,
  recordingOff,
  environment,
}: {
  projectId: string;
  filtered: boolean;
  recordingOff: boolean;
  environment: string;
}) {
  return (
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
  );
}

/**
 * A project's session replays as a workbench (docs/design-system.md,
 * "Workbench"): each one recorded around an error (docs/session-replay.md),
 * newest first, for a period and an environment, filtered by a path
 * visited, a user, an error group, and a minimum length, fifty at a time
 * with older ones on request; beside the selected replay's detail and
 * player or, with none selected, a summary. Under 64rem a row opens the
 * replay's own page.
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
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  const search: ReplaysSearch = { range, environment, filters };
  // A filter keeps the selected replay beside the list, listed or not.
  const show = (next: Partial<ReplaysSearch>) =>
    void navigate({
      to: "/projects/$projectId/replays",
      params: { projectId },
      search: (previous: Record<string, unknown>) => ({
        ...replaysSearchOf({ ...search, ...next }),
        replay: typeof previous.replay === "string" ? previous.replay : undefined,
      }),
    });
  const filter = (next: Partial<ReplayFilters>) => show({ filters: { ...filters, ...next } });
  // The Workbench keeps the latest of this, so it may be a new function each render.
  const openPage = (replayId: string) =>
    void navigate({
      to: "/projects/$projectId/replays/$replayId",
      params: { projectId, replayId },
    });

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

  const filterBar = (
    <ReportFilterBar
      label="Period, environment, and filters"
      range={range}
      environment={environment}
      answered={first}
      onRange={(next) => show({ range: next })}
      onEnvironment={(next) =>
        show({ environment: next, filters: { ...filters, fingerprint: undefined } })
      }
      filters={
        first?.configured !== false && (
          <>
            <TextFilter
              label="Path contains"
              placeholder="Path contains…"
              value={filters.path}
              onChange={(path) => filter({ path })}
              className="w-44"
            />
            <TextFilter
              label="User ID"
              placeholder="User ID…"
              value={filters.userId}
              onChange={(userId) => filter({ userId })}
              pattern={USER_ID}
              invalidMessage="A user ID has no control characters."
              className="w-36"
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
              className="w-52"
            />
            <ChoiceFilter
              label="Minimum length"
              anyLabel="Any length"
              choices={DURATION_CHOICES}
              value={filters.minDuration === undefined ? undefined : String(filters.minDuration)}
              onChange={(value) =>
                filter({ minDuration: value === undefined ? undefined : Number(value) })
              }
              className="w-36"
            />
          </>
        )
      }
      actions={first?.configured === true && <WorkbenchKeyHints />}
    />
  );

  const failure = list.isError && (
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
  );

  if (first === undefined) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="px-gutter py-5">
          {list.isError ? (
            failure
          ) : (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!first.configured) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="px-gutter py-5">
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
        </div>
      </div>
    );
  }

  const empty = replays.length === 0;
  const guidance = (
    <NoReplays
      projectId={projectId}
      filtered={filtered}
      recordingOff={recordingOff}
      environment={environment}
    />
  );
  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      {filterBar}
      <Workbench
        label="Replays"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={replays.map((replay) => replay.id)}
        param="replay"
        filterKey={JSON.stringify([range, environment, filters])}
        onOpenPage={openPage}
        renderList={(props) => (
          <div
            className="flex flex-col transition-opacity data-[stale=true]:opacity-60"
            data-stale={list.isPlaceholderData}
            aria-busy={list.isPlaceholderData}
          >
            {list.isError && <div className="px-gutter pt-4">{failure}</div>}
            {empty ? (
              narrow ? (
                // No room for the guidance beside the list: it takes the list's place.
                <div className="px-gutter py-5">{guidance}</div>
              ) : (
                <p className="px-gutter py-6 text-sm text-ink-subtle">
                  {filtered ? "No replay matches these filters." : "No replays in this period."}
                </p>
              )
            ) : (
              <ReplayTable
                replays={replays}
                projectId={projectId}
                timeZone={first.timeZone}
                {...props}
              />
            )}
            {list.hasNextPage && (
              <Button
                variant="outline"
                className="my-4 self-center"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage && (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                )}
                Load older replays
              </Button>
            )}
          </div>
        )}
        summary={
          empty ? (
            <div className="px-gutter py-5">{guidance}</div>
          ) : (
            <Summary
              first={first}
              replays={replays}
              more={list.hasNextPage}
              projectId={projectId}
            />
          )
        }
        renderDetail={(replayId) => (
          <div className="px-gutter py-5">
            <ReplayView
              key={replayId}
              projectId={projectId}
              replayId={replayId}
              inWorkbench
              actions={
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  to="/projects/$projectId/replays/$replayId"
                  params={{ projectId, replayId }}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  Open the replay&apos;s page
                </ButtonLink>
              }
            />
          </div>
        )}
      />
    </div>
  );
}
