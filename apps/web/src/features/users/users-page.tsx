import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  SearchXIcon,
  UsersIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { CopyableCode } from "@/components/copyable-code";
import { FilterBar } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  ROW_LINK,
  selectOnPlainClick,
  workbenchRow,
} from "@/components/workbench-rows";
import { NARROW_WORKBENCH, useMediaQuery } from "@/hooks/use-media-query";
import { useSettled } from "@/hooks/use-settled";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type User, usersQuery } from "@/lib/users-api";

import { formatWhole } from "../analytics/format";
import { NoSuchProject } from "../projects/no-such-project";
import { formatMoment, timeAgo } from "./format";
import { UserView } from "./user-page";

/** How a site names its signed-in user, shown while it names none. */
const IDENTIFY_EXAMPLE = `<script defer src="…/t.js" data-key="…" data-host="…" data-user-id="42"></script>

window.ottertrail?.identify("42"); // signed in without a page load
window.ottertrail?.reset(); // signed out without a page load`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most users the summary names, by events. */
const TOP_USERS = 5;

function NoUsersYet() {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle>No known users yet</EmptyTitle>
        <EmptyDescription>
          Visitors are anonymous until your site identifies the signed-in user. On every page while
          a user is signed in, add <code className="font-mono">data-user-id</code> to the tracking
          snippet, with your own ID for them, such as their ID in your database, not an email
          address. A single-page app that signs people in or out without a page load calls{" "}
          <code className="font-mono">identify()</code> and{" "}
          <code className="font-mono">reset()</code>. Ottertrail keeps the ID in the page's memory.
          It stores nothing on the visitor's device.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl text-left">
        <CopyableCode text={IDENTIFY_EXAMPLE} copyLabel="Copy the example" />
      </EmptyContent>
    </Empty>
  );
}

/**
 * The listed users, most recently seen first: the ID (the row's link, to
 * the user's own page; in the workbench a plain click selects the row
 * instead), when last seen, and their events.
 */
