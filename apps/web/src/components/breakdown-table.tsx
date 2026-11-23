import { cn } from "cn";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { ScrollHint } from "./scroll-hint";

export interface BreakdownRow {
  key: string;
  /** Names the row: a path, a country, a source. */
  label: React.ReactNode;
  /**
   * The whole text, for the tooltip while the label is cut off (a long
   * path); needed when the label is not plain text (a filter link).
   */
  title?: string;
  /** The label leaves part of `title` out on purpose: the tooltip shows even when it fits. */
  shortened?: boolean;
  /**
   * After the label, in the name cell, never cut short with it: a small
   * link for the row (a page's heatmap) or a mark in words (rage clicks).
   */
  action?: React.ReactNode;
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
 * Below 40rem, scroll with a pinned name column or stack labeled figures.
 * Pinned columns use --block-surface, set by the page or containing card.
 */
export function BreakdownTable({
  title,
  headingLevel = 3,
  description,
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
  headingLevel?: 2 | 3 | 4;
  /** A line under the title, such as how many events a property is on. */
  description?: React.ReactNode;
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
  // More than two figures: the name takes what the fixed figure columns leave,
  // so a half-width table still fits (four figures at 5rem each).
  const wide = figureHeadings.length > 2;
  const headingId = React.useId();
  return (
    <section
      data-slot="breakdown-table"
      aria-labelledby={headingId}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <TruncatedText
          text={title}
          className="text-sm font-medium text-ink"
          render={<Heading id={headingId}>{title}</Heading>}
        />
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
      {description !== undefined && <p className="-mt-1 text-xs text-ink-subtle">{description}</p>}
      {rows.length === 0 ? (
        <div className="border-t py-6 text-center text-sm text-ink-subtle">{empty}</div>
      ) : (
        <ScrollHint disabled={stack}>
          <Table
            className={cn(
              "table-fixed",
              stack ? "max-sm:block" : wide ? "max-sm:min-w-[32rem]" : "max-sm:min-w-[28rem]",
            )}
          >
            <caption className="sr-only">{caption}</caption>
            <TableHeader className={cn(stack && "max-sm:sr-only")}>
              <TableRow className="hover:bg-transparent">
                <TableHead
                  scope="col"
                  className={cn(
                    "h-8 pl-0 text-xs font-normal text-ink-subtle max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:bg-[var(--block-surface,var(--background))]",
                    wide ? "w-auto" : "w-[45%]",
                  )}
                >
                  {nameHeading}
                </TableHead>
                <TableHead scope="col" className={cn("h-8", wide ? "w-12" : "w-[20%]")}>
                  <span className="sr-only">Share</span>
                </TableHead>
                {figureHeadings.map((heading) => (
                  <TableHead
                    key={heading}
                    scope="col"
                    className={cn(
                      "h-8 pr-0 text-right text-xs font-normal text-ink-subtle last:pr-0",
                      wide ? "w-20" : "w-24",
                    )}
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
                      {row.action === undefined ? (
                        <RowName row={row} />
                      ) : (
                        <div className="flex min-w-0 items-center gap-1.5">
                          <RowName row={row} />
                          <div className="flex shrink-0 items-center">{row.action}</div>
                        </div>
                      )}
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
                          <span data-slot="breakdown-label" className="text-ink-subtle sm:hidden">
                            {figureHeadings[index]}
                          </span>
                        )}
                        {figure}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollHint>
      )}
      {showAll !== undefined && rows.length > 0 && <div className="flex">{showAll}</div>}
    </section>
  );
}

/**
 * A row's name on one line, its whole text in a tooltip while it is cut
 * off: `title`, or the label itself when it is plain text.
 */
export function RowName({
  row,
}: {
  row: { label: React.ReactNode; title?: string; shortened?: boolean };
}) {
  const text = row.title ?? (typeof row.label === "string" ? row.label : undefined);
  if (text === undefined) return <div className="min-w-0 truncate text-ink">{row.label}</div>;
  return (
    <TruncatedText text={text} shortened={row.shortened} className="text-ink" render={<div />}>
      {row.label}
    </TruncatedText>
  );
}
