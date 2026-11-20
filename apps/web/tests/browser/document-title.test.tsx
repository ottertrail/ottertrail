import { expect, test } from "vite-plus/test";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

test("a project page's tab names the page and the project, not the instance", async () => {
  const api = installFakeApi();
  renderApp(`/projects/${PROJECT.id}/errors`);
  await expect.poll(() => document.title).toBe(`Errors · ${PROJECT.name} – Ottertrail`);
  expect(document.title).not.toContain(api.settings.name);
});

test("a workspace page's tab names the page", async () => {
  installFakeApi();
  renderApp("/projects");
  await expect.poll(() => document.title).toBe("Projects – Ottertrail");
});
