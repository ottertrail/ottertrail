import type * as React from "react";

/**
 * Whether a click on a row's link is a plain one, which selects the row in
 * a workbench; a click that opens a new tab or window opens the item's own
 * page, as a link does.
 */
export const isPlainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** A row's link's click: a plain one selects the row; any other follows the link. */
export const selectOnPlainClick =
  (select: (id: string) => void, id: string) => (event: React.MouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    select(id);
  };

/** The list's table classes: small untracked heads, the page's gutters at both ends. */
export const LIST_HEAD = "h-9 text-xs font-normal text-ink-subtle";
export const GUTTER_START = "pl-[var(--gutter)]";
export const GUTTER_END = "pr-[var(--gutter)]";
/** A chosen row: a 2px brand rule at its start. */
export const SELECTED_ROW = "data-[state=selected]:shadow-[inset_2px_0_0_var(--brand)]";

/** A count that may be only part of the whole: "50+" when more were left out. */
export const atLeast = (count: number, more: boolean) =>
  `${count.toLocaleString("en-US")}${more ? "+" : ""}`;
