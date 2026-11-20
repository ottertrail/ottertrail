import * as React from "react";

const PRODUCT = "Ottertrail";

/**
 * The browser tab's title, most specific first, so a narrow tab still shows
 * the page: "Errors · Demo shop – Ottertrail". Parts not known yet, or the
 * same as the product's name, are left out. The instance's name is not in
 * it: the sidebar shows it.
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

/*
 * A 404 or an error shown in place of a page names the tab instead of the
 * page ("Page not found – Ottertrail"). The state registers its title
 * here, and the shell's and the sign-in layout's tab titles read it, so the
 * two never overwrite each other.
 */
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
