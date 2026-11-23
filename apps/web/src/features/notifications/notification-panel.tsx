import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { OctagonAlertIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/access";
import { inboxQuery } from "@/lib/notifications-api";

import { useMarkAllRead } from "./inbox-hooks";
import { NotificationList } from "./notification-items";
import { PanelHead, type PanelKind } from "./panel-title";

const BELL_ITEMS = 10;

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export function BellPanel({
  unread,
  close,
  kind,
}: {
  unread: number;
  close: () => void;
  kind: PanelKind;
}) {
  const list = useInfiniteQuery({ ...inboxQuery("all", BELL_ITEMS), refetchOnMount: "always" });
  const timeZone = useQuery(meQuery()).data?.instance.timeZone;
  const markAll = useMarkAllRead();
  const items = list.data?.pages[0]?.notifications;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead kind={kind}>
        {unread > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        )}
      </PanelHead>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {items === undefined ? (
          list.isError ? (
            <div className="p-3">
              <Alert variant="destructive">
                <OctagonAlertIcon />
                <AlertTitle>Notifications could not load</AlertTitle>
                <AlertAction>
                  <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            </div>
          ) : (
            <PanelSkeleton />
          )
        ) : items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-ink-subtle">No notifications</p>
        ) : (
          <NotificationList items={items} timeZone={timeZone} onOpen={close} />
        )}
      </div>
      <div className="border-t p-1.5">
        <ButtonLink
          variant="ghost"
          size="sm"
          className="w-full"
          to="/notifications"
          onClick={close}
        >
          View all
        </ButtonLink>
      </div>
    </div>
  );
}
