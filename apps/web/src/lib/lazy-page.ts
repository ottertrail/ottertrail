import { lazyRouteComponent } from "@tanstack/react-router";
import type * as React from "react";

/**
 * A page's code that could not be downloaded. The usual cause is a deploy:
 * a tab opened before it asks for files the new version no longer has.
 * Browsers remember a failed module, so only reloading the page helps.
 *
 * Its own message, not the browser's ("Failed to fetch dynamically imported
 * module…"): TanStack Router reloads the page by itself, once, on the
 * browser's message; this way the page says what happened and the reader
 * chooses to reload (docs/dashboard.md, "Code splitting").
 */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("The page's code could not be downloaded.", { cause });
    this.name = "PageLoadError";
  }
}

/**
 * The messages browsers give a dynamic import whose file could not be
 * fetched (Chromium, Firefox, Safari, all TypeErrors; the same list as
 * TanStack Router's own check), and Vite's when a chunk's stylesheet
 * could not be.
 */
const FAILED_FETCH = [
  /^Failed to fetch dynamically imported module/,
  /^error loading dynamically imported module/,
  /^Importing a module script failed/,
  /^Unable to preload CSS/,
];

/**
 * The browser's error for a file that could not be downloaded, when that is
 * why an import failed; undefined when the code threw while it ran. Only
 * the browser's messages tell them apart, since a module's own bug can be a
 * TypeError too. A loader may wrap the browser's error (Vitest's module
 * mocker does), so its causes are looked at as well.
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

/**
 * Loads a module; a file that could not be downloaded becomes a
 * PageLoadError (holding the browser's error), and anything else is thrown
 * as it is.
 */
export async function loadChunk<M>(load: () => Promise<M>): Promise<M> {
  try {
    return await load();
  } catch (error) {
    const download = failedDownload(error);
    throw download === undefined ? error : new PageLoadError(download);
  }
}

/**
 * A page component loaded in its own chunk on first use, through TanStack
 * Router's `lazyRouteComponent`. Used as a route's component, or inside one
 * that `withPage` gives its `preload`, the router loads the chunk with the
 * route: on a link's hover or focus (`defaultPreload: "intent"`), or before
 * the page renders.
 */
export function lazyPage<M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazyRouteComponent(() => loadChunk(load), name);
}

/**
 * A route component that reads the route's params and search into a lazy
 * page's props: preloading the route preloads the page's chunk too.
 */
export function withPage<C extends React.ComponentType>(
  page: { preload?: () => Promise<void> | undefined },
  component: C,
): C & { preload: () => Promise<void> } {
  return Object.assign(component, {
    // lazyRouteComponent drops `preload` once the chunk has loaded.
    preload: () => page.preload?.() ?? Promise.resolve(),
  });
}
