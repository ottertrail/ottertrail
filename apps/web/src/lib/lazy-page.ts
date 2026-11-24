import { lazyRouteComponent } from "@tanstack/react-router";
import type * as React from "react";

/**
 * Deploys can remove chunks requested by older tabs, and browser extensions such as ad blockers
 * can cancel them. Browsers cache failed imports, so recovery requires reload. A custom message
 * prevents TanStack Router's automatic reload, letting the user choose when to reload
 * (docs/dashboard.md, "Code splitting").
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

/** Why a page's code did not download (whyNotDownloaded). */
export type DownloadFailure = "updated" | "blocked" | "unknown";

/**
 * Why a page's code did not download, by asking for its file again. "updated": the server no
 * longer has it (404), as after a deploy. "blocked": the second request fails too, as when a browser
 * extension such as an ad blocker cancels it, or the browser is offline. "unknown": the file is
 * there now, or the browser's message names no file (Safari's doesn't).
 */
export async function whyNotDownloaded(error: PageLoadError): Promise<DownloadFailure> {
  const named = failedDownload(error)?.message.match(
    /(?:https?:\/\/[^\s'"]+)?\/assets\/[^\s'"]+/,
  )?.[0];
  if (named === undefined) return "unknown";
  // Only this server's files: the path, not whatever host the message names.
  const path = new URL(named, window.location.origin).pathname;
  try {
    const response = await fetch(path, { method: "HEAD", cache: "no-store" });
    return response.status === 404 ? "updated" : "unknown";
  } catch {
    return "blocked";
  }
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
