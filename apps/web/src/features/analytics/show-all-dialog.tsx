import { useInfiniteQuery } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettled } from "@/hooks/use-settled";
import type { ListReport } from "@/lib/analytics-api";
import { listQuery } from "@/lib/analytics-queries";

import { FilterLink, GoalLink } from "./filter-link";
import { type PageSearch, rankedRows } from "./list-rows";
import { RankedList } from "./ranked-list";
import { useAnalyticsScope } from "./scope";

export function ShowAllDialog({
  open,
  onOpenChange,
  title,
  report,
  nameHeading,
  secondaryHeading,
  rateHeading,
  search,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  report: ListReport;
  nameHeading: string;
  secondaryHeading: string;
  /** A third figure without a goal: the exit rate. */
  rateHeading?: string | undefined;
  search: PageSearch;
}) {
  const { source } = useAnalyticsScope();
  const [text, setText] = React.useState("");
  const query = useSettled(text.trim(), 250);
  const list = useInfiniteQuery({
    ...listQuery(
      source,
      search.range,
      search.filters,
      search.environment,
      report,
      query,
      search.goal,
    ),
    enabled: open,
  });
  const close = () => onOpenChange(false);
  const rows = rankedRows(
    report,
    (list.data?.pages ?? []).flatMap((page) => page.rows),
    (name, value) => <FilterLink search={search} name={name} value={value} onClick={close} />,
    (name) => <GoalLink search={search} goal={{ event: name }} name={name} onClick={close} />,
  );
  // Custom events keep their own numbers under a goal.
  const withGoal = search.goal !== undefined && report !== "customEvents";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search"
          aria-label={`Search ${title.toLowerCase()}`}
          autoComplete="off"
        />
        <div
          className="min-h-0 flex-1 overflow-y-auto transition-opacity data-[stale=true]:opacity-60"
          data-stale={list.isPlaceholderData}
          aria-busy={list.isFetching}
        >
          {list.isPending ? (
            <div className="flex flex-col gap-2" aria-label="Loading">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : list.isError ? (
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>The list could not load</AlertTitle>
              <AlertDescription>{list.error.message}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : (
            <RankedList
              rows={rows}
              caption={`${title}, ${withGoal ? "most converted" : "most visitors"} first`}
              nameHeading={nameHeading}
              primaryHeading="Visitors"
              secondaryHeading={secondaryHeading}
              rateHeading={rateHeading}
              goal={withGoal}
              empty={query === "" ? "Nothing in this period." : `Nothing matches “${query}”.`}
            />
          )}
        </div>
        {list.hasNextPage && (
          <Button
            variant="outline"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage && (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            )}
            Load more
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
