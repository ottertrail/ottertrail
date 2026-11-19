import { cn } from "cn";
import * as React from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export interface BreakdownRow {
  key: string;
  /** Names the row: a path, a country, a source. */
  label: React.ReactNode;
  /** Full text when the label is cut short, such as a long path. */
  title?: string;
  /** Sets the bar's length, against the largest in the table. */
  bar: number;
  /** The figures, as shown, one for each of `figureHeadings`. */
  figures: React.ReactNode[];
}

export interface BreakdownViews {
  /** The list shown; the page keeps it (in the URL where it matters). */
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: string }[];
}

/**
 * A compact ranked table on `ui/table`: the name, an inline bar in
 * proportion to the largest row, and the figures in tabular numerals. A
 * toggle group in its header switches between lists of one kind (top pages, entry pages);
 * a "show all" control goes in `showAll`.
 *
 * On phones (under 40rem) the table scrolls sideways inside itself
 * (`layout="scroll"`, the name column pinned) or each row stacks into a
 * block, the name over its bar and the figures labelled
 * (`layout="stack"`). The pinned column is painted `--block-surface`,
 * the page's background unless a card sets it.
 */
export function BreakdownTable({
  title,
  headingLevel = 3,
  caption,
  nameHeading,
  figureHeadings,
  rows,
  views,
  showAll,
  empty,
  layout = "scroll",
  className,
}: {
  title: string;
  /** The title's heading level in the page's outline. */
  headingLevel?: 2 | 3 | 4;
  /** Says what the rows are and how they are ordered, for screen readers. */
  caption: string;
  nameHeading: string;
  /** The first figure is the one the bars show. */
  figureHeadings: string[];
  rows: BreakdownRow[];
  /** Lists of one kind the table switches between (Top pages, Entry, Exit). */
  views?: BreakdownViews;
  showAll?: React.ReactNode;
  /** Shown instead of the table when there are no rows: why, and what to do. */
  empty: React.ReactNode;
  layout?: "scroll" | "stack";
  className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  const max = Math.max(0, ...rows.map((row) => row.bar));
  const stack = layout === "stack";
  const headingId = React.useId();
  return (
    <section
      data-slot="breakdown-table"
      aria-labelledby={headingId}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Heading id={headingId} className="text-sm font-medium text-ink">
          {title}
        </Heading>
        {views !== undefined && (
          // One table whose rows change: toggle buttons (aria-pressed), not tabs with panels.
          <ToggleGroup
            value={[views.value]}
            onValueChange={(value) => {
              // Pressing the shown list again keeps it; one is always shown.
              const [next] = value;
              if (typeof next === "string") views.onValueChange(next);
            }}
            aria-label={`Which ${title.toLowerCase()} to list`}
            variant="outline"
            size="sm"
            spacing={0}
          >
            {views.items.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="border-t py-6 text-center text-sm text-ink-subtle">{empty}</div>
      ) : (
        <Table className={cn("table-fixed", stack ? "max-sm:block" : "max-sm:min-w-[28rem]")}>
          <caption className="sr-only">{caption}</caption>
          <TableHeader className={cn(stack && "max-sm:sr-only")}>
            <TableRow className="hover:bg-transparent">
              <TableHead
                scope="col"
                className="h-8 w-[45%] pl-0 text-xs font-normal text-ink-subtle max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:bg-[var(--block-surface,var(--background))]"
              >
                {nameHeading}
              </TableHead>
              <TableHead scope="col" className="h-8 w-[20%]">
                <span className="sr-only">Share</span>
              </TableHead>
              {figureHeadings.map((heading) => (
                <TableHead
                  key={heading}
                  scope="col"
                  className="h-8 w-24 pr-0 text-right text-xs font-normal text-ink-subtle last:pr-0"
                >
                  {heading}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className={cn(stack && "max-sm:block")}>
            {rows.map((row) => {
              const share = max === 0 ? 0 : (row.bar / max) * 100;
              return (
                <TableRow
                  key={row.key}
                  className={cn(
                    "hover:bg-transparent",
                    stack && "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:py-2",
                  )}
                >
                  <TableCell
                    className={cn(
                      "py-1.5 pl-0 max-sm:bg-[var(--block-surface,var(--background))]",
                      stack ? "max-sm:col-span-2 max-sm:p-0" : "max-sm:sticky max-sm:left-0",
                    )}
                  >
                    <div className="truncate text-ink" title={row.title}>
                      {row.label}
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn("py-1.5", stack && "max-sm:col-span-2 max-sm:px-0 max-sm:py-1")}
                  >
                    <div
                      aria-hidden="true"
                      data-slot="breakdown-bar"
                      className="h-1.5 rounded-r bg-chart-1"
                      style={{ width: `${share}%` }}
                    />
                  </TableCell>
                  {row.figures.map((figure, index) => (
                    <TableCell
                      // Figures have a fixed order, one per heading.
                      // oxlint-disable-next-line react/no-array-index-key
                      key={index}
                      className={cn(
                        "py-1.5 pr-0 text-right tabular-nums",
                        index === 0 ? "text-ink" : "text-ink-subtle",
                        stack &&
                          "max-sm:col-span-2 max-sm:flex max-sm:justify-between max-sm:px-0 max-sm:py-0.5",
                      )}
                    >
                      {stack && (
                        <span className="text-ink-subtle sm:hidden">{figureHeadings[index]}</span>
                      )}
                      {figure}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {showAll !== undefined && rows.length > 0 && <div className="flex">{showAll}</div>}
    </section>
  );
}
