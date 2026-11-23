import * as React from "react";

const PRODUCT = "Ottertrail";

/**
 * Put the page first so narrow tabs show it. Omit unknown or duplicate product names.
 * The sidebar already shows the instance name.
 */
export function documentTitle(parts: {
  page?: string | undefined;
  project?: string | undefined;
}): string {
  const shown = [parts.page, parts.project]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== "" && part !== PRODUCT);
  return shown.length === 0 ? PRODUCT : `${shown.join(" · ")} – ${PRODUCT}`;
}

/** Sets the tab's title while the component is shown. */
export function useDocumentTitle(title: string) {
  React.useEffect(() => {
    document.title = title;
  }, [title]);
}

/* Page states register a shared tab title so the shell and sign-in layout cannot overwrite it. */
let statusTitle: string | undefined;
const statusListeners = new Set<() => void>();
const subscribeStatus = (listener: () => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};
const setStatusTitle = (title: string | undefined) => {
  statusTitle = title;
  for (const listener of statusListeners) listener();
};

/** The title a 404 or error state put in place of the page's, if one shows. */
export function useStatusTitle(): string | undefined {
  return React.useSyncExternalStore(
    subscribeStatus,
    () => statusTitle,
    () => undefined,
  );
}

/** Puts `title` in place of the page's title in the tab while the state shows. */
export function useShowStatusTitle(title: string) {
  React.useEffect(() => {
    setStatusTitle(title);
    return () => {
      if (statusTitle === title) setStatusTitle(undefined);
    };
  }, [title]);
}
