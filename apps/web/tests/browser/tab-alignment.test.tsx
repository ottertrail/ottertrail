import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/** Where the text of an element starts on screen: its first glyph, not its box. */
function textLeft(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect().left;
}

/** Where the content of a row starts: inside its padding, at the page's gutter. */
function contentLeft(element: Element): number {
  return element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft);
}

test.each([
  ["the instance's settings", "/settings", "General"],
  ["a project's settings", `/projects/${PROJECT.id}/settings`, "Install"],
])(
  "%s: the first tab's label starts at the page's gutter, as the content does",
  async (_, path, first) => {
    installFakeApi();
    renderApp(path);
    const tab = page.getByRole("tab", { name: first });
    await expect.element(tab).toBeVisible();
    const row = tab.element().closest("[role=tablist]")?.parentElement;
    const panel = page.getByRole("tabpanel").element();
    expect(row).toBeTruthy();
    expect(Math.abs(textLeft(tab.element()) - contentLeft(row as Element))).toBeLessThanOrEqual(1);
    expect(Math.abs(textLeft(tab.element()) - contentLeft(panel))).toBeLessThanOrEqual(1);
  },
);

test("product analytics: the first report link's label starts at the page's gutter", async () => {
  installFakeApi();
  renderApp(`/projects/${PROJECT.id}/product/events`);
  const nav = page.getByRole("navigation", { name: "Product analytics reports" });
  const link = nav.getByRole("link", { name: "Events" });
  await expect.element(link).toBeVisible();
  expect(Math.abs(textLeft(link.element()) - contentLeft(nav.element()))).toBeLessThanOrEqual(1);
});
