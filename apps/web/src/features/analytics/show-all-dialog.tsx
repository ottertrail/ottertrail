import { useInfiniteQuery } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { activeFilters, DEFAULT_PERIOD, type ListReport, listQuery } from "@/lib/analytics-api";

import { FilterLink } from "./filter-link";
import { type PageSearch, rankedRows } from "./list-rows";
import { RankedList } from "./ranked-list";

/** Waits until `value` has stopped changing for `ms`, so typing does not send a request per key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * A list in full, for "Show all": the page's period and filters, a search
 * by name, and more rows on request. A row's link filters the page by it
 * and closes the dialog.
 */
export function ShowAllDialog({
  open,
  onOpenChange,
  title,
  report,
  nameHeading,
  secondaryHeading,
  projectId,
  search,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  report: ListReport;
  nameHeading: string;
  secondaryHeading: string;
  projectId: string;
  search: PageSearch;
}) {
  const [text, setText] = React.useState("");
  const query = useSettled(text.trim(), 250);
  const list = useInfiniteQuery({
    ...listQuery(projectId, search.period ?? DEFAULT_PERIOD, search.filters, report, query),
    enabled: open,
  });
  const close = () => onOpenChange(false);
  const rows = rankedRows(
    report,
    (list.data?.pages ?? []).flatMap((page) => page.rows),
    (name, value) => (
      <FilterLink projectId={projectId} search={search} name={name} value={value} onClick={close} />
    ),
  );
  const filtered = activeFilters(search.filters).length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Every row for this period{filtered ? " and these filters" : ""}, most visitors first.
          </DialogDescription>
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
              caption={`${title}, most visitors first`}
              nameHeading={nameHeading}
              primaryHeading="Visitors"
              secondaryHeading={secondaryHeading}
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
