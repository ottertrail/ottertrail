import * as React from "react";

/**
 * Use rem breakpoints so they follow the reader's font size
 * (docs/design-system.md#responsive-rules).
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

/** Sidebar sheet and single-column layouts below 60rem. */
export const NARROW_SHELL = "(width < 60rem)";

/** Narrow gutters; lists omit columns available on the item's page. */
export const PHONE = "(width < 40rem)";

/** Below 64rem, workbench items open on separate pages. */
export const NARROW_WORKBENCH = "(width < 64rem)";
