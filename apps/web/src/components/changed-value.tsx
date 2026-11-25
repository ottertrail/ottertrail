import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react";
import type * as React from "react";

import type { Change } from "@/features/analytics/format";
import { type ChangeCounts, shownChange } from "@/lib/change";

const ICONS = { up: ArrowUpIcon, down: ArrowDownIcon, same: MinusIcon } as const;

function ChangeIcon({ direction }: { direction: Change["direction"] }) {
  const Icon = ICONS[direction];
  return <Icon aria-hidden="true" className="size-3" />;
}

/**
 * A figure in a table cell, with its change from the period before under it,
 * as StatStrip shows one: an arrow and a size, read out as a sentence; or
 * "New". Uses lib/change.ts thresholds.
 */
export function ChangedValue({
  value,
  change,
  counts,
  min,
  before,
}: {
  value: React.ReactNode;
  change: Change | null;
  counts: ChangeCounts;
  min: number;
  /** The figure the change compares with, as shown, for the sentence a screen reader hears. */
  before?: string;
}) {
  const shown = shownChange(change, counts, min);
  const from = before ?? "the period before";
  return (
    <span className="inline-flex flex-col items-end">
      <span>{value}</span>
      {shown === "new" && (
        <span className="text-xs text-ink-subtle">
          <span aria-hidden="true">New</span>
          <span className="sr-only">New: none in the period before</span>
        </span>
      )}
      {shown !== null && shown !== "new" && (
        <span
          className="inline-flex items-center gap-0.5 text-xs text-ink-subtle"
          title={before === undefined ? undefined : `Before: ${before}`}
        >
          <ChangeIcon direction={shown.direction} />
          <span aria-hidden="true">{shown.text}</span>
          <span className="sr-only">
            {shown.direction === "same"
              ? `No change from ${from}`
              : `${shown.direction === "up" ? "Up" : "Down"} ${shown.spoken} from ${from}`}
          </span>
        </span>
      )}
    </span>
  );
}
