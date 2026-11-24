import { describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, json, OTHER_PROJECT, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const SETTINGS = `/projects/${PROJECT.id}/settings`;
/** The settings page opened on one tab (Install, the first, has none). */
const tab = (name: string) => `${SETTINGS}?tab=${name}`;

/** The shown tab's Save bar status: "No unsaved changes", "Unsaved changes", "Saving…". */
const saveStatus = () => page.getByRole("tabpanel").getByRole("status").first();

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
    // The section's column, which its text and code fill.
    const content = box?.closest("[data-slot=settings-section] > div");
    const pre = box?.querySelector("pre");
    if (!box || !content || !pre) {
      throw new Error("The snippet box is missing");
    }
    const boxRect = box.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    expect(Math.abs(boxRect.width - contentRect.width)).toBeLessThan(1);
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

describe("your server", () => {
  test("hides the secret key until asked, then offers to copy it", async () => {
    installFakeApi();
    renderApp(tab("server"));
    await expect.element(page.getByRole("heading", { name: "Your server" })).toBeVisible();
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);

    await page.getByRole("button", { name: "Show" }).click();

    await expect.element(page.getByText(PROJECT.secretKey, { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy the secret key" })).toBeVisible();
    await page.getByRole("button", { name: "Hide" }).click();
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);
  });

  test("turns on signed user IDs with the tab's Save", async () => {
    const api = installFakeApi();
    renderApp(tab("server"));
    const toggle = page.getByRole("switch", { name: "Only accept user IDs signed by your server" });
    await expect.element(toggle).not.toBeChecked();

    await toggle.click();

    // A field of the form now: nothing is sent until Save.
    await expect.element(toggle).toBeChecked();
    await expect.element(saveStatus()).toHaveTextContent("Unsaved changes");
    expect(api.bodies).toEqual([]);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");
    expect(api.bodies).toContainEqual({
      method: "PATCH",
      path: `/api/projects/${PROJECT.id}`,
      body: { requireSignedUserIds: true },
    });
  });

  test("replaces the secret key from the danger zone", async () => {
    const api = installFakeApi();
    renderApp(tab("danger"));

    await page.getByRole("button", { name: "Replace secret key" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Replace the secret key?" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Replace key" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(api.requests).toContain(`/api/projects/${PROJECT.id}/secret-key`);

    await page.getByRole("tab", { name: "Your server" }).click();
    await page.getByRole("button", { name: "Show" }).click();
    await expect.element(page.getByText("sk_replaced", { exact: true })).toBeVisible();
  });
});

describe("the danger zone", () => {
  test("replacing the key asks first, then shows the new snippet", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    await expect.element(page.getByText("pk_test", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Danger zone" }).click();
    await page.getByRole("button", { name: "Replace public key" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Replace the public key?" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Replace key" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("tab", { name: "Install" }).click();
    await expect.element(page.getByText("pk_replaced", { exact: true })).toBeVisible();
    expect(api.requests).toContain(`/api/projects/${PROJECT.id}/public-key`);
  });

  test("Cancel replaces nothing", async () => {
    const api = installFakeApi();
    renderApp(tab("danger"));

    await page.getByRole("button", { name: "Replace public key" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(api.requests).not.toContain(`/api/projects/${PROJECT.id}/public-key`);
    await page.getByRole("tab", { name: "Install" }).click();
    await expect.element(page.getByText("pk_test", { exact: true })).toBeVisible();
  });

  test("deleting asks for the project's name, then opens the project list without it", async () => {
    const api = installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    window.localStorage.setItem("ottertrail.project", PROJECT.id);
    const router = renderApp(tab("danger"));

    await page.getByRole("button", { name: "Delete project" }).click();
    const confirm = page.getByRole("button", { name: "Delete permanently" });
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
    await expect
      .element(page.getByRole("link", { name: "Main site", exact: true }))
      .not.toBeInTheDocument();
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
    const router = renderApp(tab("danger"));

    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByLabelText("Type the project's name to confirm").fill("Main site");
    await page.getByRole("button", { name: "Delete permanently" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Type the project's name exactly to delete it.");
    expect(router.state.location.pathname).toBe(SETTINGS);
  });
});

describe("keeping events", () => {
  test("keeps them forever by default; a limit warns before saving, then is saved", async () => {
    const api = installFakeApi();
    renderApp(tab("general"));
    const keep = page.getByRole("combobox", { name: "Keep events" });
    await expect.element(keep).toMatchTextContent(/^Forever/);
    await expect
      .element(
        page.getByText(
          "Older events are permanently deleted, one whole day at a time. Forever keeps all events.",
        ),
      )
      .toBeVisible();

    await keep.click();
    await page.getByRole("option", { name: "1 year" }).click();
    await expect
      .element(
        page.getByText(
          "Events older than 1 year will be permanently deleted within a few hours of saving, one whole day at a time.",
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
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");
  });

  test("the main goal is chosen from the project's goals, and saved", async () => {
    const api = installFakeApi();
    renderApp(tab("general"));

    const field = page.getByRole("combobox", { name: "Main goal" });
    await expect.poll(() => field.element().textContent).toContain("None: new signed-in users");
    await field.click();
    await page.getByRole("option", { name: "Saw pricing" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(() => api.bodies.at(-1))
      .toMatchObject({
        method: "PATCH",
        path: `/api/projects/${PROJECT.id}`,
        body: { mainGoalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" },
      });
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");
    await expect.poll(() => field.element().textContent).toContain("Saw pricing");
  });

  test("a longer limit than now does not warn", async () => {
    installFakeApi({ projects: [{ ...PROJECT, retentionDays: 365 }] });
    renderApp(tab("general"));

    await page.getByRole("combobox", { name: "Keep events" }).click();
    await page.getByRole("option", { name: "2 years" }).click();

    await expect
      .element(page.getByText(/will be permanently deleted within a few hours/))
      .not.toBeInTheDocument();
  });

  test("visits from data centers are ignored until turned off, which is saved", async () => {
    const api = installFakeApi();
    renderApp(tab("spam"));
    const ignore = page.getByRole("checkbox", { name: "Ignore visits from data centers" });
    await expect.element(ignore).toBeChecked();

    await ignore.click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(() => api.bodies.at(-1))
      .toMatchObject({
        method: "PATCH",
        path: `/api/projects/${PROJECT.id}`,
        body: { ignoreDataCenters: false },
      });
    await expect.element(page.getByRole("tabpanel").getByText("No unsaved changes")).toBeVisible();
    await expect.element(ignore).not.toBeChecked();
  });

  test("a choice not saved on one project never carries over to another", async () => {
    // Both projects keep events forever, and the other one is cached: the
    // page switches without loading.
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp(`/projects/${OTHER_PROJECT.id}/settings?tab=general`);
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Docs");
    await router.navigate({
      to: "/projects/$projectId/settings",
      params: { projectId: PROJECT.id },
      search: { tab: "general" },
    });
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Main site");
    const keep = page.getByRole("combobox", { name: "Keep events" });
    await keep.click();
    await page.getByRole("option", { name: "1 year" }).click();
    await expect.element(keep).toMatchTextContent(/^1 year/);

    // Leaving with the edits asks first (the leave guard); leaving anyway drops them.
    void router.navigate({
      to: "/projects/$projectId/settings",
      params: { projectId: OTHER_PROJECT.id },
      search: { tab: "general" },
    });
    await page.getByRole("button", { name: "Leave and discard" }).click();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Docs");
    await expect.element(keep).toMatchTextContent(/^Forever/);
  });

  test("a limit set some other way shows in days", async () => {
    installFakeApi({ projects: [{ ...PROJECT, retentionDays: 90 }] });
    renderApp(tab("general"));

    await expect
      .element(page.getByRole("combobox", { name: "Keep events" }))
      .toMatchTextContent(/^90 days/);
  });
});

const keepTelemetry = () => page.getByRole("combobox", { name: "Keep traces, logs, and metrics" });

describe("keeping traces, logs, and metrics", () => {
  test("keeps the instance's maximum by default; fewer days warn before saving, then are saved", async () => {
    const api = installFakeApi();
    renderApp(tab("general"));
    const keep = keepTelemetry();
    await expect.element(keep).toMatchTextContent(/^30 days \(the instance's maximum\)/);
    await expect
      .element(page.getByText("Older records are permanently deleted, one whole day at a time."))
      .toBeVisible();

    await keep.click();
    // Only the days up to the instance's 30.
    const options = page.getByRole("option");
    await expect
      .poll(() => options.elements().map((option) => option.textContent))
      .toEqual(["7 days", "14 days", "30 days (the instance's maximum)"]);
    await page.getByRole("option", { name: "7 days" }).click();
    await expect
      .element(
        page.getByText(
          "Records older than 7 days will be permanently deleted within a few hours of saving.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(() => api.bodies.at(-1))
      .toMatchObject({
        method: "PATCH",
        path: `/api/projects/${PROJECT.id}`,
        body: { telemetryRetentionDays: 7 },
      });
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");
    await expect.element(keep).toMatchTextContent(/^7 days/);

    // Back to the maximum: saved as null, and it deletes nothing, so no warning.
    await keep.click();
    await page.getByRole("option", { name: "30 days (the instance's maximum)" }).click();
    await expect
      .element(page.getByText(/will be permanently deleted within a few hours/))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(() => api.bodies.at(-1))
      .toMatchObject({ body: { telemetryRetentionDays: null } });
  });

  test("a larger maximum offers more days, up to it", async () => {
    installFakeApi({ projects: [{ ...PROJECT, telemetryRetentionMaxDays: 90 }] });
    renderApp(tab("general"));

    await keepTelemetry().click();
    await expect
      .poll(() =>
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      )
      .toEqual(["7 days", "14 days", "30 days", "90 days (the instance's maximum)"]);
  });

  test("a setting above a lowered maximum shows as capped, and other changes leave it alone", async () => {
    const api = installFakeApi({
      projects: [{ ...PROJECT, telemetryRetentionDays: 90, telemetryRetentionMaxDays: 30 }],
    });
    renderApp(tab("general"));
    await expect.element(keepTelemetry()).toMatchTextContent(/^90 days \(capped at 30\)/);

    await page.getByRole("textbox", { name: "Name" }).fill("Main site, renamed");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(() => api.bodies.at(-1))
      .toMatchObject({ method: "PATCH", body: { name: "Main site, renamed" } });
    // Sending 90 again would be refused: it is above the maximum.
    expect(api.bodies.at(-1)?.body).not.toHaveProperty("telemetryRetentionDays");
  });
});
