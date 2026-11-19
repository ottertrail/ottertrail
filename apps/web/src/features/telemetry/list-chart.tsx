import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { ReportChart } from "@/components/report-chart";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MISSING } from "@/lib/missing";

import { type ListChartFrame, listBucketLabel } from "./list-chart-frame";

/**
 * What the Logs and Traces lists' charts share (docs/dashboard.md, "Traces
 * and logs"): their place above the list, inside the list's pane; their
 * loading, failed, and empty states, which never hold up the list; their
 * numbers as a table; and choosing a bar to narrow the period to its days.
 */

/** A table of the chart's buckets that hold anything: its numbers ("Show the numbers"). */
export function BucketTable({
  caption,
  frame,
  columns,
}: {
  caption: string;
  frame: ListChartFrame;
  columns: {
    key: string;
    label: string;
    values: (number | null)[];
    format: (value: number) => string;
  }[];
}) {
  const rows = Array.from({ length: frame.bucketStarts.length }, (_, index) => index).filter(
    (index) =>
      columns.some((column) => {
        const value = column.values[index];
        return value !== null && value !== undefined && value !== 0;
      }),
  );
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Time
          </th>
          {columns.map((column) => (
            <th key={column.key} scope="col" className="pb-2 pl-4 text-right font-normal">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((index) => (
          <tr key={index} className="border-t border-hairline">
            <th scope="row" className="py-1.5 text-left font-normal text-ink">
              {listBucketLabel(frame, index)}
            </th>
            {columns.map((column) => {
              const value = column.values[index];
              return (
                <td key={column.key} className="py-1.5 pl-4 text-right text-ink tabular-nums">
                  {value === null || value === undefined ? MISSING : column.format(value)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A list's chart in its pane, above the list: the chart's section
 * (`ReportChart`) with its own loading and failed states, so the list
 * shows whatever the chart does.
 */
export function ListChartSection({
  title,
  description,
  actions,
  table,
  state,
  error,
  onRetry,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  table?: React.ReactNode;
  state: "pending" | "error" | "success";
  error?: Error | null;
  onRetry: () => void;
  /** The chart, or why there is none. */
  children: React.ReactNode;
}) {
  return (
    <div className="border-b px-gutter pt-4 pb-3">
      <ReportChart
        title={title}
        description={state === "success" ? description : undefined}
        actions={state === "success" ? actions : undefined}
        table={state === "success" ? table : undefined}
        className="border-t-0 pt-0"
      >
        {state === "pending" ? (
          <div aria-busy="true" aria-label={`Loading the chart: ${title}`}>
            <Skeleton className="h-44 w-full" />
          </div>
        ) : state === "error" ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>The chart could not load</AlertTitle>
            <AlertDescription>
              {error?.message} The list below does not depend on it.
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          children
        )}
      </ReportChart>
    </div>
  );
}

/** In place of a chart with nothing to draw. */
export function NothingToChart({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-subtle">{children}</p>;
}
