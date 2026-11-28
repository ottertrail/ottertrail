import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import "../../src/styles/globals.css";
import { createAppRouter } from "../../src/router.tsx";
import { ShareRoot } from "../../src/share/share-root.tsx";
import { trackMounted } from "./mounted.ts";

/** Uses real routes, redirects, and layout with in-memory history. */
export function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, retryDelayMs: 0 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  trackMounted(() => {
    root.unmount();
    container.remove();
  });
  return router;
}

/** A shared link's page (share.html's app), at `path` such as /share/<token>, with in-memory history. */
export function renderShare(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<ShareRoot history={history} retryDelayMs={0} />);
  trackMounted(() => {
    root.unmount();
    container.remove();
  });
  return history;
}

export function currentPath(router: ReturnType<typeof renderApp>): string {
  return router.state.location.href;
}
