import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { SavedFunnel } from "../../src/lib/funnels-api.ts";
import type { FunnelStep } from "../../src/lib/product-api.ts";
import { hoverAt } from "./chart-pointer.ts";
import { installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The saved funnels list's keys and Duplicate, a funnel's conversion over
 * time, and the time between its steps (docs/dashboard.md, "Product
 * analytics").
 */

const FUNNEL = `/projects/${PROJECT.id}/product/funnel`;
const FUNNELS_PATH = `/api/projects/${PROJECT.id}/funnels`;
const PRICING = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const TEAM_TRIAL = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

const SIGNUP_PURCHASE: FunnelStep[] = [
  { type: "event", name: "signup" },
  { type: "event", name: "purchase" },
];
const THREE_STEPS: FunnelStep[] = [...SIGNUP_PURCHASE, { type: "event", name: "invite" }];

const funnelAddress = (steps: FunnelStep[], rest = "") =>
  `${FUNNEL}?steps=${encodeURIComponent(JSON.stringify(steps))}${rest}`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const savedTable = () => page.getByRole("table", { name: "Saved funnels, by name" });

/** The rows j and k moved to: their name. */
const selectedRows = () =>
  [...document.querySelectorAll("tr[data-state=selected]")].map(
    (row) => row.querySelector("th")?.textContent,
  );

/** How many tooltips are open. */
const openTooltips = () =>
  document.querySelectorAll("[data-slot=tooltip-content][data-open]").length;

/** n saved funnels of visitors within a day. */
const manyFunnels = (n: number): SavedFunnel[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`,
    name: `Funnel ${String(i + 1).padStart(2, "0")}`,
    steps: [
      { type: "page", path: `/page-${i + 1}` },
      { type: "event", name: "signup" },
    ],
    count: "visitors",
    window: 86_400,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  }));

describe("the saved funnels list's keys", () => {
  test("j and k move through the rows with focus, Enter opens one, Esc clears", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    const router = renderApp(FUNNEL);
    await expect.element(savedTable()).toBeVisible();
    // The hints sit in the filter bar, as on the workbench pages.
    const hints = page.getByRole("list", { name: "Keyboard shortcuts" });
    await expect.element(hints).toHaveTextContent("jkmoveEnteroopenEscclear");

    await userEvent.keyboard("j");
    await expect.poll(selectedRows).toEqual(["pricing to signup"]);
    await expect.element(page.getByRole("link", { name: "pricing to signup" })).toHaveFocus();
    await userEvent.keyboard("j");
    await expect.poll(selectedRows).toEqual(["Team trial"]);
    await userEvent.keyboard("j");
    await expect.poll(selectedRows).toEqual(["Team trial"]);
    await userEvent.keyboard("k");
    await expect.poll(selectedRows).toEqual(["pricing to signup"]);
    await userEvent.keyboard("{Escape}");
    await expect.poll(selectedRows).toEqual([]);

    await userEvent.keyboard("k");
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => (router.state.location.search as { funnel?: string }).funnel)
      .toBe(PRICING);
    await expect.element(page.getByRole("heading", { name: "pricing to signup" })).toBeVisible();
  });

  test("Esc clears the row while a tooltip is open, and closes the tooltip", async () => {
    installFakeApi();
    renderApp(FUNNEL);
    await expect.element(savedTable()).toBeVisible();
    // The pointer resting on a control with a tooltip, as it may on CI.
    await page.getByRole("button", { name: "Collapse sidebar" }).hover();
    await expect.poll(openTooltips).toBe(1);

    await userEvent.keyboard("j");
    await expect.poll(selectedRows).toEqual(["pricing to signup"]);
    await userEvent.keyboard("{Escape}");
    await expect.poll(selectedRows).toEqual([]);
    await expect.poll(openTooltips).toBe(0);
  });

  test("o opens the row moved to, even with focus elsewhere", async () => {
    installFakeApi();
    const router = renderApp(FUNNEL);
    await expect.element(savedTable()).toBeVisible();
    await userEvent.keyboard("jj");
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("o");
    await expect
      .poll(() => (router.state.location.search as { funnel?: string }).funnel)
      .toBe(TEAM_TRIAL);
  });

  test("do nothing while typing in a field or with a dialog open", async () => {
    installFakeApi();
    renderApp(FUNNEL);
    await expect.element(savedTable()).toBeVisible();

    await page.getByRole("button", { name: "Rename the funnel Team trial" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename the funnel “Team trial”" });
    const name = dialog.getByRole("textbox", { name: "Name" });
    await name.fill("");
    await userEvent.type(name, "jkoj");
    await expect.element(name).toHaveValue("jkoj");
    expect(selectedRows()).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await userEvent.keyboard("j");
    await expect.poll(selectedRows).toEqual(["pricing to signup"]);
  });
});

describe("duplicating a saved funnel", () => {
  test("saves a copy with the same steps under a free name, and stays on the list", async () => {
    const api = installFakeApi();
    // "Team trial copy" is taken, so the copy is "Team trial copy 2".
    api.savedFunnels = [...api.savedFunnels, { ...manyFunnels(1)[0], name: "Team trial copy" }];
    const router = renderApp(FUNNEL);

    await page
      .getByRole("button", { name: "Duplicate the funnel Team trial", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Duplicate the funnel “Team trial”" });
    await expect
      .element(dialog.getByRole("textbox", { name: "Name" }))
      .toHaveValue("Team trial copy 2");
    await dialog.getByRole("button", { name: "Save funnel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();

    expect(api.bodies).toContainEqual({
      method: "POST",
      path: FUNNELS_PATH,
      body: {
        name: "Team trial copy 2",
        steps: [
          { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
          { type: "event", name: "purchase" },
        ],
        count: "users",
        window: 604_800,
      },
    });
    await expect.element(page.getByRole("link", { name: "Team trial copy 2" })).toBeVisible();
    await expect.poll(selectedRows).toEqual(["Team trial copy 2"]);
    expect((router.state.location.search as { funnel?: string }).funnel).toBeUndefined();
    await expect.element(page.getByText("4 of 50 saved")).toBeVisible();
  });

  test("at 50 saved, Duplicate is off with the reason Save gives", async () => {
    installFakeApi({ savedFunnels: manyFunnels(50) });
    renderApp(FUNNEL);
    const duplicate = page.getByRole("button", { name: "Duplicate the funnel Funnel 01" });
    await expect.element(duplicate).toBeDisabled();
    await expect
      .element(duplicate)
      .toHaveAccessibleDescription(
        "A project has at most 50 saved funnels. Delete one to save another.",
      );
  });

  test("needs the manage level, as Rename does", async () => {
    installFakeApi({ access: memberAccess({ product_analytics: "view" }) });
    renderApp(FUNNEL);
    await expect.element(savedTable()).toBeVisible();
    expect(page.getByRole("button", { name: /^Duplicate the funnel/ }).elements()).toEqual([]);
    expect(page.getByRole("button", { name: /^Rename the funnel/ }).elements()).toEqual([]);
  });
});

/** The chart's section, by its heading. */
const trendSection = () =>
  page.getByRole("heading", { name: "Conversion over time" }).element().closest("section");

/** Moves the pointer over the trend's point at `index` of `count`, and returns the tooltip's text. */
async function hoverTrend(index: number, count: number) {
  const chart = trendSection();
  if (chart === null || chart === undefined) throw new Error("The trend has no plot");
  return hoverAt(chart, index / (count - 1));
}

describe("conversion over time", () => {
  test("a point per day, with the conversion and counts in its tooltip, none on a day without step 1", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(THREE_STEPS, "&period=7d"));
    await expect.element(page.getByRole("slider", { name: "Conversion per day" })).toBeVisible();
    expect(api.requests.some((request) => request.includes("/funnel/trend?"))).toBe(true);

    expect(await hoverTrend(0, 7)).toBe("Tue 10 Nov10%conversion200at step 120at step 3");
    expect(await hoverTrend(4, 7)).toBe("Sat 14 Nov3%conversion1,200at step 130at step 3");
    // Nobody did step 1 on 13 November: no point, not 0%.
    expect(await hoverTrend(3, 7)).toBe("Fri 13 NovNovisitors at step 1");
    // The line breaks there: two runs of days.
    expect(
      trendSection()?.querySelector(".recharts-area-curve")?.getAttribute("d")?.match(/M/g)?.length,
    ).toBe(2);

    // The numbers, as a table.
    await page.getByRole("button", { name: "Show the numbers" }).first().click();
    const table = page.getByRole("table", { name: "Conversion per day" });
    await expect.element(table).toBeVisible();
    expect(
      [...table.element().querySelectorAll("tbody tr")][3]?.textContent?.replaceAll(/\s+/g, " "),
    ).toBe("Sat 14 Nov1,200303%");
  });

  test("left out for a single day", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(THREE_STEPS, "&period=today"));
    await expect
      .element(
        page.getByRole("table", { name: "Funnel steps, with the visitors who reached each" }),
      )
      .toBeVisible();
    expect(page.getByRole("heading", { name: "Conversion over time" }).elements()).toEqual([]);
    expect(api.requests.some((request) => request.includes("/funnel/trend?"))).toBe(false);
  });

  test("per week for a long period", async () => {
    installFakeApi({
      funnelTrend: () => ({
        timeZone: "UTC",
        environment: "production",
        firstDay: "2026-08-19",
        lastDay: "2026-11-16",
        count: "visitors",
        window: 86_400,
        unit: "week",
        points: [{ day: "2026-11-09", started: 40, converted: 10 }],
      }),
    });
    renderApp(funnelAddress(THREE_STEPS, "&period=90d"));
    await expect.element(page.getByRole("slider", { name: "Conversion per week" })).toBeVisible();
    await expect
      .element(page.getByText("By the week each of the visitors did step 1."))
      .toBeVisible();
  });
});

describe("time between steps", () => {
  test("the median and 75th percentile per step in the table, and overall in the strip", async () => {
    installFakeApi();
    renderApp(funnelAddress([...THREE_STEPS, { type: "event", name: "upgrade" }]));
    const table = page.getByRole("table", {
      name: "Funnel steps, with the visitors who reached each",
    });
    await expect.element(table).toBeVisible();
    await expect.element(table.getByRole("columnheader", { name: "Median time" })).toBeVisible();
    const times = () =>
      [...table.element().querySelectorAll("tbody tr")].map(
        (row) => row.querySelectorAll("td")[3]?.textContent,
      );
    await expect
      .poll(times)
      .toEqual(["–", "4 minp75 15 min", "2 h 10 minp75 1 day 2 h", "3 daysp75 5 days"]);
    const strip = document.querySelector('dl[aria-label="Conversion"]');
    await expect
      .poll(() =>
        [...(strip?.querySelectorAll("[data-slot=stat]") ?? [])].at(-1)?.textContent?.trim(),
      )
      .toBe("Median time to convert3 daysp75 6 days, step 1 to 4");
  });
});
