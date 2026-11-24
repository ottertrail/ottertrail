import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The dashboard's Content Security Policy allows stylesheets only (style-src 'self'), so a <style>
 * element a component adds is blocked in production and logs an error. Base UI's select adds one
 * to hide its popup's scrollbar unless CSPProvider turns it off; globals.css has the rule instead.
 */
test("an open select adds no <style> element, and its popup still hides the scrollbar", async () => {
  installFakeApi();
  renderApp(`/projects/${PROJECT.id}/speed`);
  await page.getByRole("combobox", { name: "Device" }).click();
  await expect.element(page.getByRole("option", { name: "Mobile" })).toBeVisible();

  // React marks a <style> a component renders with data-precedence. (Vite's and the test runner's
  // own <style> elements exist only in tests.)
  const added = [...document.querySelectorAll("style[data-precedence]")].map(
    (style) => style.textContent,
  );
  expect(added).toEqual([]);
  const hidden = document.querySelector(".base-ui-disable-scrollbar");
  expect(hidden).not.toBeNull();
  expect(getComputedStyle(hidden as Element).scrollbarWidth).toBe("none");
});