function UserTable({
  users,
  projectId,
  environment,
  timeZone,
  selected,
  select,
}: {
  users: readonly User[];
  projectId: string;
  environment: string;
  timeZone: string | undefined;
} & WorkbenchListProps) {
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Known users, most recently seen first</caption>
      <colgroup>
        <col />
        <col className="w-32" />
        <col className="w-24" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            User ID
          </TableHead>
          <TableHead scope="col" className={LIST_HEAD}>
            Last seen
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} text-right ${GUTTER_END}`}>
            Events
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => {
          const chosen = user.userId === selected;
          return (
            <TableRow key={user.userId} {...workbenchRow(user.userId, chosen)}>
              <TableCell className={`${GUTTER_START} py-2.5 font-mono`}>
                <Link
                  to="/projects/$projectId/users/$userId"
                  params={{ projectId, userId: user.userId }}
                  search={environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }}
                  aria-current={chosen ? "true" : undefined}
                  {...ROW_LINK}
                  onClick={selectOnPlainClick(select, user.userId)}
                  className="block truncate rounded-sm text-link hover:underline"
                  title={user.userId}
                >
                  {user.userId}
                </Link>
              </TableCell>
              <TableCell
                className="truncate py-2.5"
                title={formatMoment(user.lastSeenAt, timeZone)}
              >
                {timeAgo(new Date(user.lastSeenAt))}
              </TableCell>
              <TableCell className={`py-2.5 text-right tabular-nums ${GUTTER_END}`}>
                {user.events.toLocaleString("en-US")}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * How many of the loaded users were seen (or first seen) within a window:
 * exact once the list is whole or reaches past the window, which it does
 * in order of last seen; "at least" otherwise.
 */
function windowCount(
  users: readonly User[],
  more: boolean,
  windowMs: number,
  field: "lastSeenAt" | "firstSeenAt",
) {
  const since = Date.now() - windowMs;
  const count = users.filter((user) => Date.parse(user[field]) >= since).length;
  const oldest = users.at(-1);
  const reachesPast = oldest !== undefined && Date.parse(oldest.lastSeenAt) < since;
  return atLeast(count, more && !reachesPast);
}

/**
 * With nothing selected, the detail pane sums up the users loaded: how many,
 * how many were seen lately or are new, and the most active of them.
 */
function Summary({
  users,
  more,
  search,
  projectId,
}: {
  users: readonly User[];
  more: boolean;
  search: string;
  projectId: string;
}) {
  const stats: Stat[] = [
    { label: "Users", value: atLeast(users.length, more) },
    { label: "Seen in 24 hours", value: windowCount(users, more, DAY_MS, "lastSeenAt") },
    { label: "Seen in 7 days", value: windowCount(users, more, 7 * DAY_MS, "lastSeenAt") },
    { label: "New in 7 days", value: windowCount(users, more, 7 * DAY_MS, "firstSeenAt") },
  ];
  const ranked = users.toSorted((a, b) => b.events - a.events).slice(0, TOP_USERS);
  const headingId = React.useId();
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">Known users</h2>
        <p className="text-sm text-ink-subtle">
          {search === "" ? "Every user ID your site sent." : `User IDs that contain “${search}”.`}
        </p>
      </div>
      <section aria-label="Users in the list" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Users in the list" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          {more
            ? `These count the ${formatWhole(users.length)} users seen most recently, loaded so far. A figure marked + may be higher. `
            : "These count every user in the list. "}
          New users were first seen in the last 7 days.
        </p>
      </section>
      <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-base font-medium text-ink">
            Most events
          </h3>
          <p className="text-sm text-muted-foreground">
            {more
              ? `Among the ${formatWhole(users.length)} seen most recently, by pageviews and custom events.`
              : "By pageviews and custom events."}
          </p>
        </div>
        <Table className="table-fixed">
          <caption className="sr-only">Users with the most events, most first</caption>
          <colgroup>
            <col />
            <col className="w-24" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={`${LIST_HEAD} pl-0`}>
                User ID
              </TableHead>
              <TableHead scope="col" className={`${LIST_HEAD} pr-0 text-right`}>
                Events
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ranked.map((user) => (
              <TableRow key={user.userId} className="hover:bg-transparent">
                <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                  <Link
                    to="/projects/$projectId/users"
                    params={{ projectId }}
                    search={(previous) => ({ ...previous, user: user.userId })}
                    className="block truncate font-mono text-link hover:underline"
                    title={user.userId}
                  >
                    {user.userId}
                  </Link>
                </th>
                <TableCell className="py-1.5 pr-0 text-right align-top tabular-nums">
                  {user.events.toLocaleString("en-US")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <WorkbenchStartHint noun="a user" />
    </div>
  );
}

/**
 * The project's known users as a workbench (docs/design-system.md,
 * "Workbench"): the IDs a site sends for its signed-in users, most
 * recently seen first, in one environment, with a search by ID; beside the
 * selected user's activity or, with none selected, a summary. Under 64rem a
 * row opens the user's own page.
 */
export function UsersPage({
  projectId,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  environment?: string;
}) {
  const navigate = useNavigate();
  const [text, setText] = React.useState("");
  const search = useSettled(text.trim(), 250);
  const list = useInfiniteQuery(usersQuery(projectId, environment, search));
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  const first = list.data?.pages[0];
  // Pages come by offset in order of last seen: a user seen again between
  // two pages moves up, and the next page would list them twice.
  const users = [
    ...new Map(
      (list.data?.pages ?? []).flatMap((page) => page.users).map((user) => [user.userId, user]),
    ).values(),
  ];
  const userSearch = environment === DEFAULT_ENVIRONMENT ? {} : { env: environment };
  // The Workbench keeps the latest of this, so it may be a new function each render.
  const openPage = (userId: string) =>
    void navigate({
      to: "/projects/$projectId/users/$userId",
      params: { projectId, userId },
      search: userSearch,
    });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }

  const noneYet = first !== undefined && users.length === 0 && search === "";
  const filterBar = (
    <FilterBar
      label="Environment and search"
      environment={
        first !== undefined &&
        (first.environments.length > 1 || environment !== DEFAULT_ENVIRONMENT) && (
          <Select
            items={first.environments.map((name) => ({ value: name, label: name }))}
            value={environment}
            onValueChange={(value) => {
              if (typeof value === "string") {
                void navigate({
                  to: "/projects/$projectId/users",
                  params: { projectId },
                  search: value === DEFAULT_ENVIRONMENT ? {} : { env: value },
                });
              }
            }}
          >
            <SelectTrigger aria-label="Environment" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {first.environments.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
      filters={
        !noneYet && (
          <Input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search by user ID"
            aria-label="Search by user ID"
            autoComplete="off"
            className="w-64 max-w-full"
          />
        )
      }
      range={
        first?.timeZone !== undefined && (
          <p className="text-sm whitespace-nowrap text-ink-subtle">{first.timeZone}</p>
        )
      }
      actions={first !== undefined && !noneYet && <WorkbenchKeyHints />}
    />
  );

  if (list.isPending || (list.isError && first === undefined) || noneYet) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="px-gutter py-5">
          {list.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : noneYet ? (
            <NoUsersYet />
          ) : (
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>The users could not load</AlertTitle>
              <AlertDescription>{list.error?.message}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          )}
        </div>
      </div>
    );
  }

  const more = list.hasNextPage;
  const noMatch = (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No user ID contains “{search}”</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      {filterBar}
      <Workbench
        label="Users"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={users.map((user) => user.userId)}
        param="user"
        filterKey={search}
        onOpenPage={openPage}
        renderList={(props) => (
          <div
            className="flex flex-col transition-opacity data-[stale=true]:opacity-60"
            data-stale={list.isPlaceholderData}
          >
            {list.isError && (
              <div className="px-gutter pt-4">
                <Alert variant="destructive">
                  <OctagonAlertIcon />
                  <AlertTitle>The users could not refresh</AlertTitle>
                  <AlertDescription>
                    {list.error.message} The list below is from the last successful load.
                  </AlertDescription>
                  <AlertAction>
                    <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              </div>
            )}
            {users.length === 0 ? (
              narrow ? (
                <div className="px-gutter py-5">{noMatch}</div>
              ) : (
                <p className="px-gutter py-6 text-sm text-ink-subtle">
                  No user ID contains “{search}”.
                </p>
              )
            ) : (
              <UserTable
                users={users}
                projectId={projectId}
                environment={environment}
                timeZone={first?.timeZone}
                {...props}
              />
            )}
            {more && (
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
                Load more
              </Button>
            )}
          </div>
        )}
        summary={
          users.length === 0 ? (
            <div className="px-gutter py-5">{noMatch}</div>
          ) : (
            <Summary users={users} more={more} search={search} projectId={projectId} />
          )
        }
        renderDetail={(userId) => (
          <div className="px-gutter py-5">
            <UserView
              key={userId}
              projectId={projectId}
              userId={userId}
              environment={environment}
              inWorkbench
              actions={
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  to="/projects/$projectId/users/$userId"
                  params={{ projectId, userId }}
                  search={userSearch}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  Open the user&apos;s page
                </ButtonLink>
              }
            />
          </div>
        )}
      />
    </div>
  );
}
