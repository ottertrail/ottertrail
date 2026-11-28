import { useMutation } from "@tanstack/react-query";
import { DownloadIcon, LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  appendFilters,
  chartViewParams,
  DEFAULT_COMPARISON,
  type ListReport,
  rangeParams,
} from "@/lib/analytics-api";
import { environmentParams, goalParams, type ReportSource } from "@/lib/analytics-queries";
import { downloadCsv } from "@/lib/csv-download";

import { formatWhole } from "./format";
import type { PageSearch } from "./list-rows";

/*
 * The Web analytics page's CSV exports (docs/web-analytics.md, "CSV
 * export"): a list from its Show all, and the summary or the chart from the
 * page's title row. The signed-in dashboard's only: a shared link has none.
 */

/** The export's address, with the page's range, environment, filters, and goal. */
function exportPath(
  source: ReportSource,
  part: "list" | "summary" | "chart",
  search: PageSearch,
  more: Record<string, string>,
): string {
  const query = new URLSearchParams({
    ...rangeParams(search.range),
    ...environmentParams(source, search.environment),
    ...goalParams(search.goal),
    ...more,
  });
  appendFilters(query, search.filters);
  return `${source.path}/analytics/export/${part}?${query.toString()}`;
}

function useDownload() {
  return useMutation({ mutationFn: downloadCsv });
}

function DownloadFailed({ error }: { error: Error }) {
  return (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>The file could not download</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

function DownloadButton({
  pending,
  onClick,
  label,
  children,
}: {
  pending: boolean;
  onClick: () => void;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <Button variant="outline" onClick={onClick} disabled={pending} aria-label={label}>
      {pending ? (
        <LoaderCircleIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" />
      ) : (
        <DownloadIcon aria-hidden="true" data-icon="inline-start" />
      )}
      {children}
    </Button>
  );
}

/**
 * Show all's Download CSV: the whole list, with the search typed, up to
 * the API's cap, which the dialog names when the file reached it.
 */
export function DownloadListButton({
  source,
  search,
  report,
  text,
  title,
}: {
  source: ReportSource;
  search: PageSearch;
  report: ListReport;
  /** The search typed in the dialog. */
  text: string;
  title: string;
}) {
  const download = useDownload();
  const cutAt = download.data?.cutAt ?? null;
  return (
    <>
      <DownloadButton
        pending={download.isPending}
        label={`Download ${title.toLowerCase()} as CSV`}
        onClick={() =>
          download.mutate(
            exportPath(source, "list", search, {
              report,
              ...(text === "" ? {} : { search: text }),
            }),
          )
        }
      >
        <span className="max-sm:sr-only">Download CSV</span>
      </DownloadButton>
      {download.isError && (
        <div className="basis-full">
          <DownloadFailed error={download.error} />
        </div>
      )}
      {/* Always there, so a screen reader hears the note when it appears. */}
      <output className="block basis-full text-sm text-ink-subtle empty:hidden">
        {cutAt !== null &&
          `The list has more than ${formatWhole(cutAt)} rows, so the file holds the first ${formatWhole(cutAt)}.`}
      </output>
    </>
  );
}

/** The title row's Export: the summary or the chart, each as its own file. */
export function ExportMenu({ source, search }: { source: ReportSource; search: PageSearch }) {
  const [open, setOpen] = React.useState(false);
  const summary = useDownload();
  const chart = useDownload();
  const allTime = "period" in search.range && search.range.period === "all";
  const view = chartViewParams({
    interval: search.interval,
    // As the page asks: All time has nothing before it to compare with.
    comparison: allTime ? DEFAULT_COMPARISON : (search.comparison ?? DEFAULT_COMPARISON),
  });
  const failed = summary.error ?? chart.error;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          summary.reset();
          chart.reset();
        }
      }}
    >
      <PopoverTrigger render={<Button variant="outline" />}>
        <DownloadIcon aria-hidden="true" data-icon="inline-start" />
        {/* A phone has room for the icon only; the word stays the name. */}
        <span className="max-sm:sr-only">Export</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]" aria-label="Export">
        <p className="text-sm text-ink-subtle">
          As CSV, with the period, filters, and goal shown. Each list downloads from its Show all.
        </p>
        <div className="flex flex-col gap-2">
          <DownloadButton
            pending={summary.isPending}
            onClick={() => {
              chart.reset();
              summary.mutate(exportPath(source, "summary", search, view));
            }}
          >
            Summary
          </DownloadButton>
          <DownloadButton
            pending={chart.isPending}
            onClick={() => {
              summary.reset();
              chart.mutate(exportPath(source, "chart", search, view));
            }}
          >
            Chart
          </DownloadButton>
        </div>
        {failed !== null && <DownloadFailed error={failed} />}
      </PopoverContent>
    </Popover>
  );
}
