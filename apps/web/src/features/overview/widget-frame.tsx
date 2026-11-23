import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface Arrange {
  index: number;
  count: number;
  hidden: boolean;
  onMove: (by: -1 | 1) => void;
  onToggle: () => void;
}

/** Hidden widgets do not fetch their data. */
export function WidgetFrame({
  id,
  title,
  link,
  arrange,
  children,
}: {
  id: string;
  title: string;
  link?: React.ReactNode;
  arrange?: Arrange;
  children: React.ReactNode;
}) {
  const headingId = `widget-${id}`;
  const hidden = arrange?.hidden === true;
  return (
    <section
      aria-labelledby={headingId}
      data-widget={id}
      data-hidden={hidden || undefined}
      className="flex min-w-0 flex-col gap-3 border-t pt-4"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        <h2
          id={headingId}
          className={cn("text-sm font-medium text-ink", hidden && "text-ink-subtle")}
        >
          {title}
        </h2>
        {hidden && <span className="text-xs text-ink-subtle">Hidden</span>}
        <div className="ml-auto flex items-center gap-2">
          {arrange === undefined ? (
            link
          ) : (
            <fieldset
              aria-label={`Arrange ${title}`}
              className="m-0 flex items-center gap-1 border-0 p-0"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${title} up`}
                data-move="up"
                disabled={arrange.index === 0}
                onClick={() => arrange.onMove(-1)}
              >
                <ArrowUpIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${title} down`}
                data-move="down"
                disabled={arrange.index === arrange.count - 1}
                onClick={() => arrange.onMove(1)}
              >
                <ArrowDownIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`${hidden ? "Show" : "Hide"} ${title}`}
                onClick={arrange.onToggle}
              >
                {hidden ? "Show" : "Hide"}
              </Button>
            </fieldset>
          )}
        </div>
      </div>
      {!hidden && children}
    </section>
  );
}

export function WidgetState<T>({
  title,
  query,
  children,
}: {
  title: string;
  query: UseQueryResult<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label={`Loading ${title}`} className="flex flex-col gap-2">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>{title} could not load</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return <div className={cn(query.isPlaceholderData && "opacity-60")}>{children(query.data)}</div>;
}

export function WidgetEmpty({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="items-start border border-dashed p-4 text-left">
      <EmptyHeader className="items-start">
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {children !== undefined && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action !== undefined && <EmptyContent className="items-start">{action}</EmptyContent>}
    </Empty>
  );
}

export function WidgetNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-ink-subtle">{children}</p>;
}
