import { cn } from "cn";
import type * as React from "react";

/*
 * A table row that is one item opening one thing (a check, a project, a
 * metric): a click anywhere on it does what a click on its name does. The
 * name stays the real link or button, for the keyboard and screen readers;
 * the row's click is a mouse convenience, so the row takes no role and no
 * tab stop (docs/design-system.md, "Clickable rows").
 */

/** The row's look: the pointer, and a hover wash on clickable rows only. */
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

/** The name a click on the row stands for: the link or button marked `data-row-link`. */
function primaryOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>("[data-row-link]");
}

/**
 * The row's name, when a click on `event`'s target stands for one on it:
 * not a click on a control of the row's own (which acts alone), not one
 * from a dialog or menu the row opened (React passes those up through the
 * portal, though the row does not hold them), and not the end of a drag
 * that selected text in the row.
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
  // Alt on a link downloads it, and Shift extends a text selection: nothing a row should do.
  if (event.altKey || event.shiftKey) return;
  if (event.metaKey || event.ctrlKey) {
    // A button (a log record, chosen in place) has no page to open apart: the row stays as it is.
    openApart(primary);
    return;
  }
  // Focus goes to the name, as a click on it would put it, so Tab carries on from this row.
  primary.focus({ preventScroll: true });
  // The name's own handler runs: it selects the row in a workbench, or follows the link.
  primary.click();
}

function onRowAuxClick(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 1) return;
  const primary = standsFor(event);
  if (primary !== null) openApart(primary);
}

/**
 * Props for a `<tr>` (or `TableRow`) whose whole row stands for its name,
 * the link or button marked `data-row-link` (`ROW_LINK`): a plain click on
 * a cell focuses and clicks the name; a Cmd or Ctrl click, or a middle
 * click, opens the name's link in a new tab, leaving the list as it is;
 * Shift and Alt do nothing. Clicks on the row's own controls (a switch, a
 * pause button, a link elsewhere) and drags that select text do nothing
 * more. A control that only shows a tooltip (the status classes' bar)
 * carries `data-row-passthrough`: a click on it is the row's. With `enabled` false (a row
 * whose name has no page), the row is a plain one.
 */
export function clickableRow(className?: string, enabled = true) {
  if (!enabled) return { className };
  return {
    className: cn(CLICKABLE_ROW, className),
    onClick: onRowClick,
    onAuxClick: onRowAuxClick,
  };
}

/** Marks the row's name, the link or button a click on the row stands for. */
export const ROW_LINK = { "data-row-link": "" } as const;
