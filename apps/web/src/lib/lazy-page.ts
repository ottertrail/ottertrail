import { lazyRouteComponent } from "@tanstack/react-router";
import type * as React from "react";

/**
 * Deploys can remove chunks requested by older tabs. Browsers cache failed imports,
 * so recovery requires reload. A custom message prevents TanStack Router's automatic reload,
 * letting the user choose when to reload (docs/dashboard.md, "Code splitting").
 */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("The page's code could not be downloaded.", { cause });
    this.name = "PageLoadError";
  }
}

/**
 * Chromium, Firefox, and Safari import failures, matching TanStack Router's checks,
 * plus Vite stylesheet preload failures.
 */
const FAILED_FETCH = [
  /^Failed to fetch dynamically imported module/,
  /^error loading dynamically imported module/,
  /^Importing a module script failed/,
  /^Unable to preload CSS/,
];

/**
 * Match browser messages because application bugs can also be TypeErrors.
 * Check causes for wrapped import failures, including Vitest's module mocker.
 */
export function failedDownload(error: unknown): Error | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const { message } = current;
    if (FAILED_FETCH.some((pattern) => pattern.test(message))) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/** Wrap download failures in PageLoadError; propagate other errors unchanged. */
export async function loadChunk<M>(load: () => Promise<M>): Promise<M> {
  try {
    return await load();
  } catch (error) {
    const download = failedDownload(error);
    throw download === undefined ? error : new PageLoadError(download);
  }
}

/**
 * Let the router preload chunks on link hover or focus (defaultPreload: "intent").
 * Wrappers must expose preload through withPage.
 */
export function lazyPage<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazyRouteComponent(() => loadChunk(load), name);
}

/** Forward preload so route preloading also loads the page chunk. */
export function withPage<C extends React.ComponentType>(
  page: { preload?: () => Promise<void> | undefined },
  component: C,
): C & { preload: () => Promise<void> } {
  return Object.assign(component, {
    // lazyRouteComponent drops `preload` once the chunk has loaded.
    preload: () => page.preload?.() ?? Promise.resolve(),
  });
}
