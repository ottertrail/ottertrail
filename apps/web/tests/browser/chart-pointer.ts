import { expect } from "vite-plus/test";

/*
 * A pointer or a finger on a chart drawn with Recharts (components/ui/chart.tsx), and the
 * tooltip it opens. Positions are shares of the plot, the area inside the axes, which the
 * chart's grid fills.
 */

/** The plot's box: the grid's, inside the axes. */
function plotBox(chart: Element): DOMRect {
  const grid = chart.querySelector(".recharts-cartesian-grid");
  if (grid === null) throw new Error("The chart has no plot");
  return grid.getBoundingClientRect();
}

/** Where `share` of the way across the plot is, halfway down. */
export function plotPoint(chart: Element, share: number): { clientX: number; clientY: number } {
  const box = plotBox(chart);
  return { clientX: box.left + box.width * share, clientY: box.top + box.height / 2 };
}

/** The middle of bar `index` of `count`. */
export function barPoint(
  chart: Element,
  index: number,
  count: number,
): { clientX: number; clientY: number } {
  return plotPoint(chart, (index + 0.5) / count);
}

/** The element Recharts listens on. */
function surface(chart: Element): Element {
  const wrapper = chart.querySelector(".recharts-wrapper");
  if (wrapper === null) throw new Error("The chart is not drawn");
  return wrapper;
}

/** Waits two frames, for Recharts to read a move. */
const nextFrames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export const tooltipOf = (chart: Element) => chart.querySelector("[data-slot=chart-tooltip]");

/** Moves the mouse to a point of the chart. */
export function pointTo(chart: Element, point: { clientX: number; clientY: number }) {
  surface(chart).dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...point }));
}

/** Moves the mouse off the chart. React reads leaving from mouseout, to where it went. */
export function leave(chart: Element) {
  surface(chart).dispatchEvent(
    new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
  );
}

/** Clicks a point of the chart, moving there first, as a mouse does. Recharts reads moves once a frame. */
export async function clickAt(chart: Element, point: { clientX: number; clientY: number }) {
  const target = surface(chart);
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  pointTo(chart, point);
  await nextFrames();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, ...point }));
}

/** Points at `share` of the plot, and returns the tooltip's text, then leaves it closed. */
export async function hoverAt(chart: Element, share: number): Promise<string | null | undefined> {
  pointTo(chart, plotPoint(chart, share));
  await expect.poll(() => tooltipOf(chart)).not.toBeNull();
  const text = tooltipOf(chart)?.textContent;
  leave(chart);
  await expect.poll(() => tooltipOf(chart)).toBeNull();
  return text;
}

function touchEvent(type: string, target: Element, point: { clientX: number; clientY: number }) {
  const touch = new Touch({ identifier: 1, target, ...point });
  const touches = type === "touchend" ? [] : [touch];
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
    targetTouches: touches,
    changedTouches: [touch],
  });
}

/**
 * A tap, as a phone's browser sends it: the touch, then the mouse events it makes up after a
 * tap that did not move, at the same point.
 */
export async function tapAt(chart: Element, point: { clientX: number; clientY: number }) {
  const target = surface(chart);
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  target.dispatchEvent(touchEvent("touchstart", target, point));
  target.dispatchEvent(touchEvent("touchend", target, point));
  pointTo(chart, point);
  await nextFrames();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, ...point }));
}

/** A finger put down at one share of the plot and dragged to others; it is not lifted. */
export function dragAcross(chart: Element, shares: number[]) {
  const target = surface(chart);
  const [first, ...rest] = shares;
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  target.dispatchEvent(touchEvent("touchstart", target, plotPoint(chart, first ?? 0)));
  for (const share of rest) {
    target.dispatchEvent(touchEvent("touchmove", target, plotPoint(chart, share)));
  }
}
