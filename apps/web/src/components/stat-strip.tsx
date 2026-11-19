import { cn } from "cn";
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react";
import type * as React from "react";

import type { Change } from "@/features/analytics/format";
import { type ChangeCounts, shownChange } from "@/lib/change";

export interface Stat {
  /** Names the figure: "Visitors". */
  label: string;
  /** The figure as shown, already formatted: "1,820", "4m 23s". */
  value: React.ReactNode;
  /** The change from the period before; null or left out when there is none to show. */
  change?: Change | null;
  /** The figure the change compares with, as shown, for the sentence a screen reader hears. */
  before?: string;
  /**
   * What the change rests on: the figure's own count in this period and the
   * one before (for a share, the counts it is taken of). With a `minCount`,
   * the change shows only when the larger reaches it, and "New" when the
   * period before had none (lib/change.ts).
   */
  counts?: ChangeCounts;
  /**
   * More about the figure, under it: a rating, its spread, what it was
   * measured on. Kept short; the strip stays a row of figures.
   */
  detail?: React.ReactNode;
}

const CHANGE_ICONS = { up: ArrowUpIcon, down: ArrowDownIcon, same: MinusIcon } as const;

/** A change against the period before: an arrow and a size, read out as a sentence; or "New". */
function StatChange({ change, before }: { change: Change | "new"; before: string | undefined }) {
  if (change === "new") {
    return (
      <dd className="text-xs text-ink-subtle">
        <span aria-hidden="true">New</span>
        <span className="sr-only">New: none in the period before</span>
      </dd>
    );
  }
  const Icon = CHANGE_ICONS[change.direction];
  const from = before === undefined ? "the period before" : before;
  const sentence =
    change.direction === "same"
      ? `No change from ${from}`
      : `${change.direction === "up" ? "Up" : "Down"} ${change.spoken} from ${from}`;
  return (
    <dd
      className="flex items-center gap-1 text-xs text-ink-subtle tabular-nums"
      title={before === undefined ? undefined : `Before: ${before}`}
    >
      <Icon aria-hidden="true" className="size-3" />
      <span aria-hidden="true">{change.text}</span>
      <span className="sr-only">{sentence}</span>
    </dd>
  );
}

/**
 * A report's figures in one row, separated by hairlines rather than set in
 * tiles: each a label, a figure in tabular numerals, and optionally its
 * change from the period before. Wraps to two or four columns on narrower
 * screens.
 */
export function StatStrip({
  stats,
  minCount = 0,
  label,
  className,
}: {
  stats: Stat[];
  /** The fewest a change rests on (see Stat's `counts`). 0 shows every change. */
  minCount?: number;
  /** Names the list for screen readers, such as "Summary". */
  label?: string;
  className?: string;
}) {
  return (
    <dl
      aria-label={label}
      data-slot="stat-strip"
      className={cn(
        "grid grid-cols-2 gap-y-4 sm:grid-cols-4 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none",
        className,
      )}
    >
      {stats.map((stat) => {
        // With a minimum, a change whose counts are unknown is left out too.
        const change = shownChange(stat.change ?? null, stat.counts, minCount);
        return (
          <div
            key={stat.label}
            data-slot="stat"
            className="flex min-w-0 flex-col gap-1 border-l px-4 first:border-l-0 first:pl-0 max-sm:odd:border-l-0 max-sm:odd:pl-0 sm:max-lg:[&:nth-child(4n+1)]:border-l-0 sm:max-lg:[&:nth-child(4n+1)]:pl-0"
          >
            <dt className="text-xs text-pretty text-ink-subtle">{stat.label}</dt>
            <dd className="text-2xl font-semibold tracking-tight whitespace-nowrap text-ink tabular-nums">
              {stat.value}
            </dd>
            {change !== null && <StatChange change={change} before={stat.before} />}
            {stat.detail !== undefined && (
              <dd
                data-slot="stat-detail"
                className="flex flex-col gap-2 pt-1 text-xs text-ink-subtle"
              >
                {stat.detail}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}
