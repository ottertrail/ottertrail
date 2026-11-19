import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  analyticsFixture,
  type FakeApi,
  installFakeApi,
  OTHER_PROJECT,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The query of the page's latest request to `path`, such as { from: "…", to: "…" }. */
function lastQuery(api: FakeApi, path = "/analytics?"): Record<string, string> {
  const request = api.requests.findLast((item) => item.includes(path)) ?? "";
  return Object.fromEntries(new URLSearchParams(request.slice(request.indexOf("?") + 1)));
}
const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;

/** Opens the dialog from the period picker. */
async function openDialog() {
  await page.getByRole("combobox", { name: "Period" }).click();
  await page.getByRole("option", { name: "Custom range…" }).click();
  await expect.element(page.getByRole("dialog", { name: "Custom range" })).toBeVisible();
}

/** Types into a day field from the keyboard, as a person would: digits only. */
async function typeDay(label: string, keys: string) {
  const field = page.getByLabelText(label);
  await field.clear();
  await userEvent.type(field, keys);
}

/** A day of the calendar by its spoken name, such as "1 October 2026". */
const calendarDay = (day: string) => page.getByRole("button", { name: new RegExp(`, ${day}`) });

describe("a custom range", () => {
  test("is read from the address and sent instead of a period", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?from=2026-10-01&to=2026-10-31&country=DE`);

    await expect
      .poll(() => lastQuery(api))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", country: "DE" });
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Custom range/);
  });

  test("is chosen in a dialog that starts from the page's days, and keeps the filters", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE`);
    await expect.element(page.getByText("10 to 16 Nov 2026", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Asia/Singapore", { exact: true })).toBeVisible();

    await openDialog();

    // Day first, as the dashboard writes days.
    await expect.element(page.getByLabelText("First day")).toHaveValue("10/11/2026");
    await expect.element(page.getByLabelText("Last day")).toHaveValue("16/11/2026");
    // The mask adds the slashes.
    await typeDay("First day", "01102026");
    await typeDay("Last day", "31102026");
    await expect.element(page.getByLabelText("First day")).toHaveValue("01/10/2026");
    await page.getByRole("button", { name: "Show these days" }).click();

    await expect
      .poll(() => addressQuery(router))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", country: "DE" });
    await expect
      .poll(() => lastQuery(api))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", country: "DE" });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  test("picks the first and last day in the calendar", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);
    await openDialog();

    // The calendar opens on the month the range ends in.
    await expect.element(page.getByRole("grid", { name: "November 2026" })).toBeVisible();
    await page.getByRole("button", { name: "Go to the Previous Month" }).click();
    await calendarDay("1 October 2026").click();
    // A new range: the first day, and no last day until the next click.
    await expect.element(page.getByLabelText("First day")).toHaveValue("01/10/2026");
    await expect.element(page.getByLabelText("Last day")).toHaveValue("");
    await expect.element(page.getByRole("button", { name: "Show these days" })).toBeDisabled();
    await calendarDay("31 October 2026").click();
    await expect.element(page.getByLabelText("Last day")).toHaveValue("31/10/2026");
    await page.getByRole("button", { name: "Show these days" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    await expect.poll(() => lastQuery(api)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  test("a typed day moves the calendar to it", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await openDialog();

    await typeDay("First day", "01032026");

    await expect.element(page.getByRole("grid", { name: "March 2026" })).toBeVisible();
  });

  test("Backspace after a slash deletes the digit before it", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await openDialog();
    await typeDay("First day", "0811");
    const input = document.querySelector<HTMLInputElement>("#range-from");
    // The cursor just after the slash: "08/|11".
    input?.setSelectionRange(3, 3);

    await userEvent.keyboard("{Backspace}");

    await expect.element(page.getByLabelText("First day")).toHaveValue("01/1");
  });

  test("Delete before a slash deletes the digit after it", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await openDialog();
    await typeDay("First day", "0811");
    const input = document.querySelector<HTMLInputElement>("#range-from");
    // The cursor just before the slash: "08|/11".
    input?.setSelectionRange(2, 2);

    await userEvent.keyboard("{Delete}");

    await expect.element(page.getByLabelText("First day")).toHaveValue("08/1");
  });

  test("takes only digits, and refuses days the API would refuse", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await openDialog();
    const apply = page.getByRole("button", { name: "Show these days" });

    await typeDay("First day", "ab/1x6");
    await expect.element(page.getByLabelText("First day")).toHaveValue("16");
    // Half typed is not an error yet.
    expect(document.querySelector("[data-slot=field-error]")).toBeNull();
    await expect.element(apply).toBeDisabled();

    await typeDay("First day", "31022026");
    await expect
      .element(page.getByText("Enter the first day as DD/MM/YYYY, a real day."))
      .toBeVisible();
    await expect.element(page.getByLabelText("First day")).toHaveAttribute("aria-invalid", "true");

    await typeDay("First day", "16112026");
    await typeDay("Last day", "01112026");
    await expect.element(page.getByText("The last day is before the first.")).toBeVisible();
    await expect.element(apply).toBeDisabled();

    await typeDay("First day", "01012025");
    await typeDay("Last day", "16112026");
    await expect.element(page.getByText("A range covers at most 366 days.")).toBeVisible();
    await expect.element(apply).toBeDisabled();
  });

  test("Cancel keeps the period", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?period=30d`);
    await openDialog();

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(addressQuery(router)).toEqual({ period: "30d" });
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Last 30 days/);
  });

  test("a preset period replaces it", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?from=2026-10-01&to=2026-10-31`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 90 days" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ period: "90d" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "90d" });
  });

  test("days the API would refuse in the address fall back to the last 7 days", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?from=2026-02-30&to=2026-03-05`);

    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Last 7 days/);
  });

  test("Show all and the project switcher keep it", async () => {
    const api = installFakeApi({
      projects: [PROJECT, OTHER_PROJECT],
      analytics: () =>
        analyticsFixture({
          pages: Array.from({ length: 10 }, (_, i) => ({
            path: `/page-${i + 1}`,
            pageviews: 90 - i,
            visitors: 50 - i,
            avgEngagedMs: null,
          })),
        }),
    });
    const router = renderApp(`${ANALYTICS}?from=2026-10-01&to=2026-10-31`);

    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect
      .poll(() => lastQuery(api, "/analytics/list?"))
      .toMatchObject({ from: "2026-10-01", to: "2026-10-31", report: "pages" });
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Project: Main site. Switch project" }).click();
    await page.getByRole("menuitem", { name: "Docs" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(router.state.location.pathname).toBe(`/projects/${OTHER_PROJECT.id}/web-analytics`);
  });
});
