import { describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, json, OTHER_PROJECT, PROJECT } from "./fake-api.ts";
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

describe("the danger zone", () => {
  test("replacing the key asks first, then shows the new snippet", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    await expect.element(page.getByText("pk_test", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Replace public key" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Replace the public key?" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Replace key" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("pk_replaced", { exact: true })).toBeVisible();
    expect(api.requests).toContain(`/api/projects/${PROJECT.id}/public-key`);
  });

  test("Cancel replaces nothing", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);

    await page.getByRole("button", { name: "Replace public key" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(api.requests).not.toContain(`/api/projects/${PROJECT.id}/public-key`);
    await expect.element(page.getByText("pk_test", { exact: true })).toBeVisible();
  });

  test("deleting asks for the project's name, then opens the project list without it", async () => {
    const api = installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    window.localStorage.setItem("ottertrail.project", PROJECT.id);
    const router = renderApp(SETTINGS);

    await page.getByRole("button", { name: "Delete project" }).click();
    const confirm = page.getByRole("button", { name: "Delete for good" });
    await expect.element(confirm).toBeDisabled();
    await page.getByLabelText("Type the project's name to confirm").fill("main site");
    await expect.element(confirm).toBeDisabled();
    await page.getByLabelText("Type the project's name to confirm").fill("Main site");
    await confirm.click();

    await expect.poll(() => router.state.location.pathname).toBe("/projects");
    expect(api.bodies).toContainEqual({
      method: "DELETE",
      path: `/api/projects/${PROJECT.id}`,
      body: { confirmName: "Main site" },
    });
    await expect.element(page.getByRole("link", { name: "Docs" })).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Main site" })).not.toBeInTheDocument();
    // The home page no longer tries to open it.
    expect(window.localStorage.getItem("ottertrail.project")).toBeNull();
  });

  test("a delete the API refuses says why and stays on the page", async () => {
    installFakeApi({
      deleteProject: () =>
        json(
          { error: "name_mismatch", message: "Type the project's name exactly to delete it." },
          400,
        ),
    });
    const router = renderApp(SETTINGS);

    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByLabelText("Type the project's name to confirm").fill("Main site");
    await page.getByRole("button", { name: "Delete for good" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Type the project's name exactly to delete it.");
    expect(router.state.location.pathname).toBe(SETTINGS);
  });
});

describe("keeping events", () => {
  test("keeps them forever by default; a limit warns before saving, then is saved", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    const keep = page.getByRole("combobox", { name: "Keep events" });
    await expect.element(keep).toMatchTextContent(/^Forever/);
    await expect
      .element(
        page.getByText(
          "Older events are deleted for good, a whole day at a time. Forever keeps everything.",
        ),
      )
      .toBeVisible();

    await keep.click();
    await page.getByRole("option", { name: "1 year" }).click();
    await expect
      .element(
        page.getByText(
          "Events older than 1 year will be deleted for good within a few hours of saving, a whole day at a time.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(() => api.bodies.at(-1))
      .toMatchObject({
        method: "PATCH",
        path: `/api/projects/${PROJECT.id}`,
        body: { retentionDays: 365 },
      });
    await expect.element(page.getByText("Saved.")).toBeVisible();
  });

  test("a longer limit than now does not warn", async () => {
    installFakeApi({ projects: [{ ...PROJECT, retentionDays: 365 }] });
    renderApp(SETTINGS);

    await page.getByRole("combobox", { name: "Keep events" }).click();
    await page.getByRole("option", { name: "2 years" }).click();

    await expect
      .element(page.getByText(/will be deleted for good within a few hours/))
      .not.toBeInTheDocument();
  });

  test("a limit set some other way shows in days", async () => {
    installFakeApi({ projects: [{ ...PROJECT, retentionDays: 90 }] });
    renderApp(SETTINGS);

    await expect
      .element(page.getByRole("combobox", { name: "Keep events" }))
      .toMatchTextContent(/^90 days/);
  });
});
