import type * as React from "react";

import { RowName } from "@/components/breakdown-table";
import { MISSING } from "@/lib/missing";

import { formatPercent, formatWhole } from "./format";
import { rowRate } from "./list-rows";

export interface RankedRow {
  key: string;
  label: React.ReactNode;
  /** Full tooltip text when a truncated label contains markup. */
  title?: string;
  primary: number;
  secondary?: number;
  /** With a goal: the row's converted visitors. */
  converted?: number | undefined;
  /** Exit pages only: exits divided by pageviews. */
  exitRate?: number | null | undefined;
  /** A small link or mark after the name, on the page only (a page's heatmap). */
  action?: React.ReactNode;
}

/**
 * The API sorts rows largest first; text values also serve as the table
 * view. With a goal, each row shows its visitors, converted visitors, and
 * rate, and the bar the converted.
 */
export function RankedList({
  rows,
  caption,
  nameHeading,
  primaryHeading,
  secondaryHeading,
  rateHeading,
  goal = false,
  empty,
}: {
  rows: RankedRow[];
  caption: string;
  nameHeading: string;
  primaryHeading: string;
  secondaryHeading?: string;
  /** A third figure, each row's exit rate (exit pages), when there is no goal. */
  rateHeading?: string | undefined;
  goal?: boolean;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-subtle">{empty}</p>;
  }
  const barOf = (row: RankedRow) => (goal ? (row.converted ?? 0) : row.primary);
  const max = Math.max(0, ...rows.map(barOf));
  const rate = !goal && rateHeading !== undefined;
  const headings = goal
    ? [primaryHeading, "Converted", "Rate"]
    : [
        primaryHeading,
        ...(secondaryHeading === undefined ? [] : [secondaryHeading]),
        ...(rate ? [rateHeading] : []),
      ];
  const figures = (row: RankedRow) =>
    goal
      ? [formatWhole(row.primary), formatWhole(row.converted ?? 0), rowRate(row)]
      : [
          formatWhole(row.primary),
          ...(secondaryHeading === undefined
            ? []
            : [row.secondary === undefined ? MISSING : formatWhole(row.secondary)]),
          ...(rate ? [formatPercent(row.exitRate ?? null)] : []),
        ];
  // The bar's figure is in ink; the others are quieter.
  const barFigure = goal ? 1 : 0;
  return (
    <table className="w-full table-fixed text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            {nameHeading}
          </th>
          {headings.map((heading) => (
            <th
              key={heading}
              scope="col"
              // Three figures leave the name room on a phone.
              className={`${goal || rate ? "w-16" : "w-20"} pb-2 text-right font-normal`}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className="py-1.5 pr-3 align-top">
              <RowName row={row} />

              <div
                aria-hidden="true"
                className="mt-1 h-1.5 rounded-r bg-chart-1"
                style={{ width: `${max === 0 ? 0 : (barOf(row) / max) * 100}%` }}
              />
            </td>
            {figures(row).map((figure, index) => (
              <td
                // Figures have a fixed order, one per heading.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                className={`py-1.5 text-right align-top tabular-nums ${index === barFigure ? "text-ink" : "text-ink-subtle"}`}
              >
                {figure}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
