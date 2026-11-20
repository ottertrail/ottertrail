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

test("members: the first tab's label lines up with the table's first column", async () => {
  installFakeApi();
  renderApp("/settings/members");
  const tab = page.getByRole("tab", { name: /^Members/ });
  await expect.element(tab).toBeVisible();
  const header = page.getByRole("columnheader", { name: "Name" });
  await expect.element(header).toBeVisible();
  const label = tab.element().firstChild as Node;
  const range = document.createRange();
  range.selectNodeContents(label);
  expect(
    Math.abs(range.getBoundingClientRect().left - textLeft(header.element())),
  ).toBeLessThanOrEqual(1);
});

/** The nearest ancestor that scrolls sideways: the tab row. */
function scrollingRow(element: Element): HTMLElement | null {
  let node = element.parentElement;
  while (node !== null && getComputedStyle(node).overflowX !== "auto") node = node.parentElement;
  return node;
}

test.each([
  ["the instance's settings", "/settings", "General"],
  ["a project's settings", `/projects/${PROJECT.id}/settings`, "Install"],
  ["account settings", "/account", "Profile"],
  ["members", "/settings/members", /^Members/],
])(
  "%s: the tabs fit their row, which never scrolls up and down, and the underline sits on its edge",
  async (_, path, first) => {
    installFakeApi();
    renderApp(path);
    const tab = page.getByRole("tab", { name: first });
    await expect.element(tab).toBeVisible();
    const row = scrollingRow(tab.element());
    expect(row).not.toBeNull();
    const scroller = row as HTMLElement;
    // Scrolling up and down by a few pixels shows a scrollbar on macOS and cuts the labels.
    expect(scroller.scrollHeight).toBe(scroller.clientHeight);
    const list = tab.element().closest("[role=tablist]")?.getBoundingClientRect();
    const box = tab.element().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(list?.top ?? Number.NaN);
    expect(box.bottom).toBeLessThanOrEqual(list?.bottom ?? Number.NaN);
    const underline = getComputedStyle(tab.element(), "::after");
    expect(underline.bottom).toBe("0px");
  },
);
