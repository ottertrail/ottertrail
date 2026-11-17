import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, LoaderCircleIcon, OctagonAlertIcon, UserXIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type Activity, userQuery } from "@/lib/users-api";

import { countryName } from "../analytics/format";
import { dayKey, formatLongDay, formatMoment, formatTime } from "./format";

/** What happened: "Viewed /pricing", or a custom event's name, and its page if it has one. */
function ActivityTitle({ activity }: { activity: Activity }) {
  // An event the site's server sent may name no page.
  if (activity.path === "") {
    return <span className="font-medium">{activity.name}</span>;
  }
  if (activity.name === "pageview") {
    return (
      <>
        Viewed <span className="font-mono">{activity.path}</span>
      </>
    );
  }
  return (
    <>
      <span className="font-medium">{activity.name}</span>{" "}
      <span className="text-ink-subtle">
        on <span className="font-mono">{activity.path}</span>
      </span>
    </>
  );
}

/** Where and on what: "Firefox · Linux · Munich, Germany · 1.4.2". */
function activityDetails(activity: Activity): string {
  const place = [activity.city, activity.country === null ? null : countryName(activity.country)]
    .filter((part) => part !== null)
    .join(", ");
  return [activity.browser, activity.os, place === "" ? null : place, activity.release]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

/** A custom event's properties as "plan: free", one each. */
function Properties({ properties }: { properties: Record<string, unknown> }) {
  const entries = Object.entries(properties);
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Properties">
      {entries.map(([name, value]) => (
        <li key={name} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-ink">
          {name}: {String(value)}
        </li>
      ))}
    </ul>
  );
}

/**
 * One known user: when first and last seen, and what they did, newest
 * first, by day in the organization's timezone. Only events that carry the
 * user's ID: anonymous browsing before a sign-in is not theirs for sure.
 */
export function UserPage({
  projectId,
  userId,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  userId: string;
  environment?: string;
}) {
  const query = useInfiniteQuery(userQuery(projectId, userId, environment));
  const first = query.data?.pages[0];
  const activity = (query.data?.pages ?? []).flatMap((page) => page.activity);
  const timeZone = first?.timeZone;
  const usersSearch = environment === DEFAULT_ENVIRONMENT ? {} : { env: environment };

  const back = (
    <Link
      to="/projects/$projectId/users"
      params={{ projectId }}
      search={usersSearch}
      className="inline-flex items-center gap-1 text-sm text-link hover:underline"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      All users
    </Link>
  );

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        {back}
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserXIcon />
            </EmptyMedia>
            <EmptyTitle>No events from this user</EmptyTitle>
            <EmptyDescription>
              No event in {environment} has the user ID <span className="font-mono">{userId}</span>,
              or the project does not exist.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <ButtonLink
              variant="outline"
              to="/projects/$projectId/users"
              params={{ projectId }}
              search={usersSearch}
            >
              See all users
            </ButtonLink>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  // Newest first, under a heading for each local day.
  const days: { key: string; items: Activity[] }[] = [];
  for (const item of activity) {
    const key = dayKey(item.occurredAt, timeZone);
    const last = days.at(-1);
    if (last?.key === key) last.items.push(item);
    else days.push({ key, items: [item] });
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      {back}
      <div className="flex flex-col gap-3">
        <h2 className="font-mono text-xl font-semibold break-all text-ink">{userId}</h2>
        {first !== undefined && (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div>
              <dt className="text-ink-subtle">First seen</dt>
              <dd>{formatMoment(first.user.firstSeenAt, timeZone)}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Last seen</dt>
              <dd>{formatMoment(first.user.lastSeenAt, timeZone)}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Events</dt>
              <dd className="tabular-nums">{first.user.events.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Environment</dt>
              <dd>{environment}</dd>
            </div>
          </dl>
        )}
        {timeZone !== undefined && (
          <p className="text-sm text-ink-subtle">
            Times in {timeZone}. Only events your site sent with this user ID: browsing before
            signing in is not counted, as on a shared device it may be someone else&apos;s.
          </p>
        )}
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The activity could not load</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map((day) => (
            <section key={day.key} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-ink-subtle">
                {formatLongDay(day.items[0]?.occurredAt ?? "", timeZone)}
              </h3>
              <Card className="py-0">
                <CardContent className="px-0">
                  <ol
                    aria-label={`Activity on ${formatLongDay(day.items[0]?.occurredAt ?? "", timeZone)}`}
                  >
                    {day.items.map((item) => (
                      <li
                        key={item.eventId}
                        className="flex gap-4 border-b px-4 py-3 last:border-b-0"
                      >
                        <time
                          dateTime={item.occurredAt}
                          className="w-12 shrink-0 text-sm text-ink-subtle tabular-nums"
                        >
                          {formatTime(item.occurredAt, timeZone)}
                        </time>
                        <div className="flex min-w-0 flex-col gap-1">
                          <p className="text-sm break-all text-ink">
                            <ActivityTitle activity={item} />
                          </p>
                          <Properties properties={item.properties} />
                          {activityDetails(item) !== "" && (
                            <p className="text-xs text-ink-subtle">{activityDetails(item)}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </section>
          ))}
          {query.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage && (
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
