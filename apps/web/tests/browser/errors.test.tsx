import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  type FakeApi,
  fakeErrors,
  installFakeApi,
  json,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ERRORS = `/projects/${PROJECT.id}/errors`;
const TYPE_ERROR = `${ERRORS}/${ERROR_FINGERPRINTS.typeError}`;

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** The rows of the errors table, as their cells' text. */
const listedRows = () =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent),
  );

/** The link to the user in the occurrences table. */
const occurrenceUserLink = () =>
  page.getByRole("table", { name: "Latest occurrences, newest first" }).getByRole("link", {
    name: "ada",
  });

/** The Errors link in the project's menu. */
const sidebarErrors = () =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Errors" });

describe("the errors page", () => {
  test("opens from the sidebar and lists unresolved errors with their counts", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/web-analytics`);

    await page.getByRole("link", { name: "Errors" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(ERRORS);
    await expect.poll(() => listedRows().length).toBe(2);
    expect(lastQuery(api, "/errors")).toEqual({ period: "7d" });
    const [typeError, regressed] = listedRows();
    expect(typeError).toEqual([
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "1,234",
      "3",
      "17",
      expect.stringMatching(/ago|yesterday|just now/),
      "20 Oct 2026",
    ]);
    expect(regressed?.[0]).toBe("ReferenceError: process is not definedRegressed");
    await expect
      .element(page.getByRole("tab", { name: "Unresolved" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(sidebarErrors()).toHaveAttribute("data-active");
  });

  test("switches status, and sends it", async () => {
    const api = installFakeApi();
    const router = renderApp(ERRORS);
    await expect.poll(() => listedRows().length).toBe(2);

    await page.getByRole("tab", { name: "Resolved" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ status: "resolved" });
    await expect
      .poll(() => lastQuery(api, "/errors"))
      .toEqual({ period: "7d", status: "resolved" });
    await expect
      .poll(() => listedRows().map((row) => row[0]))
      .toEqual(["Error: Network request failedResolved"]);

    await page.getByRole("tab", { name: "All" }).click();
    await expect.poll(() => listedRows().length).toBe(3);
    expect(lastQuery(api, "/errors")).toEqual({ period: "7d", status: "all" });

    await page.getByRole("tab", { name: "Unresolved" }).click();
    await expect.poll(() => router.state.location.search).toEqual({});
  });

  test("shows one environment, and keeps it and the period in the links to errors", async () => {
    const api = installFakeApi({
      errors: (query, fake) => ({
        ...fakeErrors(query, fake),
        environments: ["production", "staging"],
      }),
    });
    const router = renderApp(`${ERRORS}?period=30d`);
    await expect.poll(() => listedRows().length).toBe(2);

    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: "staging" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", env: "staging" });
    await expect
      .poll(() => lastQuery(api, "/errors"))
      .toEqual({ period: "30d", environment: "staging" });
    await page.getByRole("link", { name: /^TypeError/ }).click();
    await expect.poll(() => router.state.location.pathname).toBe(TYPE_ERROR);
    expect(router.state.location.search).toEqual({ period: "30d", env: "staging" });
    await expect
      .poll(() => lastQuery(api, `/errors/${ERROR_FINGERPRINTS.typeError}`))
      .toEqual({ period: "30d", environment: "staging" });
  });

  test("says how errors are reported while there are none", async () => {
    installFakeApi({ errors: (query, api) => ({ ...fakeErrors(query, api), groups: [] }) });
    renderApp(ERRORS);

    await expect.element(page.getByText("No unresolved errors in this period")).toBeVisible();
    await expect.element(page.getByText(/data-errors="off"/)).toBeVisible();
    await expect
      .element(page.getByText("window.ottertrail.captureError(error)", { exact: true }))
      .toBeVisible();

    await page.getByRole("tab", { name: "Resolved" }).click();
    await expect.element(page.getByText("No resolved errors in this period")).toBeVisible();
    await page.getByRole("tab", { name: "All" }).click();
    await expect.element(page.getByText("No errors in this period")).toBeVisible();
  });

  test("says when the list is cut short", async () => {
    installFakeApi({
      errors: (query, api) => ({ ...fakeErrors(query, api), truncated: true }),
    });
    renderApp(ERRORS);

    await expect.element(page.getByText("More than 1,000 errors in this period")).toBeVisible();
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      errors: () => json({ error: "not_found", message: "No project has this ID." }, 404),
    });
    renderApp(ERRORS);

    await expect.element(page.getByText("No such project")).toBeVisible();
  });
});

describe("an error's page", () => {
  test("shows its numbers, where it happens, its stack, and its latest occurrences", async () => {
    installFakeApi();
    renderApp(TYPE_ERROR);

    await expect.element(page.getByRole("heading", { name: "TypeError" })).toBeVisible();
    // The detail keeps Errors active in the sidebar.
    await expect.element(sidebarErrors()).toHaveAttribute("data-active");
    await expect
      .element(
        page.getByText("Cannot read properties of undefined (reading 'id')", { exact: true }),
      )
      .toBeVisible();
    await expect.element(page.getByText("Unresolved", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Resolve" })).toBeVisible();

    const stats = Object.fromEntries(
      [...document.querySelectorAll("dl > div")].map((item) => [
        item.querySelector("dt")?.textContent,
        item.querySelector("dd")?.textContent,
      ]),
    );
    expect(stats).toEqual({
      Occurrences: "1,234",
      Users: "3",
      Visitors: "17",
      "First seen": "20 Oct 2026, 10:00",
      "Last seen": "16 Nov 2026, 16:00",
    });

    await expect.element(page.getByRole("slider", { name: "Occurrences per day" })).toBeVisible();
    await page.getByRole("button", { name: "Show the numbers" }).click();
    await expect
      .element(page.getByRole("table", { name: "Occurrences per day" }))
      .toMatchTextContent(/Sun 15 Nov400/);

    const pages = page.getByRole("table", { name: "Pages, most occurrences first" });
    await expect.element(pages).toMatchTextContent(/\/checkout900\(unknown\)334/);
    await expect
      .element(page.getByRole("table", { name: "Releases, most occurrences first" }))
      .toMatchTextContent(/1\.4\.21,200\(unknown\)34/);
    await expect
      .element(page.getByRole("table", { name: "Browsers, most occurrences first" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("table", { name: "Operating systems, most occurrences first" }))
      .toBeVisible();

    // The stack, mapped with its release's source maps: source-maps.test.tsx covers it.
    await expect
      .element(page.getByText(/^Mapped to your original files with the source maps of release/))
      .toBeVisible();
    await expect.element(page.getByRole("list", { name: "Frames, top first" })).toBeVisible();

    const occurrences = page.getByRole("table", { name: "Latest occurrences, newest first" });
    const rows = [...occurrences.element().querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["16 Nov 2026, 16:00", "ada", "/checkout", "Chrome 131.0", "Windows", "1.4.2"],
      ["16 Nov 2026, 15:00Caught", "Anonymous", "/checkout", "Firefox 132.0", "Linux", "(unknown)"],
    ]);
  });

  test("links an occurrence to its user, in the same environment", async () => {
    installFakeApi();
    const router = renderApp(`${TYPE_ERROR}?env=staging`);

    await occurrenceUserLink().click();

    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/users/ada`);
    expect(router.state.location.search).toEqual({ env: "staging" });
  });

  test("says when the browser gave no stack", async () => {
    installFakeApi();
    renderApp(`${ERRORS}/${ERROR_FINGERPRINTS.referenceError}`);

    await expect
      .element(page.getByText("The browser gave no stack trace for this error."))
      .toBeVisible();
    await expect.element(page.getByText("Regressed", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(/Regressed: seen again after it was resolved by Test Owner/))
      .toBeVisible();
  });

  test("Resolve marks it resolved, and Reopen opens it again", async () => {
    const api = installFakeApi();
    renderApp(TYPE_ERROR);

    await page.getByRole("button", { name: "Resolve" }).click();

    await expect.element(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    expect(api.bodies).toEqual([
      {
        method: "PATCH",
        path: `/api/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`,
        body: { status: "resolved" },
      },
    ]);
    await expect.element(page.getByText("Resolved", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/^Resolved by Test Owner, /)).toBeVisible();

    await page.getByRole("button", { name: "Reopen" }).click();

    await expect.element(page.getByRole("button", { name: "Resolve" })).toBeVisible();
    expect(api.bodies.at(-1)?.body).toEqual({ status: "unresolved" });
  });

  test("the list shows a group resolved on its page", async () => {
    installFakeApi();
    const router = renderApp(TYPE_ERROR);

    await page.getByRole("button", { name: "Resolve" }).click();
    await expect.element(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await page.getByRole("link", { name: "All errors" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(ERRORS);
    await expect
      .poll(() => listedRows().map((row) => row[0]))
      .toEqual(["ReferenceError: process is not definedRegressed"]);
  });

  test("says when resolving fails", async () => {
    installFakeApi({
      setErrorStatus: () => json({ error: "internal", message: "The database is down." }, 500),
    });
    renderApp(TYPE_ERROR);

    await page.getByRole("button", { name: "Resolve" }).click();

    await expect.element(page.getByText("The error could not be resolved")).toBeVisible();
    await expect.element(page.getByText("The database is down.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Resolve" })).toBeEnabled();
  });

  test("says when it has no occurrence in the period", async () => {
    installFakeApi();
    const router = renderApp(`${ERRORS}/9-0123456789abcdef0123?period=30d`);

    await expect.element(page.getByText("No occurrence in this period")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Show the last 12 months" })).toBeVisible();
    await page.getByRole("link", { name: "All errors" }).last().click();
    await expect.poll(() => router.state.location.pathname).toBe(ERRORS);
    expect(router.state.location.search).toEqual({ period: "30d" });
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      error: () => json({ error: "not_found", message: "No project has this ID." }, 404),
    });
    renderApp(TYPE_ERROR);

    await expect.element(page.getByText("No such project")).toBeVisible();
  });
});
