import { expect, test } from "vite-plus/test";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

test("a project page's tab names the page, the project, and the instance", async () => {
  const api = installFakeApi();
  renderApp(`/projects/${PROJECT.id}/errors`);
  await expect
    .poll(() => document.title)
    .toBe(`Errors · ${PROJECT.name} · ${api.settings.name} – Ottertrail`);
});

test("a workspace page's tab names the page and the instance", async () => {
  const api = installFakeApi();
  renderApp("/projects");
  await expect.poll(() => document.title).toBe(`Projects · ${api.settings.name} – Ottertrail`);
});
