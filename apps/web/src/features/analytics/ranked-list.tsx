import type * as React from "react";

import { formatWhole } from "./format";

export interface RankedRow {
  key: string;
  label: React.ReactNode;
  /** Full text when the label is cut short, such as a long path. */
  title?: string;
  /** Sets the bar's length. */
  primary: number;
  secondary: number;
}

/**
 * Ranked rows with a bar each: one hue, bars from one baseline, largest
 * first (the API sorts them). The figures are text, so the list doubles as
 * its own table view; the bars only show the ranking at a glance.
 */
export function RankedList({
  rows,
  caption,
  nameHeading,
  primaryHeading,
  secondaryHeading,
  empty,
}: {
  rows: RankedRow[];
  caption: string;
  nameHeading: string;
  primaryHeading: string;
  secondaryHeading: string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-subtle">{empty}</p>;
  }
  const max = Math.max(0, ...rows.map((row) => row.primary));
  return (
    <table className="w-full table-fixed text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            {nameHeading}
          </th>
          <th scope="col" className="w-20 pb-2 text-right font-normal">
            {primaryHeading}
          </th>
          <th scope="col" className="w-20 pb-2 text-right font-normal">
            {secondaryHeading}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className="py-1.5 pr-3 align-top">
              <div className="truncate text-ink" title={row.title}>
                {row.label}
              </div>
              <div
                aria-hidden="true"
                className="mt-1 h-1.5 rounded-r bg-chart-1"
                style={{ width: `${max === 0 ? 0 : (row.primary / max) * 100}%` }}
              />
            </td>
            <td className="py-1.5 text-right align-top text-ink tabular-nums">
              {formatWhole(row.primary)}
            </td>
            <td className="py-1.5 text-right align-top text-ink-subtle tabular-nums">
              {formatWhole(row.secondary)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
