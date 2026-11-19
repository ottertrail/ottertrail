/**
 * The first column of a table that scrolls sideways on a phone: it names
 * the row, so it stays in view, on the surface the table sits on.
 */
export const PINNED =
  "max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:bg-[var(--block-surface,var(--background))]";

/**
 * The last column of such a table, when it holds the row's actions (open
 * its trace, add an alert rule): pinned at the other edge, so what acts on
 * the row stays in view too.
 */
export const PINNED_END =
  "max-sm:sticky max-sm:right-0 max-sm:z-10 max-sm:bg-[var(--block-surface,var(--background))]";
