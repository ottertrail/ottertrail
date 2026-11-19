import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { deferred, fakeWidget, installFakeApi, json, memberAccess, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { currentPath, renderApp } from "./render.tsx";

const OVERVIEW = `/projects/${PROJECT.id}/overview`;

const projectMenu = () => page.getByRole("navigation", { name: "Project" });
/** A widget's region, by its title. */
const widget = (title: string) => page.getByRole("region", { name: title });
/** The widgets' titles, in the order the page shows them. */
const shownTitles = () =>
  [...document.querySelectorAll("section[data-widget] h2")].map((heading) => heading.textContent);

const ALL_TITLES = [
  "Needs attention now",
  "New and returning errors",
  "Uptime and response time",
  "Server requests, failures and p95",
  "Page speed",
  "Main goal",
  "Traffic",
  "Goals and conversion",
  "Signed-in users",
  "Top sources and pages",
];

describe("the project overview", () => {
  test("is the first item of the project menu, and renders every widget with its numbers", async () => {
    installFakeApi();
    renderApp(OVERVIEW);

    const first = projectMenu().getByRole("link").nth(1);
    await expect.element(first).toHaveTextContent("Overview");
    await expect.element(first).toHaveAttribute("data-active");
    await expect.element(widget("Top sources and pages").getByText("google.com")).toBeVisible();
    expect(shownTitles()).toEqual(ALL_TITLES);

    await expect
      .element(widget("Needs attention now").getByRole("cell", { name: /API down/ }))
      .toBeVisible();
    await expect.element(widget("Needs attention now").getByText("Answered 503")).toBeVisible();
    await expect
      .element(widget("New and returning errors").getByRole("link", { name: /TypeError/ }))
      .toBeVisible();
    await expect.element(widget("Uptime and response time").getByText("99.95%")).toBeVisible();
    await expect
      .element(widget("Server requests, failures and p95").getByText("182 ms"))
      .toBeVisible();
    await expect
      .element(widget("Page speed").getByText("Too few page loads to rate"))
      .toBeVisible();
    await expect.element(widget("Page speed").getByText("Poor")).toBeVisible();
    await expect.element(widget("Main goal").getByText("New signed-in users")).toBeVisible();
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();
    await expect.element(widget("Traffic").getByText("Up 12% from 683")).toBeInTheDocument();
    await expect
      .element(widget("Goals and conversion").getByRole("cell", { name: /^Saw pricing/ }))
      .toBeVisible();
    await expect
      .element(widget("Signed-in users").getByRole("link", { name: "user-1" }))
      .toBeVisible();
    // The days as the API counts them, and the period before.
    await expect.element(page.getByText("10 to 16 Nov 2026")).toBeVisible();
    await expect.element(page.getByText("3 to 9 Nov 2026")).toBeVisible();
  });

  test("a widget that fails says so on its own, and retries", async () => {
    let failing = true;
    installFakeApi({
      widget: (id, query, api) => {
        if (id === "services" && failing) {
          return json({ error: "internal_error", message: "The server did not answer." }, 500);
        }
        return fakeWidget(id, query, api);
      },
    });
    renderApp(OVERVIEW);

    const services = widget("Server requests, failures and p95");
    await expect
      .element(services.getByText("Server requests, failures and p95 could not load"))
      .toBeVisible();
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();
    failing = false;
    await services.getByRole("button", { name: "Retry" }).click();
    await expect.element(services.getByText("billing")).toBeVisible();
  });

  test("the period lives in the address and goes to every widget", async () => {
    const api = installFakeApi();
    const router = renderApp(OVERVIEW);
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${OVERVIEW}?period=30d`);
    await expect
      .poll(() => api.requests.filter((path) => path.includes("/overview/traffic?period=30d")))
      .toHaveLength(1);
  });
});

describe("edit mode", () => {
  test("hides, moves, and resets; each change is announced and saved", async () => {
    const api = installFakeApi();
    renderApp(OVERVIEW);
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();

    await page.getByRole("button", { name: "Edit overview" }).click();
    await page.getByRole("button", { name: "Hide New and returning errors" }).click();
    await expect.element(page.getByText("New and returning errors hidden.")).toBeVisible();
    await expect.poll(() => api.layout?.hidden).toEqual(["errors"]);

    const up = page.getByRole("button", { name: "Move Traffic up" });
    await up.click();
    await expect.element(page.getByText("Traffic moved to 6 of 10.")).toBeVisible();
    // Focus stays on the button that moved it.
    await expect.element(up).toHaveFocus();
    await expect.poll(() => api.layout?.order.indexOf("traffic")).toBe(5);

    await page.getByRole("button", { name: "Done" }).click();
    expect(shownTitles()).toEqual([
      "Needs attention now",
      "Uptime and response time",
      "Server requests, failures and p95",
      "Page speed",
      "Traffic",
      "Main goal",
      "Goals and conversion",
      "Signed-in users",
      "Top sources and pages",
    ]);
    // A hidden widget's numbers are not fetched.
    expect(api.requests.filter((path) => path.includes("/overview/errors"))).toHaveLength(1);

    // It persists: a new visit shows the saved layout.
    unmountAll();
    renderApp(OVERVIEW);
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();
    expect(shownTitles()).not.toContain("New and returning errors");

    await page.getByRole("button", { name: "Edit overview" }).click();
    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect.element(page.getByText("The default layout is back.")).toBeVisible();
    expect(api.layout).toBeNull();
    await page.getByRole("button", { name: "Done" }).click();
    expect(shownTitles()).toEqual(ALL_TITLES);
  });
});

describe("what a member sees", () => {
  test("only the widgets of their areas, and nothing else is asked for", async () => {
    const api = installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(OVERVIEW);
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();
    expect(shownTitles()).toEqual(["Page speed", "Traffic", "Top sources and pages"]);
    const asked = api.requests
      .filter((path) => path.includes("/overview/") && !path.includes("/layout"))
      .map((path) => path.split("/overview/")[1]?.split("?")[0]);
    expect([...new Set(asked)].toSorted()).toEqual(["sources", "speed", "traffic"]);
  });

  test("with none of the overview's areas: a short state that points to their pages", async () => {
    installFakeApi({ access: memberAccess({ replays: "view" }) });
    renderApp(OVERVIEW);
    await expect.element(page.getByText("Nothing on your overview")).toBeVisible();
    await expect
      .element(page.getByRole("main").getByRole("link", { name: "Replays" }))
      .toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "Overview" }))
      .not.toBeInTheDocument();
  });

  test("user IDs only with the users area", async () => {
    installFakeApi({ access: memberAccess({ product_analytics: "view" }) });
    renderApp(OVERVIEW);
    await expect.element(widget("Signed-in users").getByText("48")).toBeVisible();
    await expect.element(page.getByText("user-1")).not.toBeInTheDocument();
  });
});

describe("opening a project", () => {
  test("lands on the overview with one of its areas", async () => {
    installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}`);
    await expect.poll(() => router.state.location.pathname).toBe(OVERVIEW);
  });

  test("lands on the first area without any of the overview's", async () => {
    installFakeApi({ access: memberAccess({ replays: "view" }) });
    const router = renderApp(`/projects/${PROJECT.id}`);
    await expect.poll(() => router.state.location.pathname).toBe(`/projects/${PROJECT.id}/replays`);
  });
});

