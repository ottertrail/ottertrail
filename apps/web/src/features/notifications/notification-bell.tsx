import { useQuery } from "@tanstack/react-query";
import { BellIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { loadChunk, PageLoadError } from "@/lib/lazy-page";
import { bellLabel, unreadBadge, unreadCountQuery } from "@/lib/notifications-api";
import { reloadPage } from "@/lib/reload";

import { PanelHead, type PanelKind } from "./panel-title";

/**
 * The panel's code, loaded the first time the bell opens, so a first visit
 * does not download it. When its file cannot be downloaded (a tab left
 * open across a deploy), the panel says so, with Reload.
 */
const BellPanel = React.lazy(async () => {
  try {
    const loaded = await loadChunk(() => import("./notification-panel"));
    return { default: loaded.BellPanel };
  } catch (error) {
    if (error instanceof PageLoadError) return { default: PanelUnavailable };
    throw error;
  }
});

/** In place of the panel when its code could not be downloaded. */
function PanelUnavailable({ kind }: { kind: PanelKind }) {
  return (
    <div className="flex flex-col">
      <PanelHead kind={kind} />
      <div className="flex flex-col items-start gap-3 p-3 text-sm text-ink-subtle">
        <p>Notifications could not load. Reload to try again.</p>
        <Button size="sm" onClick={reloadPage}>
          Reload
        </Button>
      </div>
    </div>
  );
}

/** The panel's shape while its code downloads. */
function PanelLoading({ kind }: { kind: PanelKind }) {
  return (
    <div className="flex flex-col">
      <PanelHead kind={kind} />
      <div className="flex flex-col gap-2 p-3" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

/** The panel, once its code is here. */
function Panel({ unread, close, kind }: { unread: number; close: () => void; kind: PanelKind }) {
  return (
    <React.Suspense fallback={<PanelLoading kind={kind} />}>
      <BellPanel unread={unread} close={close} kind={kind} />
    </React.Suspense>
  );
}

/** The unread count at the item's end: a small orchid pill, "9+" past nine. */
function UnreadPill({ unread }: { unread: number }) {
  return (
    <span
      aria-hidden="true"
      data-slot="unread-count"
      className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[0.6875rem] leading-none font-semibold text-white tabular-nums group-data-[collapsible=icon]:hidden"
    >
      {unreadBadge(unread)}
    </span>
  );
}

/** Collapsed to icons: a dot on the bell's corner says something is unread. */
function UnreadDot() {
  return (
    <span
      aria-hidden="true"
      data-slot="unread-dot"
      className="absolute top-1.5 right-1.5 hidden size-2 rounded-full bg-brand ring-2 ring-sidebar group-data-[collapsible=icon]:block"
    />
  );
}

/** The item's face: the bell, the label, and the unread count. */
function ItemFace({ unread }: { unread: number }) {
  return (
    <>
      <BellIcon aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">Notifications</span>
      {unread > 0 && <UnreadPill unread={unread} />}
      {unread > 0 && <UnreadDot />}
    </>
  );
}

/**
 * The sidebar foot's Notifications item, above the user (docs/dashboard.md,
 * "Notifications"): the unread count, polled every minute while the tab is
 * shown and on focus, and a panel of the newest items, a popover to the
 * right of the sidebar, or a sheet over the menu on a phone.
 */
export function SidebarNotifications() {
  const [open, setOpen] = React.useState(false);
  const { isMobile } = useSidebar();
  const count = useQuery(unreadCountQuery());
  const unread = count.data ?? 0;
  const label = bellLabel(unread);
  const close = () => setOpen(false);

  if (isMobile) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <ItemFace unread={unread} />
          </SidebarMenuButton>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="right" className="w-full gap-0 data-[side=right]:w-full">
              <Panel unread={unread} close={close} kind="sheet" />
            </SheetContent>
          </Sheet>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <SidebarMenuButton
                aria-label={label}
                tooltip="Notifications"
                className="relative data-popup-open:bg-sidebar-accent"
              />
            }
          >
            <ItemFace unread={unread} />
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="end"
            sideOffset={20}
            className="max-h-[min(var(--available-height),32rem)] w-96 max-w-[calc(100vw-1rem)] gap-0 p-0"
          >
            <Panel unread={unread} close={close} kind="popover" />
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
