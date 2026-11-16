import { describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const SETTINGS = `/projects/${PROJECT.id}/settings`;

/** Stands in for the clipboard, which a headless browser may refuse. */
function fakeClipboard() {
  return vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
}

describe("a project's settings", () => {
  test("shows the public key as text to copy, not as a field", async () => {
    installFakeApi();
    const writeText = fakeClipboard();
    renderApp(SETTINGS);

    await expect.element(page.getByRole("heading", { name: "Public key" })).toBeVisible();
    await expect.element(page.getByText("pk_test", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Public key" })).not.toBeInTheDocument();
    // The form holds only what Save changes stores.
    const form = document.querySelector("form");
    expect(form?.textContent).not.toContain("pk_test");

    await page.getByRole("button", { name: "Copy the public key" }).click();

    expect(writeText).toHaveBeenCalledWith("pk_test");
    await expect
      .element(page.getByRole("button", { name: "Copy the public key" }))
      .toHaveTextContent("Copied");
  });

  test("the snippet fills the card's width, with its copy button inside, and wraps", async () => {
    installFakeApi();
    const writeText = fakeClipboard();
    renderApp(SETTINGS);
    const copy = page.getByRole("button", { name: "Copy the snippet" });
    await expect.element(copy).toBeVisible();

    const box = copy.element().parentElement;
    const content = box?.closest("[data-slot=card-content]");
    const pre = box?.querySelector("pre");
    if (!box || !content || !pre) {
      throw new Error("The snippet box is missing");
    }
    const boxRect = box.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(content).paddingLeft) * 2;
    expect(Math.abs(boxRect.width - (contentRect.width - padding))).toBeLessThan(1);
    const copyRect = copy.element().getBoundingClientRect();
    expect(copyRect.right).toBeLessThanOrEqual(boxRect.right);
    expect(copyRect.top).toBeGreaterThanOrEqual(boxRect.top);
    // The whole snippet is visible: no sideways scrolling.
    expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth);

    await copy.click();

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('data-key="pk_test"'));
  });

  test("says when the browser refuses to copy", async () => {
    installFakeApi();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Not allowed"));
    renderApp(SETTINGS);

    await page.getByRole("button", { name: "Copy the snippet" }).click();

    await expect
      .element(page.getByRole("button", { name: "Copy the snippet" }))
      .toHaveTextContent("Copy failed");
  });
});
