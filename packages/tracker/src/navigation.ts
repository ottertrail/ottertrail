/** The parts of `window` that navigation tracking uses; tests pass a fake. */
export interface NavigationWindow {
  location: { pathname: string };
  history: Pick<History, "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
}

/**
 * Calls `onNewPath` whenever the page's path changes without a page load.
 *
 * Single-page apps (React Router, Next.js, Vue Router) change the URL with
 * history.pushState and replaceState, and the back button fires popstate;
 * the browser never loads a new page. These are wrapped so each path
 * change becomes a pageview. A change to only the query string or the
 * fragment is not a new page.
 */
export function watchNavigation(win: NavigationWindow, onNewPath: () => void): void {
  let lastPath = win.location.pathname;

  const check = () => {
    try {
      const path = win.location.pathname;
      if (path !== lastPath) {
        lastPath = path;
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
}
