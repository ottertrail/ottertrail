import type { ElementRole, ReplaySummary, ReplayTimeline, TimelineItem } from "@/lib/replays-api";

/** Render recording data as React text only; never use it as HTML, links, or styles. */

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatReplayDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

const ROLE_NAMES: Record<ElementRole, string> = {
  button: "a button",
  link: "a link",
  checkbox: "a checkbox",
  radio: "a radio button",
  switch: "a switch",
  tab: "a tab",
  menuitem: "a menu item",
  option: "an option",
  textbox: "a text field",
  searchbox: "a search field",
  combobox: "a drop-down",
  listbox: "a list",
  slider: "a slider",
  spinbutton: "a number field",
};

const CHOSEN: ReadonlySet<ElementRole> = new Set<ElementRole>([
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "slider",
  "option",
]);

/** Describe actions only; the recording masks field values. */
export function describeItem(item: TimelineItem, first: boolean): string {
  switch (item.kind) {
    case "page":
      return first ? `On ${item.path}` : `Went to ${item.path}`;
    case "click": {
      const what = item.role === null ? `a <${item.tag}> element` : ROLE_NAMES[item.role];
      return `Clicked ${what} at ${item.x}, ${item.y}`;
    }
    case "input":
      return item.role !== null && CHOSEN.has(item.role) ? "Changed a field" : "Typed in a field";
    case "scroll":
      return `Scrolled to ${item.y} px`;
    default:
      return "The error";
  }
}

export const pagesText = (pages: readonly string[]) => pages.join(" → ");

/** Add the error event as a marker if the recording has none. Include scrolls only on request. */
export function timelineItems(answer: ReplayTimeline, withScrolls: boolean): TimelineItem[] {
  const items = answer.timeline.items.filter((item) => withScrolls || item.kind !== "scroll");
  if (answer.errorOffsetMs !== null && !items.some((item) => item.kind === "error")) {
    const at = answer.errorOffsetMs;
    const index = items.findIndex((item) => item.at > at);
    items.splice(index === -1 ? items.length : index, 0, { at, kind: "error" });
  }
  return items;
}

export function currentIndex(items: readonly TimelineItem[], currentMs: number | null): number {
  if (currentMs === null) return -1;
  let found = -1;
  for (const [index, item] of items.entries()) {
    if (item.at <= currentMs) found = index;
  }
  return found;
}

export const clientText = (replay: Pick<ReplaySummary, "browser" | "os" | "deviceType">) =>
  [replay.browser, replay.os, replay.deviceType]
    .filter((part) => part !== null && part !== "")
    .join(", ");
