import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
  ActivityIcon,
  ArchiveRestoreIcon,
  BellOffIcon,
  BugIcon,
  CircleArrowDownIcon,
  CircleCheckIcon,
  CircleIcon,
  HardDriveIcon,
  ShieldAlertIcon,
  SparklesIcon,
  UserRoundCheckIcon,
} from "lucide-react";
import type * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import type { InboxItem } from "@/lib/notifications-api";

import { formatMoment, timeAgo } from "../users/format";
import { useMarkNotification } from "./inbox-hooks";

const isRecovery = (kind: string) =>
  kind.endsWith("_resolved") ||
  kind === "check.up" ||
  kind === "certificate.renewed" ||
  kind === "storage.recovered";

function iconOf(kind: string): { icon: typeof BugIcon; tone: string } {
  if (isRecovery(kind)) return { icon: CircleCheckIcon, tone: "text-success" };
  if (kind === "error.assigned") return { icon: UserRoundCheckIcon, tone: "text-ink-muted" };
  if (kind === "check.down") return { icon: CircleArrowDownIcon, tone: "text-destructive" };
  if (kind.startsWith("certificate.")) return { icon: ShieldAlertIcon, tone: "text-warning" };
  if (kind.startsWith("error.")) return { icon: BugIcon, tone: "text-destructive" };
  if (kind.startsWith("route.") || kind.startsWith("metric.") || kind.startsWith("data.")) {
    return { icon: ActivityIcon, tone: "text-warning" };
  }
  if (kind.startsWith("ai.")) return { icon: SparklesIcon, tone: "text-warning" };
  if (kind === "alert.held_back") return { icon: BellOffIcon, tone: "text-ink-muted" };
  if (kind === "storage.low") return { icon: HardDriveIcon, tone: "text-warning" };
  return { icon: ArchiveRestoreIcon, tone: "text-ink-muted" };
}

const plainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function NotificationItem({
  item,
  timeZone,
  onOpen,
}: {
  item: InboxItem;
  timeZone: string | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const mark = useMarkNotification();
  const { icon: Icon, tone } = iconOf(item.kind);
  const open = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!item.read) mark.mutate({ id: item.id, read: true });
    if (!plainClick(event)) return;
    event.preventDefault();
    onOpen?.();
    void navigate({ href: item.link });
  };
  return (
    <li
      className={cn("relative flex items-start gap-3 px-3 py-2.5", !item.read && "bg-brand/5")}
      data-read={item.read}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TruncatedText
          text={item.title}
          className={cn(
            "line-clamp-2 rounded-sm text-sm break-words text-ink hover:underline",
            !item.read && "font-medium",
          )}
          render={<a href={item.link} aria-label={item.title} onClick={open} />}
        />
        <p className="text-xs text-ink-subtle">
          {item.project !== null && <span>{item.project.name}, </span>}
          <time dateTime={item.createdAt} title={formatMoment(item.createdAt, timeZone)}>
            {timeAgo(new Date(item.createdAt))}
          </time>
          {!item.read && <span className="sr-only">, unread</span>}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="-my-1 shrink-0 text-ink-subtle"
        aria-label={item.read ? `Mark as unread: ${item.title}` : `Mark as read: ${item.title}`}
        disabled={mark.isPending}
        onClick={() => mark.mutate({ id: item.id, read: !item.read })}
      >
        {item.read ? (
          <CircleIcon aria-hidden="true" />
        ) : (
          <CircleIcon aria-hidden="true" className="fill-brand text-brand" />
        )}
      </Button>
    </li>
  );
}

export function NotificationList({
  items,
  timeZone,
  onOpen,
  className,
}: {
  items: InboxItem[];
  timeZone: string | undefined;
  onOpen?: () => void;
  className?: string;
}) {
  return (
    <ul className={cn("divide-y", className)}>
      {items.map((item) => (
        <NotificationItem key={item.id} item={item} timeZone={timeZone} onOpen={onOpen} />
      ))}
    </ul>
  );
}
