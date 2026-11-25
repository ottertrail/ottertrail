import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { FunnelStep } from "../../src/lib/product-api.ts";
import {
  type FakeApi,
  fakeFunnel,
  fakeFunnelBreakdown,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * Steps that match more than one exact thing: path patterns, filters that
 * do not equal or contain, saved goals copied into steps, and up to eight
 * steps (docs/product-analytics.md, "Steps").
 */

const FUNNEL = `/projects/${PROJECT.id}/product/funnel`;

/** The query of the latest request for a funnel's counts. */
function lastFunnelQuery(api: FakeApi): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith("/funnel")) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const funnelRequests = (api: FakeApi) =>
  api.requests.filter((request) => request.split("?")[0]?.endsWith("/funnel"));

const step = (number: number) => page.getByRole("group", { name: `Step ${number}` });
const newFunnelDialog = () => page.getByRole("dialog", { name: "New funnel" });

async function choose(combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  // The list closes before the next one opens.
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
}

async function newFunnel() {
  await page.getByRole("button", { name: "New funnel" }).click();
  await expect.element(newFunnelDialog()).toBeVisible();
}

/** A table's body rows as their cells' text, the bar cells left out. */
const tableRows = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
  );

const EIGHT: FunnelStep[] = Array.from({ length: 8 }, (_, index) => ({
  type: "page",
  path: `/onboarding/${index + 1}`,
}));
const EIGHT_REACHED = [1000, 800, 640, 500, 410, 300, 220, 150];

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("funnel steps", () => {
  test("a path pattern, and filters that do not equal or contain", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await newFunnel();
    await choose("Step 1 type", "Page");
    await step(1).getByRole("textbox", { name: "Path" }).fill("/docs/*");
    await step(2).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(2).getByRole("button", { name: "Add a property filter" }).click();
    await step(2).getByRole("textbox", { name: "Property" }).fill("plan");
    await expect
      .element(page.getByRole("combobox", { name: "Step 2 comparison" }))
      .toMatchTextContent(/equals/);
    await choose("Step 2 comparison", "does not equal");
    await step(2).getByRole("textbox", { name: "Value" }).fill("free");
    await page.getByRole("button", { name: "Add a step" }).click();
    await step(3).getByRole("combobox", { name: "Event name" }).fill("purchase");
    await step(3).getByRole("button", { name: "Add a property filter" }).click();
    await step(3).getByRole("textbox", { name: "Property" }).fill("sku");
    await choose("Step 3 comparison", "contains");
    await step(3).getByRole("textbox", { name: "Value" }).fill("team");

    await page.getByRole("button", { name: "Show funnel" }).click();

    await expect.element(newFunnelDialog()).not.toBeInTheDocument();
    await expect
      .poll(() => lastFunnelQuery(api).steps)
      .toBe(
        JSON.stringify([
          { type: "page", path: "/docs/*" },
          {
            type: "event",
            name: "signup",
            filter: { key: "plan", value: "free", operator: "notEquals" },
          },
          {
            type: "event",
            name: "purchase",
            filter: { key: "sku", value: "team", operator: "contains" },
          },
        ]),
      );
    await expect
      .element(
        page.getByText(
          "/docs/* → signup where plan ≠ free → purchase where sku contains team · Visitors, within 1 day",
          { exact: true },
        ),
      )
      .toBeVisible();
    // The editor reads the operators back; equals again drops the operator.
    await page.getByRole("button", { name: "Edit steps" }).click();
    await expect
      .element(page.getByRole("combobox", { name: "Step 2 comparison" }))
      .toMatchTextContent(/does not equal/);
    await expect
      .element(page.getByRole("combobox", { name: "Step 3 comparison" }))
      .toMatchTextContent(/contains/);
    await choose("Step 3 comparison", "equals");
    await page.getByRole("button", { name: "Show funnel" }).click();
    await expect
      .poll(() => JSON.parse(lastFunnelQuery(api).steps ?? "[]")[2])
      .toEqual({ type: "event", name: "purchase", filter: { key: "sku", value: "team" } });
  });

  test("catches a pattern and a path it matches in a row, before asking", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await newFunnel();
    await choose("Step 1 type", "Page");
    await step(1).getByRole("textbox", { name: "Path" }).fill("/docs/*");
    await choose("Step 2 type", "Page");
    await step(2).getByRole("textbox", { name: "Path" }).fill("/docs/start");

    await page.getByRole("button", { name: "Show funnel" }).click();

    await expect
      .element(step(2).getByText(/One event could count for both this step and the previous one/))
      .toBeVisible();
    expect(funnelRequests(api)).toEqual([]);

    // A plan that equals team, then one that does not: never the same event.
    await choose("Step 1 type", "Event");
    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(1).getByRole("button", { name: "Add a property filter" }).click();
    await step(1).getByRole("textbox", { name: "Property" }).fill("plan");
    await step(1).getByRole("textbox", { name: "Value" }).fill("team");
    await choose("Step 2 type", "Event");
    await step(2).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(2).getByRole("button", { name: "Add a property filter" }).click();
    await step(2).getByRole("textbox", { name: "Property" }).fill("plan");
    await choose("Step 2 comparison", "does not equal");
    await step(2).getByRole("textbox", { name: "Value" }).fill("team");
    await page.getByRole("button", { name: "Show funnel" }).click();
    await expect.element(newFunnelDialog()).not.toBeInTheDocument();
  });

  test("copies a saved goal into a step, saying it is a copy", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await newFunnel();

    await page.getByRole("button", { name: "Copy step 1 from a goal" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Team signup signup where plan = team" }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: /^Saw pricing/ }).click();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expect.element(step(1).getByRole("textbox", { name: "Path" })).toHaveValue("/pricing");
    await expect.element(step(1).getByText(/Copied from the goal “Saw pricing”\./)).toBeVisible();

    await page.getByRole("button", { name: "Copy step 2 from a goal" }).click();
    await page.getByRole("menuitem", { name: /^Team signup/ }).click();
    await expect
      .element(step(2).getByRole("combobox", { name: "Event name" }))
      .toHaveValue("signup");
    await expect.element(step(2).getByRole("textbox", { name: "Value" })).toHaveValue("team");
    // Changing the step makes it the user's own.
    await step(2).getByRole("textbox", { name: "Value" }).fill("teams");
    await expect.element(step(2).getByText(/Copied from the goal/)).not.toBeInTheDocument();
    await expect.element(step(1).getByText(/Copied from the goal/)).toBeVisible();

    await page.getByRole("button", { name: "Show funnel" }).click();
    await expect
      .poll(() => lastFunnelQuery(api).steps)
      .toBe(
        JSON.stringify([
          { type: "page", path: "/pricing" },
          { type: "event", name: "signup", filter: { key: "plan", value: "teams" } },
        ]),
      );
  });

  test("without saved goals, offers no copy", async () => {
    installFakeApi({ goals: [] });
    renderApp(FUNNEL);
    await newFunnel();
    await expect.element(step(2)).toBeVisible();
    expect(newFunnelDialog().element().textContent).not.toContain("Copy from a goal");
  });

  test("builds eight steps, and no more", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await newFunnel();
    for (let number = 3; number <= 8; number += 1) {
      await page.getByRole("button", { name: "Add a step" }).click();
    }
    for (let number = 1; number <= 8; number += 1) {
      await choose(`Step ${number} type`, "Page");
      await step(number).getByRole("textbox", { name: "Path" }).fill(`/onboarding/${number}`);
    }
    await expect.element(page.getByRole("button", { name: "Add a step" })).toBeDisabled();
    await expect.element(page.getByText("A funnel has at most 8 steps.")).toBeVisible();
    await page.getByRole("button", { name: "Show funnel" }).click();
    await expect.poll(() => lastFunnelQuery(api).steps).toBe(JSON.stringify(EIGHT));
  });

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`shows eight steps' result and breakdown at ${width} wide`, async () => {
      await page.viewport(width, height);
      installFakeApi({
        funnel: (query) => {
          const answer = fakeFunnel(query);
          return answer instanceof Response
            ? answer
            : {
                ...answer,
                steps: answer.steps.map((item, index) => ({
                  ...item,
                  reached: EIGHT_REACHED[index] ?? 0,
                })),
              };
        },
        funnelBreakdown: (query) => {
          const answer = fakeFunnelBreakdown(query);
          return answer instanceof Response
            ? answer
            : {
                ...answer,
                rows: [
                  {
                    kind: "value",
                    value: "Chrome",
                    reached: [600, 480, 380, 300, 250, 180, 130, 90],
                  },
                  {
                    kind: "value",
                    value: "Safari",
                    reached: [400, 320, 260, 200, 160, 120, 90, 60],
                  },
                ],
              };
        },
      });
      renderApp(`${FUNNEL}?steps=${encodeURIComponent(JSON.stringify(EIGHT))}&by=browser`);
      const resultsName = "Funnel steps, with the visitors who reached each";
      await expect.element(page.getByRole("table", { name: resultsName })).toBeVisible();
      await expect.poll(() => tableRows(resultsName).length).toBe(8);
      const breakdownName = "Funnel steps by browser, with the visitors who reached each";
      await expect.element(page.getByRole("table", { name: breakdownName })).toBeVisible();
      expect(tableRows(breakdownName)).toEqual([
        ["Chrome", "600", "480", "380", "300", "250", "180", "130", "90", "15%"],
        ["Safari", "400", "320", "260", "200", "160", "120", "90", "60", "15%"],
      ]);
      // The value column keeps room for its name; on a phone the table scrolls.
      const label = page
        .getByRole("table", { name: breakdownName })
        .element()
        .querySelector("tbody th");
      expect(label?.getBoundingClientRect().width).toBeGreaterThanOrEqual(120);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    });
  }
});
