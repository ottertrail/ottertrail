import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon, SearchXIcon, UsersIcon } from "lucide-react";
import * as React from "react";

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
import { useSettled } from "@/hooks/use-settled";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { usersQuery } from "@/lib/users-api";

import { NoSuchProject } from "../projects/no-such-project";
import { formatDay, formatMoment, timeAgo } from "./format";

/** How a site names its signed-in user, shown while it names none. */
const IDENTIFY_EXAMPLE = `<script defer src="…/t.js" data-key="…" data-host="…" data-user-id="42"></script>

window.ottertrail?.identify("42"); // signed in without a page load
window.ottertrail?.reset(); // signed out without a page load`;

/**
 * The project's known users: the IDs a site sends for its signed-in users,
 * most recently seen first, in one environment, with a search by ID.
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
  const first = list.data?.pages[0];
  // Pages come by offset in order of last seen: a user seen again between
  // two pages moves up, and the next page would list them twice.
  const users = [
    ...new Map(
      (list.data?.pages ?? []).flatMap((page) => page.users).map((user) => [user.userId, user]),
    ).values(),
  ];

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }

  const noneYet = first !== undefined && users.length === 0 && search === "";
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-2">
        {first !== undefined &&
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
          )}
        {!noneYet && (
          <Input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search by user ID"
            aria-label="Search by user ID"
            autoComplete="off"
            className="w-full max-w-xs"
          />
        )}
      </div>

      {list.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : list.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The users could not load</AlertTitle>
          <AlertDescription>{list.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : noneYet ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No known users yet</EmptyTitle>
            <EmptyDescription>
              Visitors are anonymous until your site says who is signed in: on every page while
              someone is, add <code className="font-mono">data-user-id</code> to the tracking
              snippet, with your own ID for them, such as their ID in your database, not an email
              address. A single-page app that signs people in or out without a page load calls{" "}
              <code className="font-mono">identify()</code> and{" "}
              <code className="font-mono">reset()</code>. Ottertrail keeps the ID in memory on the
              page: nothing is stored on the visitor&apos;s device.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="max-w-2xl text-left">
            <CopyableCode text={IDENTIFY_EXAMPLE} copyLabel="Copy the example" />
          </EmptyContent>
        </Empty>
      ) : users.length === 0 ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>No user ID contains “{search}”</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
          data-stale={list.isPlaceholderData}
        >
          <Table>
            <caption className="sr-only">Known users, most recently seen first</caption>
            <TableHeader>
              <TableRow>
                <TableHead>User ID</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>First seen</TableHead>
                <TableHead className="text-right">Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.userId}>
                  <TableCell className="max-w-xs truncate font-mono">
                    <Link
                      to="/projects/$projectId/users/$userId"
                      params={{ projectId, userId: user.userId }}
                      search={environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }}
                      className="text-link hover:underline"
                    >
                      {user.userId}
                    </Link>
                  </TableCell>
                  <TableCell title={formatMoment(user.lastSeenAt, first?.timeZone)}>
                    {timeAgo(new Date(user.lastSeenAt))}
                  </TableCell>
                  <TableCell>{formatDay(user.firstSeenAt, first?.timeZone)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {user.events.toLocaleString("en-US")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
