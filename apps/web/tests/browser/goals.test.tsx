import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { GoalResult } from "../../src/lib/goals-api.ts";
import { fakeGoals, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const GOALS_PATH = `/api/projects/${PROJECT.id}/goals`;

/** Each goal row as its cells' text: name and what reaches it, visitors, conversion, events. */
function goalRows(): string[][] {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === "Goals, in the order added",
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].slice(0, 4).map((cell) => cell.textContent ?? ""),
  );
}

const dialog = () => page.getByRole("dialog", { name: "Add a goal" });

const analyticsRequests = (api: { requests: string[] }) =>
  api.requests.filter((path) => path.includes("/analytics")).length;

async function choose(combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** n goals with zero counts, for the limit. */
const manyGoals = (n: number): GoalResult[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
    name: `Goal ${i + 1}`,
    step: { type: "page", path: `/page-${i + 1}` },
    createdAt: "2026-11-01T00:00:00.000Z",
    visitors: 0,
    events: 0,
    conversionRate: 0,
  }));

describe("goals on the analytics page", () => {
  test("lists each goal with what reaches it, visitors, conversion, and events", async () => {
    installFakeApi({
      goals: [
        ...fakeGoals(),
        ...manyGoals(1).map((goal) => ({
          ...goal,
          name: "Most",
          visitors: 600,
          events: 900,
          conversionRate: 0.7843,
        })),
      ],
    });
    renderApp(ANALYTICS);

    await expect.element(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    // A share below 10% to one decimal, from there whole.
    expect(goalRows()).toEqual([
      ["Saw pricingViewed /pricing", "201", "26%", "260"],
      ["Team signupsignup where plan = team", "40", "5.2%", "44"],
      ["MostViewed /page-1", "600", "78%", "900"],
    ]);
    await expect.element(page.getByText(/^Of this page's visitors, in its period/)).toBeVisible();
  });

  test("adds a page goal; the next answer counts it", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);
    await expect.element(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    const before = analyticsRequests(api);

    await page.getByRole("button", { name: "Add goal" }).click();
    await expect.element(dialog()).toBeVisible();
    await expect.element(dialog().getByRole("textbox", { name: "Name" })).toHaveFocus();
    await dialog().getByRole("textbox", { name: "Name" }).fill("  Read the docs ");
    await choose("Goal type", "Page");
    await dialog().getByRole("textbox", { name: "Path" }).fill("/docs");
    await dialog().getByRole("button", { name: "Add goal" }).click();

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: GOALS_PATH,
      body: { name: "Read the docs", step: { type: "page", path: "/docs" } },
    });
    await expect.poll(() => analyticsRequests(api)).toBeGreaterThan(before);
    await expect
      .poll(() => goalRows().at(-1))
      .toEqual(["Read the docsViewed /docs", "0", "0%", "0"]);
  });

  test("adds an event goal with a property filter, saying a server's events do not count", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Add goal" }).click();
    await expect
      .element(dialog().getByText(/Events your server sends have no visitor/))
      .toBeVisible();
    await dialog().getByRole("textbox", { name: "Name" }).fill("Free signup");
    // The page's custom events are offered.
    await expect
      .element(dialog().getByRole("combobox", { name: "Event name" }))
      .toHaveAttribute("list");
    expect(document.querySelector("datalist option")?.getAttribute("value")).toBe("signup");
    await dialog().getByRole("combobox", { name: "Event name" }).fill("signup");
    await dialog().getByRole("button", { name: "Add a property filter" }).click();
    await dialog().getByRole("textbox", { name: "Property" }).fill("plan");
    await dialog().getByRole("textbox", { name: "Value" }).fill("free");
    await dialog().getByRole("button", { name: "Add goal" }).click();

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: GOALS_PATH,
      body: {
        name: "Free signup",
        step: { type: "event", name: "signup", filter: { key: "plan", value: "free" } },
      },
    });
    await expect
      .poll(() => goalRows().at(-1))
      .toEqual(["Free signupsignup where plan = free", "0", "0%", "0"]);
  });

  test("checks the fields before sending", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Add goal" }).click();
    await dialog().getByRole("button", { name: "Add goal" }).click();

    await expect
      .element(dialog().getByText("The goal is not complete. Fix the fields marked above."))
      .toBeVisible();
    await expect
      .element(dialog().getByRole("textbox", { name: "Name" }))
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(dialog().getByText("Name the goal.")).toBeVisible();
    await expect.element(dialog().getByText("Name the event.")).toBeVisible();

    await dialog().getByRole("textbox", { name: "Name" }).fill("x".repeat(101));
    await choose("Goal type", "Page");
    await dialog().getByRole("textbox", { name: "Path" }).fill("pricing");
    await expect
      .element(dialog().getByText("A goal's name has at most 100 characters."))
      .toBeVisible();
    await expect
      .element(dialog().getByText("A path starts with /, such as /pricing."))
      .toBeVisible();
    await dialog().getByRole("textbox", { name: "Path" }).fill("/pricing?plan=team");
    await expect
      .element(dialog().getByText("A path has no query (?) or fragment (#)."))
      .toBeVisible();

    expect(api.bodies.filter((body) => body.path === GOALS_PATH)).toEqual([]);
  });

  test("refuses the tracker's own events, which a goal could never count", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Add goal" }).click();
    await dialog().getByRole("textbox", { name: "Name" }).fill("Viewed a page");
    await dialog().getByRole("combobox", { name: "Event name" }).fill("pageview");
    await dialog().getByRole("button", { name: "Add goal" }).click();

    await expect
      .element(dialog().getByText(/"pageview" is the tracker's own event: use a page step/))
      .toBeVisible();
    expect(api.bodies.filter((body) => body.path === GOALS_PATH)).toEqual([]);
  });

  test("counts an emoji as one character, as the API does", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Add goal" }).click();
    await dialog().getByRole("textbox", { name: "Name" }).fill("🎉".repeat(101));
    await choose("Goal type", "Page");
    await dialog().getByRole("textbox", { name: "Path" }).fill("/party");
    await dialog().getByRole("button", { name: "Add goal" }).click();
    await expect
      .element(dialog().getByText("A goal's name has at most 100 characters."))
      .toBeVisible();

    // 100 emoji are 200 UTF-16 code units, and within the limit.
    await dialog().getByRole("textbox", { name: "Name" }).fill("🎉".repeat(100));
    await dialog().getByRole("button", { name: "Add goal" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: GOALS_PATH,
      body: { name: "🎉".repeat(100), step: { type: "page", path: "/party" } },
    });
  });

  test("moves focus to the Goals heading when a dialog closes", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    const heading = page.getByRole("heading", { name: "Goals" });

    await page.getByRole("button", { name: "Add goal" }).click();
    await dialog().getByRole("textbox", { name: "Name" }).fill("Read the docs");
    await choose("Goal type", "Page");
    await dialog().getByRole("textbox", { name: "Path" }).fill("/docs");
    await dialog().getByRole("button", { name: "Add goal" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    await expect.element(heading).toHaveFocus();

    // The deleted goal's button is gone with its row.
    await page.getByRole("button", { name: "Delete the goal Saw pricing" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete the goal “Saw pricing”?" });
    await confirm.getByRole("button", { name: "Delete goal" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect.element(heading).toHaveFocus();
  });

  test("shows the API's refusal in the dialog: a name already taken", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Add goal" }).click();
    await dialog().getByRole("textbox", { name: "Name" }).fill("Saw pricing");
    await choose("Goal type", "Page");
    await dialog().getByRole("textbox", { name: "Path" }).fill("/plans");
    await dialog().getByRole("button", { name: "Add goal" }).click();

    await expect
      .element(dialog().getByRole("alert"))
      .toHaveTextContent("The project already has a goal with this name.");
    await expect
      .element(dialog().getByRole("textbox", { name: "Name" }))
      .toHaveAttribute("aria-invalid", "true");
    expect(api.bodies.filter((body) => body.path === GOALS_PATH)).toHaveLength(1);

    // Another name clears it, and the goal is added.
    await dialog().getByRole("textbox", { name: "Name" }).fill("Saw plans");
    await expect.element(dialog().getByRole("alert")).not.toBeInTheDocument();
    await dialog().getByRole("button", { name: "Add goal" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
  });

  test("shows the limit refused by the API in the dialog", async () => {
    // 19 shown, but another tab added the 20th.
    const api = installFakeApi({ goals: manyGoals(19) });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Add goal" }).click();
    api.goals = manyGoals(20);
    await dialog().getByRole("textbox", { name: "Name" }).fill("One more");
    await choose("Goal type", "Page");
    await dialog().getByRole("textbox", { name: "Path" }).fill("/more");
    await dialog().getByRole("button", { name: "Add goal" }).click();

    await expect
      .element(dialog().getByRole("alert"))
      .toHaveTextContent("A project has at most 20 goals.");
    await expect.element(dialog()).toBeVisible();
  });

  test("deletes a goal after a confirmation that says no data is lost", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Delete the goal Saw pricing" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete the goal “Saw pricing”?" });
    await expect.element(confirm).toBeVisible();
    await expect.element(confirm.getByText(/counts are not stored/)).toBeVisible();

    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests.some((path) => path.startsWith(`${GOALS_PATH}/`))).toBe(false);

    await page.getByRole("button", { name: "Delete the goal Saw pricing" }).click();
    await confirm.getByRole("button", { name: "Delete goal" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests).toContain(`${GOALS_PATH}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1`);
    await expect
      .poll(() => goalRows())
      .toEqual([["Team signupsignup where plan = team", "40", "5.2%", "44"]]);
  });

  test("without goals, says what they are for, with a way to add one", async () => {
    installFakeApi({ goals: [] });
    renderApp(ANALYTICS);

    await expect.element(page.getByText("No goals yet")).toBeVisible();
    await expect
      .element(page.getByText(/A goal is a page or an event that counts as a success/))
      .toBeVisible();
    await page.getByRole("button", { name: "Add goal" }).click();
    await expect.element(dialog()).toBeVisible();
  });

  test("at 20 goals, Add goal is disabled with the reason", async () => {
    installFakeApi({ goals: manyGoals(20) });
    renderApp(ANALYTICS);

    const add = page.getByRole("button", { name: "Add goal" });
    await expect.element(add).toBeDisabled();
    await expect
      .element(add)
      .toHaveAccessibleDescription("A project has at most 20 goals. Delete one to add another.");
  });
});
