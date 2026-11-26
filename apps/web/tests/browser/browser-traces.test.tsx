import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  FAKE_BROWSER_TRACE,
  FAKE_REQUEST_TRACE_ID,
  FAKE_TRACE_ID,
  fakeSpan,
  fakeTrace,
  fakeTracedBrowserError,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * Browser errors linked to traces, and a trace's browser part
 * (docs/telemetry.md, "The browser and the server").
 */

const TYPE_ERROR = `/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`;
const TRACE = `/projects/${PROJECT.id}/traces/${FAKE_TRACE_ID}`;

const requestsTable = () =>
  page.getByRole("table", { name: "Requests before the error, oldest first" });

describe("a browser error's page", () => {
  test("links the page load's trace and each request before the error", async () => {
    installFakeApi({ error: fakeTracedBrowserError });
    renderApp(TYPE_ERROR);

    await expect.element(page.getByRole("heading", { name: "Browser" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: `Open trace ${FAKE_TRACE_ID}` }))
      .toHaveAttribute("href", expect.stringContaining(`/traces/${FAKE_TRACE_ID}?`));
    const rows = [...requestsTable().element().querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["GET", "/api/cart", "200", "84 ms", "1f0e4d2c3b5a69788796a5b4c3d2e1f0"],
      ["POST", "/api/cart/items", "201", "132 ms", "2a3b4c5d6e7f80919a8b7c6d5e4f3a2b"],
      ["POST", "/api/orders/5120/charge", "502", "1,840 ms", FAKE_REQUEST_TRACE_ID],
    ]);
    const link = page.getByRole("link", { name: `Open trace ${FAKE_REQUEST_TRACE_ID}` });
    await expect.element(link).toHaveAttribute("href", expect.stringContaining("at="));
    expect(link.element().getAttribute("href")).not.toContain("span=");
  });

  test("shows the trace IDs as text without monitoring", async () => {
    installFakeApi({
      error: fakeTracedBrowserError,
      access: memberAccess({ errors: "view" }),
    });
    renderApp(TYPE_ERROR);

    await expect.element(requestsTable()).toBeVisible();
    expect(page.getByRole("link", { name: /^Open trace/ }).elements()).toEqual([]);
    await expect.element(requestsTable()).toMatchTextContent(FAKE_REQUEST_TRACE_ID);
  });

  test("has no browser part without traces", async () => {
    installFakeApi();
    renderApp(TYPE_ERROR);
    await expect.element(page.getByRole("heading", { name: "Latest occurrences" })).toBeVisible();
    expect(page.getByRole("heading", { name: "Browser" }).elements()).toEqual([]);
  });
});

describe("a trace's page", () => {
  test("shows the page load it served, its user, and the error with its replay", async () => {
    const api = installFakeApi({ browserTrace: () => FAKE_BROWSER_TRACE });
    renderApp(TRACE);

    const part = page.getByRole("heading", { name: "From the browser" });
    await expect.element(part).toBeVisible();
    // Read around the trace's start.
    expect(api.requests.find((request) => request.includes("/browser?"))).toContain(
      `at=${encodeURIComponent("2026-11-16T00:00:00.000Z")}`,
    );
    const facts = Object.fromEntries(
      [...document.querySelectorAll("dl > div")].map((item) => [
        item.querySelector("dt")?.textContent,
        item.querySelector("dd")?.textContent,
      ]),
    );
    expect(facts).toMatchObject({
      Page: "/checkout",
      Browser: "Chrome 131.0, Windows",
      Release: "1.4.2",
      User: "ada",
    });
    await expect
      .element(page.getByRole("link", { name: "ada" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/users/ada`);
    await expect
      .element(page.getByRole("link", { name: /^TypeError/ }))
      .toHaveAttribute("href", expect.stringContaining(`/errors/${ERROR_FINGERPRINTS.typeError}`));
    await expect
      .element(page.getByRole("link", { name: "Play replay" }))
      .toHaveAttribute("href", expect.stringContaining("/replays/"));
  });

  test("a server span under the browser's request is a root", async () => {
    installFakeApi({
      trace: (traceId) => {
        const trace = fakeTrace(FAKE_TRACE_ID);
        return {
          ...trace,
          traceId,
          spans: trace.spans.map((span, index) =>
            index === 0 ? { ...span, parentSpanId: traceId.slice(0, 16) } : span,
          ),
        };
      },
      span: (traceId, spanId) => {
        const span = fakeSpan(FAKE_TRACE_ID, spanId);
        return span instanceof Response
          ? span
          : { ...span, traceId, parentSpanId: traceId.slice(0, 16) };
      },
    });
    renderApp(`/projects/${PROJECT.id}/traces/${FAKE_REQUEST_TRACE_ID}`);

    await expect
      .element(page.getByRole("button", { name: "Top level: POST /orders/{id}/charge" }))
      .toBeVisible();
    await expect
      .element(page.getByText("The browser's request, which sends no span"))
      .toBeVisible();
  });

  test("without a browser event, or without the areas, shows only what it may", async () => {
    installFakeApi();
    renderApp(TRACE);
    await expect.element(page.getByRole("heading", { name: "Waterfall" })).toBeVisible();
    expect(page.getByRole("heading", { name: "From the browser" }).elements()).toEqual([]);
  });

  test("leaves out the user's link and the errors without their areas", async () => {
    installFakeApi({
      access: memberAccess({ monitoring: "view" }),
      browserTrace: () => ({
        ...FAKE_BROWSER_TRACE,
        errorsHidden: true,
        usersHidden: true,
        pageLoad: FAKE_BROWSER_TRACE.pageLoad && { ...FAKE_BROWSER_TRACE.pageLoad, userId: null },
        errors: [],
      }),
    });
    renderApp(TRACE);

    await expect.element(page.getByRole("heading", { name: "From the browser" })).toBeVisible();
    expect(page.getByText("User", { exact: true }).elements()).toEqual([]);
    expect(page.getByRole("link", { name: /^TypeError/ }).elements()).toEqual([]);
  });
});
