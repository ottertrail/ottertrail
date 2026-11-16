import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import "../../src/styles/globals.css";
import { createAppRouter } from "../../src/router.tsx";

const unmounts: (() => void)[] = [];

/**
 * Renders the whole dashboard at `path`, with an in-memory address bar, so
 * a test goes through the same routes, redirects, and layout as a visitor.
 */
export function renderApp(path: string) {
  document.documentElement.classList.add("dark");
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, retryDelayMs: 0 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  unmounts.push(() => {
    root.unmount();
    container.remove();
  });
  return router;
}

export function unmountAll() {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
}

/** The address the router shows, such as "/analytics/abc?period=30d". */
export function currentPath(router: ReturnType<typeof renderApp>): string {
  return router.state.location.href;
}
