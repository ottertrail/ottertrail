export interface NavigationWindow {
  location: { pathname: string };
  history: Pick<History, "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
}

/** Track SPA path changes as pageviews. Query and fragment changes do not count. */
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
