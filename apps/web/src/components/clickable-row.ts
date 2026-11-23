import { cn } from "cn";
import type * as React from "react";

/*
 * Keep the name as a real link or button for keyboard and screen reader access.
 * The row adds mouse clicks without a role or tab stop (docs/design-system.md, "Clickable rows").
 */

export const CLICKABLE_ROW =
  "cursor-pointer hover:bg-muted/50 [&_[data-row-passthrough]]:cursor-pointer";

/** What a click on these acts on itself, so the row leaves it alone. */
const CONTROLS = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable]",
  "[role='button']",
  "[role='link']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='combobox']",
].join(", ");

function primaryOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>("[data-row-link]");
}

/**
 * Ignore controls, text-selection drags, and portaled dialogs or menus.
 * React bubbles portal events through the row even though their DOM is elsewhere.
 */
function standsFor(event: React.MouseEvent<HTMLElement>): HTMLElement | null {
  const row = event.currentTarget;
  const target = event.target;
  if (event.defaultPrevented || !(target instanceof Element) || !row.contains(target)) return null;
  const control = target.closest(CONTROLS);
  if (control !== null && row.contains(control) && !control.hasAttribute("data-row-passthrough")) {
    return null;
  }
  const selection = window.getSelection();
  if (
    selection !== null &&
    !selection.isCollapsed &&
    selection.toString().trim() !== "" &&
    (row.contains(selection.anchorNode) || row.contains(selection.focusNode))
  ) {
    return null;
  }
  return primaryOf(row);
}

/** A link's address opened in a new tab, as a Cmd, Ctrl or middle click on it does. */
function openApart(primary: HTMLElement) {
  if (primary instanceof HTMLAnchorElement && primary.href !== "") {
    window.open(primary.href, "_blank", "noopener");
  }
}

function onRowClick(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const primary = standsFor(event);
  if (primary === null) return;
  // Ignore Alt downloads and Shift text selections.
  if (event.altKey || event.shiftKey) return;
  if (event.metaKey || event.ctrlKey) {
    // Buttons have no page to open in a new tab.
    openApart(primary);
    return;
  }
  // Focus the name so Tab continues from this row.
  primary.focus({ preventScroll: true });
  primary.click();
}

function onRowAuxClick(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 1) return;
  const primary = standsFor(event);
  if (primary !== null) openApart(primary);
}

/**
 * Mark the name with ROW_LINK. Plain clicks focus and activate it; Cmd, Ctrl, or middle clicks
 * open links in a new tab. Ignore Shift, Alt, controls, and text-selection drags.
 * Use data-row-passthrough on tooltip-only controls to let clicks reach the row.
 */
export function clickableRow(className?: string, enabled = true) {
  if (!enabled) return { className };
  return {
    className: cn(CLICKABLE_ROW, className),
    onClick: onRowClick,
    onAuxClick: onRowAuxClick,
  };
}

export const ROW_LINK = { "data-row-link": "" } as const;
