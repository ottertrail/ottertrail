import * as React from "react";

/**
 * Whether a media query matches, kept current as the window changes. Use the
 * system's breakpoints in rem (docs/design-system.md#responsive-rules), so
 * they follow the reader's font size.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Under 60rem the sidebar is a menu in a sheet, and multi-column layouts go to one column. */
export const NARROW_SHELL = "(width < 60rem)";

/** A phone: the gutters narrow, and lists drop the columns their item's page has. */
export const PHONE = "(width < 40rem)";

/** Under 64rem a list-and-detail screen shows the list alone; an item opens its own page. */
export const NARROW_WORKBENCH = "(width < 64rem)";
