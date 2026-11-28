import { routeOf } from "./url.ts";

export interface NavigationWindow {
  location: { pathname: string; hash: string };
  history: Pick<History, "pushState" | "replaceState">;
  addEventListener(type: "popstate" | "hashchange", listener: () => void): void;
}

/**
 * Track SPA path changes as pageviews. Query changes do not count, and
 * fragment changes count only as a new route with `hashRoutes` (routeOf).
 */
export function watchNavigation(
  win: NavigationWindow,
  onNewPath: () => void,
  hashRoutes = false,
): void {
  const page = () => win.location.pathname + (hashRoutes ? routeOf(win.location.hash) : "");
  let lastPage = page();

  const check = () => {
    try {
      const current = page();
      if (current !== lastPage) {
        lastPage = current;
        onNewPath();
      }
    } catch {
      // Never break the page's own navigation.
    }
  };

  for (const method of ["pushState", "replaceState"] as const) {
    const original = win.history[method];
    win.history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      check();
      return result;
    };
  }
  win.addEventListener("popstate", check);
  if (hashRoutes) win.addEventListener("hashchange", check);
}
