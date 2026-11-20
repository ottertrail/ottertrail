import { cn } from "cn";
import type * as React from "react";

import { formatDayRange } from "@/features/analytics/format";

/**
 * A report's controls, pinned to the top of the panel once the page title scrolls away
 * (from 40rem; on a phone it scrolls away, so it never covers the figures):
 * the period, the environment, the filters, and at the end the days shown
 * and their timezone. It wraps onto more lines on narrow screens.
 */
export function FilterBar({
  label = "Report filters",
  period,
  environment,
  filters,
  range,
  actions,
  className,
}: {
  /** Names the group for screen readers. */
  label?: string;
  /** The period control, such as a Select of "Last 7 days". */
  period?: React.ReactNode;
  /** The environment control or text, shown only when there is a choice. */
  environment?: React.ReactNode;
  /** The active filters, or other controls (a status toggle group). */
  filters?: React.ReactNode;
  /** The days shown: a `FilterBarRange`. */
  range?: React.ReactNode;
  /** A page's own action at the far end, such as "Edit overview". */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <search
      aria-label={label}
      data-slot="filter-bar"
      className={cn(
        "z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-[var(--block-surface,var(--background))] px-gutter py-2 sm:sticky sm:top-0",
        className,
      )}
    >
      {period}
      {environment}
      {filters !== undefined && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{filters}</div>
      )}
      {(range !== undefined || actions !== undefined) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto">
          {range}
          {actions}
        </div>
      )}
    </search>
  );
}

/**
 * The days a report covers and the timezone they are in, as two items: "10
 * to 16 Nov 2026" and "Asia/Singapore", never joined by a dot or a dash.
 */
export function FilterBarRange({
  firstDay,
  lastDay,
  timeZone,
  className,
}: {
  firstDay: string;
  lastDay: string;
  timeZone: string;
  className?: string;
}) {
  return (
    <p
      data-slot="filter-bar-range"
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 text-sm text-ink-subtle tabular-nums",
        className,
      )}
    >
      <span className="whitespace-nowrap text-ink-muted">{formatDayRange(firstDay, lastDay)}</span>
      <span className="whitespace-nowrap">{timeZone}</span>
    </p>
  );
}
