import { useQuery } from "@tanstack/react-query";
import { BellIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { PHONE, useMediaQuery } from "@/hooks/use-media-query";
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

/** The bell's face: the icon, and the unread count over its corner. */
function BellFace({ unread }: { unread: number }) {
  return (
    <>
      <BellIcon aria-hidden="true" />
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[0.625rem] leading-none font-semibold text-white tabular-nums"
        >
          {unreadBadge(unread)}
        </span>
      )}
    </>
  );
}

const BELL_CLASS =
  "relative text-ink-subtle max-[40rem]:size-7 max-[40rem]:after:absolute max-[40rem]:after:-inset-2";

/**
 * The header's bell (docs/dashboard.md, "Notifications"): the unread count,
 * polled every minute while the tab is shown and on focus, and a panel of
 * the newest items, a popover beside the bell, or a sheet on a phone.
 */
export function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const phone = useMediaQuery(PHONE);
  const count = useQuery(unreadCountQuery());
  const unread = count.data ?? 0;
  const label = bellLabel(unread);
  const close = () => setOpen(false);

  if (phone) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          className={BELL_CLASS}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <BellFace unread={unread} />
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="right" className="w-full gap-0 data-[side=right]:w-full">
            <Panel unread={unread} close={close} kind="sheet" />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" className={BELL_CLASS} aria-label={label} />}
      >
        <BellFace unread={unread} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(var(--available-height),32rem)] w-96 max-w-[calc(100vw-1rem)] gap-0 p-0"
      >
        <Panel unread={unread} close={close} kind="popover" />
      </PopoverContent>
    </Popover>
  );
}
