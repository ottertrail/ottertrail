import * as React from "react";
import type { XAxisProps, YAxisProps } from "recharts";

/*
 * The look and tick rules every chart built on components/ui/chart.tsx shares
 * (docs/design-system.md, "Charts"). Type imports only, so this file loads no chart code.
 */

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** An axis count: "950", "1.2K", "3.4M". */
export function formatAxisCount(value: number): string {
  return Math.abs(value) < 1000 ? whole.format(value) : compact.format(value);
}

/** The x axis: 11px labels in ink-subtle, no axis line or tick marks. */
export const X_AXIS = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  height: 28,
  // The charts pass evenly spaced ticks (evenTicks); Recharts still drops a label that would
  // touch the next one, counting from the end, should a label run longer than measured.
  interval: "preserveEnd",
  minTickGap: 4,
  tick: { fontSize: 11 },
} satisfies Partial<XAxisProps>;

/** The y axis: as wide as its longest label. */
export const Y_AXIS = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  width: "auto",
  tick: { fontSize: 11 },
} satisfies Partial<YAxisProps>;

/** The plot's margin inside the chart. */
export const MARGIN = { top: 12, right: 16, bottom: 0, left: 0 };

/** Height under the plot for the x axis's labels. */
export const AXIS_BAND = 28;

/**
 * The frame around a plot: it holds the hidden range input's focus ring, and lets a horizontal
 * finger drag move the tooltip while a vertical one still scrolls the page.
 */
export const PLOT_FRAME =
  "relative w-full touch-pan-y rounded-md select-none has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring";

/** About the y axis's width and the margins, before the chart has measured them. */
const AXIS_ROOM = 56;

/**
 * Every n-th candidate tick, counting back from the last so the latest point keeps its label,
 * with n as small as lets each label keep 16px from the next at this width: a phone gets fewer
 * labels, evenly spaced. `labels` are the candidates' texts, measured at about 6.5px a character.
 */
export function evenTicks(candidates: number[], labels: string[], width: number): number[] {
  if (width <= 0 || candidates.length === 0) return candidates;
  const labelWidth = Math.max(...labels.map((label) => label.length)) * 6.5;
  const room = Math.max(1, Math.floor((width - AXIS_ROOM) / (labelWidth + 16)));
  const every = Math.max(1, Math.ceil(candidates.length / room));
  const last = candidates.length - 1;
  return candidates.filter((_, n) => (last - n) % every === 0);
}

/** The hovered point's dot: the series color with a ring of the surface. */
export const activeDot = (color: string) => ({
  r: 4,
  fill: color,
  stroke: "var(--block-surface, var(--background))",
  strokeWidth: 2,
});

/** An element's width as it changes. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
