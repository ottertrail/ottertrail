import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  type FakeApi,
  fakeErrors,
  fakeServerError,
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

/**
 * The rows of the errors list, as their cells' text; the first cell as the
 * error's name and its status badge, without the times under them.
 */
const listedRows = () => {
  const list = [...document.querySelectorAll("table")].find(
    (table) => table.caption?.textContent === "Errors, most recently seen first",
  );
  return [...(list?.querySelectorAll("tbody tr") ?? [])].map((row) =>
    [...row.querySelectorAll("td")].map((cell, index) =>
      index === 0
        ? `${cell.querySelector("a")?.textContent ?? ""}${cell.querySelector("[data-slot=status-badge]")?.textContent ?? ""}`
        : cell.textContent,
    ),
  );
};

/** The errors list, beside the selected error. */
const errorList = () => page.getByRole("region", { name: "Errors, list" });

/** A status in the filter bar's toggle group. */
const statusButton = (name: string) =>
  page.getByRole("group", { name: "Status" }).getByRole("button", { name, exact: true });

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
    ]);
    // When it was last and first seen sit under its name.
    const meta = document.querySelector("tbody tr td p")?.textContent ?? "";
    expect(meta).toMatch(/^Last seen (.+ ago|yesterday|just now)First seen 20 Oct 2026$/);
    expect(regressed?.[0]).toBe("ReferenceError: process is not definedRegressed");
    await expect.element(statusButton("Unresolved")).toHaveAttribute("aria-pressed", "true");
    await expect.element(sidebarErrors()).toHaveAttribute("data-active");
  });

  test("switches status, and sends it", async () => {
    const api = installFakeApi();
    const router = renderApp(ERRORS);
    await expect.poll(() => listedRows().length).toBe(2);

    await statusButton("Resolved").click();
    await expect.poll(() => router.state.location.search).toEqual({ status: "resolved" });
    await expect
      .poll(() => lastQuery(api, "/errors"))
      .toEqual({ period: "7d", status: "resolved" });
    await expect
      .poll(() => listedRows().map((row) => row[0]))
      .toEqual(["Error: Network request failedResolved"]);

    await statusButton("All").click();
    await expect.poll(() => listedRows().length).toBe(3);
    expect(lastQuery(api, "/errors")).toEqual({ period: "7d", status: "all" });

    await statusButton("Unresolved").click();
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
    // The row's link is the error's own page, with the period and environment.
    await expect
      .element(errorList().getByRole("link", { name: /^TypeError/ }))
      .toHaveAttribute("href", `${TYPE_ERROR}?period=30d&env=staging`);
    // A click selects it beside the list, for the same days and environment.
    await errorList()
      .getByRole("link", { name: /^TypeError/ })
      .click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", env: "staging", error: ERROR_FINGERPRINTS.typeError });
    await expect
      .poll(() => lastQuery(api, `/errors/${ERROR_FINGERPRINTS.typeError}`))
      .toEqual({ period: "30d", environment: "staging" });
    await page.getByRole("link", { name: "Open the error's page" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(TYPE_ERROR);
    expect(router.state.location.search).toEqual({ period: "30d", env: "staging" });
  });

  test("says how errors are reported while there are none", async () => {
    installFakeApi({ errors: (query, api) => ({ ...fakeErrors(query, api), groups: [] }) });
    renderApp(ERRORS);

    await expect.element(page.getByText("No unresolved errors in this period")).toBeVisible();
    await expect.element(page.getByText(/data-errors="off"/)).toBeVisible();
    await expect
      .element(page.getByText("window.ottertrail.captureError(error)", { exact: true }))
      .toBeVisible();

    await statusButton("Resolved").click();
    await expect.element(page.getByText("No resolved errors in this period")).toBeVisible();
    await statusButton("All").click();
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
    // A row that stacks on a phone carries its figure's label, "Occurrences", before it.
    await expect
      .element(pages)
      .toMatchTextContent(/\/checkout(Occurrences)?900\(unknown\)(Occurrences)?334/);
    await expect
      .element(page.getByRole("table", { name: "Releases, most occurrences first" }))
      .toMatchTextContent(/1\.4\.2(Occurrences)?1,200\(unknown\)(Occurrences)?34/);
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
      ["16 Nov 2026, 16:00", "ada", "/checkout", "Chrome 131.0", "Windows", "1.4.2", "No replay"],
      [
        "16 Nov 2026, 15:00Caught",
        "Anonymous",
        "/checkout",
        "Firefox 132.0",
        "Linux",
        "(unknown)",
        "No replay",
      ],
    ]);
  });

  test("shows a server's exception: its service and trace, its routes, and its stack unmapped", async () => {
    installFakeApi({ error: fakeServerError });
    renderApp(TYPE_ERROR);

    await expect.element(page.getByRole("heading", { name: "Server" })).toBeVisible();
    const server = Object.fromEntries(
      [...document.querySelectorAll("dl > div")].map((item) => [
        item.querySelector("dt")?.textContent,
        item.querySelector("dd")?.textContent,
      ]),
    );
    expect(server).toMatchObject({
      Service: "payments",
      "Trace ID": "4bf92f3577b34da6a3ce929d0e0e4736",
      "Span ID": "00f067aa0ba902b7",
    });
    // The trace ID opens the trace's page (tests/browser/telemetry.test.tsx).
    await expect
      .element(
        page.getByRole("link", { name: "Open trace 4bf92f3577b34da6a3ce929d0e0e4736" }).first(),
      )
      .toHaveAttribute("href", expect.stringContaining("/traces/4bf92f3577b34da6a3ce929d0e0e4736"));

    // Where it happens: routes and services, not browsers.
    await expect
      .element(page.getByRole("table", { name: "Routes, most occurrences first" }))
      .toMatchTextContent(/\/orders\/\{id\}\/charge(Occurrences)?1,234/);
    await expect
      .element(page.getByRole("table", { name: "Services, most occurrences first" }))
      .toMatchTextContent(/payments(Occurrences)?1,234/);
    expect(
      page.getByRole("table", { name: "Browsers, most occurrences first" }).elements(),
    ).toEqual([]);

    // The stack as sent, with no source maps.
    await expect.element(page.getByText(/Source maps apply to browser code/)).toBeVisible();
    await expect.element(page.getByText(/payments\.gateway\.CardDeclined/)).toBeVisible();
    expect(page.getByRole("list", { name: "Frames, top first" }).elements()).toEqual([]);

    const occurrences = page.getByRole("table", { name: "Latest occurrences, newest first" });
    const headings = [...occurrences.element().querySelectorAll("thead th")].map(
      (cell) => cell.textContent,
    );
    expect(headings).toEqual(["Time", "User", "Route", "Service", "Trace", "Release", "Replay"]);
    const [first] = [...occurrences.element().querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(first).toEqual([
      "16 Nov 2026, 16:00",
      "ada",
      "/orders/{id}/charge",
      "payments",
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "1.4.2",
      "No replay",
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
