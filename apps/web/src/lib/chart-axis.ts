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
  // The charts pass evenly spaced ticks (evenTicks), so every one is drawn. Recharts' own
  // thinning ("preserveEnd") took the first label for centered, though EdgeTick starts it at
  // the plot's edge, and dropped it beside a narrow y axis: "10 Nov" went missing.
  interval: 0,
  tick: { fontSize: 11 },
} satisfies Partial<XAxisProps>;

const Y_TICK_MARGIN = 8;
/** Recharts keeps room for the tick mark even with tickLine off. */
const Y_TICK_SIZE = 6;
const Y_FONT_SIZE = 11;

/** The y axis: 11px labels, no axis line or tick marks. Its width comes from useYAxisWidth. */
export const Y_AXIS = {
  axisLine: false,
  tickLine: false,
  tickSize: Y_TICK_SIZE,
  tickMargin: Y_TICK_MARGIN,
  tick: { fontSize: Y_FONT_SIZE },
} satisfies Partial<YAxisProps>;

let measuring: CanvasRenderingContext2D | null | undefined;

/** The widest label's width at the y axis's font, in pixels; null without a canvas. */
function widestLabel(labels: readonly string[]): number | null {
  measuring ??= document.createElement("canvas").getContext("2d");
  if (measuring === null) return null;
  measuring.font = `${Y_FONT_SIZE}px ${getComputedStyle(document.body).fontFamily}`;
  return Math.max(0, ...labels.map((label) => measuring?.measureText(label).width ?? 0));
}

/**
 * The y axis's width for its labels: the widest one, measured on a canvas at the axis's font,
 * plus the tick mark's room and the margin. Recharts' `width: "auto"` measures the rendered labels once, and a
 * measure taken before the layout settles stuck too narrow, cutting "150" to "0". This one is
 * worked out from the text, and again once the web fonts have loaded.
 */
export function useYAxisWidth(labels: readonly string[]): number {
  const [fontsLoaded, setFontsLoaded] = React.useState(() => document.fonts.status === "loaded");
  React.useEffect(() => {
    if (fontsLoaded) return undefined;
    let current = true;
    void document.fonts.ready.then(() => {
      if (current) setFontsLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [fontsLoaded]);
  // Measured on every render, a few labels at a time: the render after the fonts load measures
  // the web font instead of the fallback.
  const widest = widestLabel(labels) ?? Math.max(0, ...labels.map((label) => label.length)) * 6.5;
  // A pixel of slack for rounding between the canvas and the SVG.
  return Math.ceil(widest) + Y_TICK_SIZE + Y_TICK_MARGIN + 1;
}

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
