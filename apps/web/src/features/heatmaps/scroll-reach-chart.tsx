import * as React from "react";

import type { Heatmap } from "@/lib/heatmaps-api";

import { formatWhole } from "../analytics/format";
import { formatShare } from "./format";

/** Ten rows must fit the 140px plot. */
const ROW = 14;
const GRID = [0.25, 0.5, 0.75, 1];

type Reach = Heatmap["scroll"]["reach"][number];

const depthText = (depth: number) => (depth === 100 ? "the bottom" : `${depth}% down`);

const describe = (row: Reach) =>
  `${depthText(row.depth)}: ${formatShare(row.share)} of pageviews reached it (${formatWhole(row.pageviews)})`;

/** Bars show pageview share at each depth; the fold line shows page depth. A hidden range input supports keyboard navigation. */
export function ScrollReachChart({
  reach,
  averageFold,
}: {
  reach: Reach[];
  averageFold: number | null;
}) {
  const rows = reach.toSorted((a, b) => a.depth - b.depth);
  const plotRef = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState<number | null>(null);
  const last = rows.length - 1;
  const height = rows.length * ROW;
  const shown = active ?? 0;
  const activeRow = active === null ? undefined : rows[active];

  function rowAt(clientY: number): number | null {
    const plot = plotRef.current;
    if (plot === null || rows.length === 0) return null;
    const offset = clientY - plot.getBoundingClientRect().top;
    if (offset < 0 || offset >= height) return null;
    return Math.min(last, Math.floor(offset / ROW));
  }

  const fold = averageFold === null ? null : Math.min(1, Math.max(0, averageFold));
  const foldLabelTop = fold === null ? 0 : Math.min(height - 13, Math.max(13, fold * height));

  return (
    <div className="flex flex-col gap-1">
      {fold !== null && (
        <p className="sr-only">
          Average fold: {formatShare(fold)} of the page showed without scrolling.
        </p>
      )}
      <div
        data-slot="scroll-reach-chart"
        className="relative grid grid-cols-[4.5rem_minmax(0,1fr)_6rem] rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring"
        onPointerMove={(event) => setActive(rowAt(event.clientY))}
        onPointerLeave={() => setActive(null)}
      >
        {rows.length > 0 && (
          <input
            type="range"
            className="sr-only"
            aria-label="Share of pageviews reaching each depth of the page"
            aria-valuetext={rows[shown] === undefined ? undefined : describe(rows[shown])}
            min={0}
            max={last}
            step={1}
            value={shown}
            onChange={(event) => setActive(Number(event.target.value))}
            onFocus={() => setActive(shown)}
            onBlur={() => setActive(null)}
          />
        )}
        <div aria-hidden="true" className="flex flex-col pr-2">
          {rows.map((row, index) => (
            <div
              key={row.depth}
              className={`text-right text-[11px] leading-[14px] tabular-nums ${
                index === active ? "text-ink" : "text-ink-subtle"
              }`}
              style={{ height: ROW }}
            >
              {row.depth === 100 ? "Bottom" : `${row.depth}%`}
            </div>
          ))}
        </div>
        <div
          ref={plotRef}
          aria-hidden="true"
          className="relative border-l border-hairline-tertiary"
          style={{ height }}
        >
          {GRID.map((share) => (
            <div
              key={share}
              className="absolute inset-y-0 w-px bg-hairline"
              style={{ left: `${share * 100}%` }}
            />
          ))}
          {rows.map((row, index) => (
            <div
              key={row.depth}
              className={`relative flex items-center ${index === active ? "bg-accent" : ""}`}
              style={{ height: ROW }}
            >
              <div
                data-slot="scroll-reach-bar"
                data-depth={row.depth}
                className="h-1.5 rounded-r bg-chart-1"
                style={{
                  width: `${Math.min(1, Math.max(0, row.share)) * 100}%`,
                  minWidth: row.share > 0 ? 2 : 0,
                }}
              />
            </div>
          ))}
        </div>
        <div aria-hidden="true" />
        {fold !== null && (
          <div data-slot="average-fold" aria-hidden="true" className="pointer-events-none">
            <div
              className="absolute right-24 left-0 border-t border-ink-muted"
              style={{ top: fold * height }}
            />
            <span
              className="absolute right-0 w-24 -translate-y-1/2 pl-2 text-[11px] leading-[13px] text-ink-muted"
              style={{ top: foldLabelTop }}
            >
              Average fold, {formatShare(fold)} down
            </span>
          </div>
        )}
        {activeRow !== undefined && active !== null && (
          <div
            data-slot="chart-readout"
            className="pointer-events-none absolute right-24 z-10 flex flex-col gap-0.5 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
            style={
              active < rows.length / 2
                ? { top: (active + 1) * ROW + 4 }
                : { bottom: height - active * ROW + 4 }
            }
          >
            <span className="font-medium text-ink">Reached {depthText(activeRow.depth)}</span>
            <span className="text-ink-muted tabular-nums">
              {formatShare(activeRow.share)} of pageviews ({formatWhole(activeRow.pageviews)})
            </span>
          </div>
        )}
      </div>
      <div aria-hidden="true" className="grid grid-cols-[4.5rem_minmax(0,1fr)_6rem]">
        <span />
        <div className="relative h-4 text-[11px] text-ink-subtle tabular-nums">
          <span className="absolute left-0">0%</span>
          {GRID.map((share) => (
            <span
              key={share}
              // Hide quarter labels on phones to avoid overlap.
              className={`absolute ${share === 1 ? "right-0" : "-translate-x-1/2"} ${
                share === 0.25 || share === 0.75 ? "max-sm:hidden" : ""
              }`}
              style={share === 1 ? undefined : { left: `${share * 100}%` }}
            >
              {formatShare(share)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ScrollReachTable({ reach }: { reach: Reach[] }) {
  return (
    <table className="w-full max-w-2xl text-sm">
      <caption className="sr-only">Pageviews reaching each depth of the page</caption>
      <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Depth
          </th>
          <th scope="col" className="pb-2 text-right font-normal">
            Pageviews
          </th>
          <th scope="col" className="pb-2 text-right font-normal">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {reach
          .toSorted((a, b) => a.depth - b.depth)
          .map((row) => (
            <tr key={row.depth} className="border-t border-hairline">
              <th scope="row" className="py-1.5 text-left font-normal text-ink">
                {row.depth}%
              </th>
              <td className="py-1.5 text-right text-ink tabular-nums">
                {formatWhole(row.pageviews)}
              </td>
              <td className="py-1.5 text-right text-ink-subtle tabular-nums">
                {formatShare(row.share)}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}
