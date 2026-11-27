import { cn } from "cn";
import { usePlotArea } from "recharts";

/*
 * Parts every chart built on components/ui/chart.tsx shares (docs/design-system.md, "Charts"):
 * the hidden range input that is the keyboard and screen reader path, the tooltip's box, and
 * the dot of a value that stands alone. The axes' look is in lib/chart-axis.ts.
 */

/**
 * The keyboard and screen reader path to a chart's values: a visually hidden range input with
 * one step per point. While it has focus, `index` is the point the tooltip shows.
 */
export function ChartKeys({
  label,
  count,
  index,
  fallback,
  valueText,
  onIndex,
  onEnter,
}: {
  label: string;
  count: number;
  /** The point focus is on, or null without focus. */
  index: number | null;
  /** The point the input rests on without focus: the latest one. */
  fallback: number;
  valueText: (index: number) => string;
  onIndex: (index: number | null) => void;
  onEnter?: ((index: number) => void) | undefined;
}) {
  if (count === 0) return null;
  const shown = index ?? fallback;
  return (
    <input
      type="range"
      className="sr-only"
      aria-label={label}
      aria-valuetext={valueText(shown)}
      min={0}
      max={count - 1}
      step={1}
      value={shown}
      onChange={(event) => onIndex(Number(event.target.value))}
      onFocus={() => onIndex(shown)}
      onBlur={() => onIndex(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && onEnter !== undefined) onEnter(shown);
      }}
    />
  );
}

export interface ReadoutRow {
  key: string;
  /** The series' color; none for a row that is not drawn. */
  color?: string | undefined;
  /** A line's key is a short stroke, a bar's a square. */
  marker?: "line" | "square";
  value: string;
  label: string;
  /** A total under the parts, after a rule. */
  total?: boolean;
}

/** The tooltip's box: the point's name, then each value before its label. */
export function ChartReadout({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: ReadoutRow[];
  footer?: string | undefined;
}) {
  return (
    <div
      aria-hidden="true"
      data-slot="chart-tooltip"
      className="max-w-[min(20rem,calc(100vw-2rem))] min-w-40 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
    >
      <p className="mb-1.5 text-ink-subtle">{title}</p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.key}
            className={cn("flex min-w-0 items-center gap-2", row.total && "border-t pt-1")}
          >
            <span
              className={cn(
                "shrink-0",
                row.marker === "square" ? "size-2 rounded-sm" : "h-0.5 w-3 rounded-full",
              )}
              style={{ background: row.color ?? "transparent" }}
            />
            <span className="font-semibold whitespace-nowrap text-ink tabular-nums">
              {row.value}
            </span>
            <span className="truncate text-ink-subtle">{row.label}</span>
          </li>
        ))}
      </ul>
      {footer !== undefined && <p className="mt-1.5 text-ink-subtle">{footer}</p>}
    </div>
  );
}

/**
 * A line's dot, which Recharts renders at every point with cx, cy, and index: drawn only where a
 * value stands alone between gaps, since a line needs two points.
 */
export function IsolatedDot({
  series,
  seriesColor,
  cx,
  cy,
  index = -1,
}: {
  series: readonly (number | null | undefined)[];
  seriesColor: string;
  cx?: number;
  cy?: number;
  index?: number;
}) {
  const alone =
    series[index] !== null &&
    series[index] !== undefined &&
    (series[index - 1] ?? null) === null &&
    (series[index + 1] ?? null) === null;
  if (!alone || cx === undefined || cy === undefined) return null;
  return <circle cx={cx} cy={cy} r={4} fill={seriesColor} />;
}

/**
 * An x axis label, as Recharts renders it at a tick's x and y: centered on its tick, but moved
 * to start or end at the plot's edge where centering would cut it, so the first and last labels
 * show whole. Its width is estimated at 6.5px a character, as `evenTicks` estimates it.
 */
export function EdgeTick({
  x = 0,
  y = 0,
  payload,
  format,
}: {
  x?: number;
  y?: number;
  payload?: { value?: unknown };
  format: (value: number) => string;
}) {
  const plot = usePlotArea();
  const text = typeof payload?.value === "number" ? format(payload.value) : "";
  const half = (text.length * 6.5) / 2;
  let anchor: "start" | "middle" | "end" = "middle";
  let at = x;
  if (plot !== undefined && x - half < plot.x) {
    anchor = "start";
    at = Math.max(plot.x, x - half);
  } else if (plot !== undefined && x + half > plot.x + plot.width) {
    anchor = "end";
    at = Math.min(plot.x + plot.width, x + half);
  }
  return (
    <text x={at} y={y} dy="0.71em" textAnchor={anchor} fontSize={11} className="fill-ink-subtle">
      {text}
    </text>
  );
}
