import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  ADMIN_ACCESS,
  ingestActivityOf,
  installFakeApi,
  memberAccess,
  outcomeCounts,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The project settings' Activity tab: per source, what arrived and what
 * was refused or filtered, a sheet with each reason, and the empty state.
 */

const ACTIVITY = `/projects/${PROJECT.id}/settings?tab=activity`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const panel = () => page.getByRole("tabpanel");
const table = () => panel().getByRole("table", { name: "Requests per source" });
const sheet = () => page.getByRole("dialog");
const rowTexts = () =>
  [...table().element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent),
  );

describe("the Activity tab", () => {
  test("lists each source that sent something, and folds the rest into one line", async () => {
    installFakeApi();
    renderApp(ACTIVITY);
    await expect.element(table()).toBeVisible();
    expect([...table().element().querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
      "Source",
      "Last accepted",
      "Accepted (1 h)",
      "Accepted (24 h)",
      "Refused (24 h)",
      "Filtered (24 h)",
    ]);
    expect(rowTexts()).toEqual([
      ["Browser events", "2 minutes ago", "120", "2,480", "41", "12"],
      ["Errors", "2 minutes ago", "2", "18", "0", "0"],
      ["Traces", "3 hours ago", "60", "1,420", "6", "0"],
    ]);
    // The exact moment, in the instance's timezone, on the relative time.
    const time = table().getByText("3 hours ago").element();
    expect(time.getAttribute("title")).toMatch(/2026|\d{4}/);
    await expect
      .element(
        panel().getByText(
          "Nothing received in 7 days: Server events, Web Vitals, Session replays, Heatmaps, Logs, Metrics, AI calls, Source maps.",
        ),
      )
      .toBeVisible();
    // Counts are whole numbers in tabular figures.
    const cell = table().getByText("2,480").element();
    expect(cell.className).toContain("tabular-nums");
  });

  test("says what isn't counted, linking the owner to the Server log", async () => {
    installFakeApi();
    renderApp(ACTIVITY);
    await expect.element(panel().getByText(/Requests, counted every 15 seconds\./)).toBeVisible();
    await expect
      .element(panel().getByRole("link", { name: "Server log" }))
      .toHaveAttribute("href", "/settings?tab=server-log");
  });

  test("an admin reads where the requests show, without a link they cannot open", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(ACTIVITY);
    await expect.element(table()).toBeVisible();
    await expect.element(panel().getByText(/the owner's Server log shows it/)).toBeVisible();
    await expect.element(panel().getByRole("link", { name: "Server log" })).not.toBeInTheDocument();
  });

  test("is fetched only while it is the tab shown", async () => {
    const api = installFakeApi();
    renderApp(`/projects/${PROJECT.id}/settings?tab=general`);
    await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(api.ingestActivityRequests).toBe(0);
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect.element(table()).toBeVisible();
    expect(api.ingestActivityRequests).toBe(1);
  });
});

describe("a source's sheet", () => {
  test("gives each outcome's counts, and a line for each reason with a count", async () => {
    installFakeApi();
    const router = renderApp(ACTIVITY);
    // A click anywhere on the row opens it, as on the source's name.
    await table().getByText("2,480").click();
    await expect.element(sheet().getByRole("heading", { name: "Browser events" })).toBeVisible();
    const counts = [...sheet().element().querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(counts).toEqual([
      ["Accepted", "120", "2,480", "15,310"],
      ["Filtered: bots", "0", "12", "80"],
      ["Refused: site not allowed", "3", "41", "97"],
      ["Events stored", "480", "9,920", "61,240"],
    ]);
    await expect
      .element(
        sheet().getByText("The page's site isn't in Allowed sites. Add it on the General tab."),
      )
      .toBeVisible();
    await expect
      .element(
        sheet().getByText(
          'Sent by a bot, or by a browser at a data center\'s address, and dropped. If real visitors use cloud desktops, turn off "Ignore visits from data centers" on the Spam and bots tab.',
        ),
      )
      .toBeVisible();
    // Only reasons with a count.
    await expect.element(sheet().getByText("Refused: invalid")).not.toBeInTheDocument();

    // The link opens the General tab and closes the sheet.
    await sheet().getByRole("link", { name: "General" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ tab: "general" });
    await expect.element(sheet()).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Allowed sites" })).toBeVisible();
  });

  test("says ClickHouse could not store the data, with the Server log for the owner", async () => {
    installFakeApi();
    renderApp(ACTIVITY);
    await table().getByRole("button", { name: "Traces, details" }).click();
    await expect
      .element(sheet().getByText(/ClickHouse couldn't store the data\. Senders retry; check the/))
      .toBeVisible();
    await expect.element(sheet().getByRole("link", { name: "Server log" })).toBeVisible();
  });

  test("explains a source's own limits: replays turned off and over their storage", async () => {
    installFakeApi({
      ingestActivity: () =>
        ingestActivityOf({
          replays: {
            refused_disabled: outcomeCounts(1, 4, 9),
            refused_volume: outcomeCounts(0, 2, 2),
          },
        }),
    });
    renderApp(ACTIVITY);
    await table().getByRole("button", { name: "Session replays, details" }).click();
    await expect.element(sheet().getByText(/Session replay is off for this project/)).toBeVisible();
    await expect.element(sheet().getByRole("link", { name: "Session replay" })).toBeVisible();
    await expect.element(sheet().getByText(/The instance's replay storage is full/)).toBeVisible();
    // Nothing accepted: no last time, and no items row.
    await expect.element(sheet().getByText("Chunks stored")).not.toBeInTheDocument();
  });
});

describe("nothing in 7 days", () => {
  test("points to the Install tab and says a wrong key can't be counted", async () => {
    installFakeApi({ ingestActivity: () => ingestActivityOf({}) });
    const router = renderApp(ACTIVITY);
    await expect.element(panel().getByText("Nothing received in 7 days")).toBeVisible();
    await expect
      .element(panel().getByText(/A request with a wrong key can't be counted here\./))
      .toBeVisible();
    await expect.element(panel().getByRole("table")).not.toBeInTheDocument();
    await panel().getByRole("link", { name: "Open the Install tab" }).click();
    await expect.poll(() => router.state.location.search).toEqual({});
    await expect.element(page.getByRole("heading", { name: "Install" })).toBeVisible();
  });

  test("a failed load says so, with Retry", async () => {
    installFakeApi({
      ingestActivity: () =>
        new Response(
          JSON.stringify({ error: "internal_error", message: "Something went wrong." }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    renderApp(ACTIVITY);
    await expect.element(panel().getByText("The activity could not load")).toBeVisible();
    await expect.element(panel().getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

describe("who sees it", () => {
  test("a member cannot reach the tab", async () => {
    const api = installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(ACTIVITY);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Activity" })).not.toBeInTheDocument();
    expect(api.ingestActivityRequests).toBe(0);
  });
});

describe("the tab fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} wide, only the table scrolls sideways`, async () => {
      await page.viewport(width, height);
      installFakeApi();
      renderApp(ACTIVITY);
      await expect.element(table()).toBeVisible();
      const content = document.querySelector("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      // The source's name stays on one line.
      const name = table().getByRole("button", { name: "Browser events, details" }).element();
      const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight) || 20;
      expect(name.getBoundingClientRect().height).toBeLessThan(lineHeight * 1.5);
      await table().getByRole("button", { name: "Browser events, details" }).click();
      const box = sheet().element().getBoundingClientRect();
      expect(box.width).toBeLessThanOrEqual(width);
    });
  }
});
