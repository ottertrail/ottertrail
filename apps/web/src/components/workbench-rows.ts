import { cn } from "cn";
import type * as React from "react";

import { clickableRow } from "@/components/clickable-row";

export { ROW_LINK } from "@/components/clickable-row";

/** Select on a plain click; preserve link behavior for new-tab or new-window clicks. */
export const isPlainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** A row's link's click: a plain one selects the row; any other follows the link. */
export const selectOnPlainClick =
  (select: (id: string) => void, id: string) => (event: React.MouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    select(id);
  };

export const LIST_HEAD = "h-9 text-xs font-normal text-ink-subtle";
export const GUTTER_START = "pl-[var(--gutter)]";
export const GUTTER_END = "pr-[var(--gutter)]";
export const SELECTED_ROW = "data-[state=selected]:shadow-[inset_2px_0_0_var(--brand)]";

/**
 * Mark the name with ROW_LINK for keyboard and screen reader access.
 * Use the ID for selection and keyboard scrolling.
 */
export const workbenchRow = (id: string, chosen: boolean, className?: string) => ({
  "data-workbench-id": id,
  "data-state": chosen ? "selected" : undefined,
  ...clickableRow(cn(SELECTED_ROW, className)),
});

/** A count that may be only part of the whole: "50+" when more were left out. */
export const atLeast = (count: number, more: boolean) =>
  `${count.toLocaleString("en-US")}${more ? "+" : ""}`;