/** Whether each widget draws a line above it. */
const topLines = (sections: HTMLElement[]) =>
  sections.map((section) => getComputedStyle(section).borderTopWidth !== "0px");

describe("on a phone", () => {
  test("the widgets stack in one column, and nothing scrolls the page sideways", async () => {
    await page.viewport(390, 844);
    try {
      installFakeApi();
      renderApp(OVERVIEW);
      await expect.element(widget("Traffic").getByText("765")).toBeVisible();
      const sections = [...document.querySelectorAll<HTMLElement>("section[data-widget]")];
      const lefts = new Set(
        sections.map((section) => Math.round(section.getBoundingClientRect().left)),
      );
      expect(lefts.size).toBe(1);
      // The filter bar draws the line above the first widget; each later one draws its own.
      expect(topLines(sections)).toEqual(sections.map((_, index) => index > 0));
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      // A table cut off at the edge shows a fade there: more columns to scroll to.
      await expect
        .poll(() => document.querySelectorAll("[data-slot=scroll-hint]").length)
        .toBeGreaterThan(0);
    } finally {
      await page.viewport(1280, 900);
    }
  });
});

describe("at 1440 wide", () => {
  test("two columns, and no widget's table is wider than its widget", async () => {
    await page.viewport(1440, 900);
    try {
      installFakeApi();
      renderApp(OVERVIEW);
      await expect.element(widget("Uptime and response time").getByText("99.95%")).toBeVisible();
      await expect.element(widget("Signed-in users").getByText("48")).toBeVisible();
      const sections = [...document.querySelectorAll<HTMLElement>("section[data-widget]")];
      const lefts = new Set(
        sections.map((section) => Math.round(section.getBoundingClientRect().left)),
      );
      expect(lefts.size).toBe(2);
      // No second line under the filter bar: the first row of two draws none.
      expect(topLines(sections)).toEqual(sections.map((_, index) => index > 1));
      const overflowing = sections.flatMap((section) => {
        const width = section.getBoundingClientRect().width;
        return [...section.querySelectorAll("table")]
          .filter((table) => table.getBoundingClientRect().width > width + 1)
          .map(() => section.dataset.widget);
      });
      expect(overflowing).toEqual([]);
    } finally {
      await page.viewport(1280, 900);
    }
  });
});

