import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BellIcon, LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";

import { PageActions } from "@/components/page-header";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { meQuery } from "@/lib/access";
import { type InboxFilter, inboxQuery, unreadCountQuery } from "@/lib/notifications-api";

import { useMarkAllRead } from "./inbox-hooks";
import { NotificationList } from "./notification-items";

const PAGE_SIZE = 30;

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];

/**
 * The signed-in user's notifications (docs/dashboard.md, "Notifications"):
 * every item of the last 90 days they may see, or the unread ones, newest
 * first, 30 at a time.
 */
export function NotificationsPage({ filter }: { filter: InboxFilter }) {
  const navigate = useNavigate();
  const list = useInfiniteQuery(inboxQuery(filter, PAGE_SIZE));
  const unread = useQuery(unreadCountQuery()).data ?? 0;
  const timeZone = useQuery(meQuery()).data?.instance.timeZone;
  const markAll = useMarkAllRead();
  const items = list.data?.pages.flatMap((page) => page.notifications);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4 px-gutter pt-1 pb-5">
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          value={[filter]}
          onValueChange={(value) => {
            const [next] = value;
            if (next === "all" || next === "unread") {
              void navigate({
                to: "/notifications",
                search: next === "all" ? {} : { filter: next },
              });
            }
          }}
          aria-label="Which notifications to list"
          variant="outline"
          size="sm"
          spacing={0}
        >
          {FILTERS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <PageActions>
        <Button
          variant="outline"
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all read
        </Button>
      </PageActions>
      {markAll.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>Notifications could not be marked read</AlertTitle>
          <AlertDescription>{markAll.error.message}</AlertDescription>
        </Alert>
      )}
      {items === undefined ? (
        list.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>Notifications could not load</AlertTitle>
            <AlertDescription>{list.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading notifications">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )
      ) : items.length === 0 ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellIcon />
            </EmptyMedia>
            <EmptyTitle>
              {filter === "unread" ? "No unread notifications" : "No notifications"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {list.isError && (
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>Notifications could not refresh</AlertTitle>
              <AlertDescription>{list.error.message}</AlertDescription>
            </Alert>
          )}
          <NotificationList
            items={items}
            timeZone={timeZone}
            className="overflow-hidden rounded-lg ring-1 ring-hairline"
          />
          {list.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage && (
                <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
              )}
              Show more
            </Button>
          )}
        </>
      )}
    </div>
  );
}