describe("saving the layout", () => {
  test("two quick moves are saved in order, and the page keeps the last", async () => {
    const api = installFakeApi();
    const held = deferred<void>();
    api.holdLayout = held.promise;
    renderApp(OVERVIEW);
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();

    await page.getByRole("button", { name: "Edit overview" }).click();
    const up = page.getByRole("button", { name: "Move Traffic up" });
    // The first save is held back by the API; the second is asked for meanwhile.
    await up.click();
    await up.click();
    await expect.element(page.getByText("Traffic moved to 5 of 10.")).toBeVisible();
    held.resolve();

    await expect.poll(() => api.layout?.order.indexOf("traffic")).toBe(4);
    const saves = api.bodies.filter((body) => body.path.endsWith("/overview/layout"));
    await expect.poll(() => saves.length).toBe(2);
    // The page still shows the second move once the first save's answer is in.
    await expect.poll(() => shownTitles().indexOf("Traffic")).toBe(4);
  });

  test("a widget the dashboard does not know is left out, and the rest still show", async () => {
    const api = installFakeApi();
    api.unknownWidgets = ["from-the-future"];
    renderApp(OVERVIEW);
    await expect.element(widget("Traffic").getByText("765")).toBeVisible();
    expect(shownTitles()).toEqual(ALL_TITLES);
  });
});

describe("changes and states", () => {
  test("each figure's change rests on its own counts, and none before reads New", async () => {
    installFakeApi({
      widget: (id, query, api) => {
        const answer = fakeWidget(id, query, api);
        return id === "traffic" && typeof answer === "object" && answer !== null
          ? {
              ...answer,
              summary: { visitors: 765, visits: 824, pageviews: 30 },
              previousSummary: { visitors: 683, visits: 824, pageviews: 0 },
            }
          : answer;
      },
    });
    renderApp(OVERVIEW);
    const traffic = widget("Traffic");
    // Visitors are gated on visitors, not on the few pageviews.
    await expect.element(traffic.getByText("Up 12% from 683")).toBeInTheDocument();
    await expect.element(traffic.getByText("New: none in the period before")).toBeInTheDocument();
  });

  test("retention leaves out a week in progress, and says so", async () => {
    installFakeApi();
    renderApp(OVERVIEW);
    const users = widget("Signed-in users");
    await expect.element(users.getByText("This week, not over").first()).toBeVisible();
    await expect
      .element(
        users.getByText(
          /Week 1 of the 2 Nov cohort: 40%, against 47% for the earlier cohorts shown\./,
        ),
      )
      .toBeVisible();
  });

  test("an expired certificate says it expired; a cut error list marks its count", async () => {
    installFakeApi({
      widget: (id, query, api) => {
        const answer = fakeWidget(id, query, api);
        if (typeof answer !== "object" || answer === null) return answer;
        if (id === "attention") {
          return {
            ...answer,
            certificates: [
              {
                checkId: "cccccccc-cccc-4ccc-8ccc-000000000001",
                name: "Shop home",
                url: "https://shop.example/",
                expiresAt: "2026-11-01T00:00:00.000Z",
                expired: true,
              },
            ],
          };
        }
        return id === "errors" ? { ...answer, truncated: true } : answer;
      },
    });
    renderApp(OVERVIEW);
    const attention = widget("Needs attention now");
    await expect.element(attention.getByText("Expired", { exact: true })).toBeVisible();
    await expect
      .element(attention.getByText(/Its certificate expired on 1 Nov 2026/))
      .toBeVisible();
    await expect.element(widget("New and returning errors").getByText("1+")).toBeVisible();
  });
});
