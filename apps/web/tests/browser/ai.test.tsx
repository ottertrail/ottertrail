import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { AiChart, AiReport } from "../../src/lib/ai-api.ts";
import { AI_CALLS, fakeAi, fakeAiCalls, fakeAiChart, fakeAiReport, noAiCalls } from "./fake-ai.ts";
import { deferred, type FakeApi, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { renderApp } from "./render.tsx";

/**
 * The AI page (docs/ai-usage.md; features/ai): the figures with their
 * estimate, the chart's measures and splits, the tables and the filters
 * their names apply, the links to users and traces, the users hidden
 * without the Users area, and its empty, loading, and failed states.
 * report-screens.test.tsx checks its filter bar and its fit at 390 and
 * 1440 wide.
 */

const AI = `/projects/${PROJECT.id}/ai`;
const MODELS = "Calls by model, the costliest first";
const FEATURES = "Calls by feature, the costliest first";
const LATEST = "The latest 50 calls, newest first";

afterEach(async () => {
  await page.viewport(1280, 900);
});

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> | undefined {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path));
  if (request === undefined) return undefined;
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const projectMenu = () => page.getByRole("navigation", { name: "Project" });

const cellsOf = (row: Element | undefined) =>
  [...(row?.querySelectorAll("th, td") ?? [])].map((cell) => cell.textContent);

const rowsOf = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map(cellsOf);

/** The strip's figures: each label, value, and change as shown. */
const figures = () =>
  [...document.querySelectorAll("dl[aria-label=Figures] [data-slot=stat]")].map((stat) =>
    [...stat.querySelectorAll("dt, dd")].map((part) => part.textContent),
  );

/** The chart's legend: each line's name and color. */
const legend = () =>
  [...document.querySelectorAll("ul[aria-label=Legend] li")].map((item) => [
    item.textContent,
    item.querySelector("span")?.style.background,
  ]);

/** The week's chart split into ten models and Other: more lines than there are colors. */
function tenModels(query: URLSearchParams): AiChart {
  const chart = fakeAiChart(query);
  const [line] = chart.series;
  if (line === undefined) throw new Error("the fixtures changed");
  return {
    ...chart,
    series: [
      ...Array.from({ length: 10 }, (_, index) => ({ ...line, key: `model-${index + 1}` })),
      { ...line, key: "", other: true },
    ],
  };
}

const busy = () =>
  new Response(JSON.stringify({ error: "busy", message: "This took too long." }), { status: 503 });

describe("the AI page", () => {
  test("opens from the sidebar after Databases, with the figures and the estimate", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/databases`);
    await expect
      .element(projectMenu().getByRole("link", { name: "AI", exact: true }))
      .toBeVisible();
    expect(
      [...document.querySelectorAll("nav[aria-label=Project] [data-sidebar=menu-button]")]
        .map((item) => item.textContent)
        .slice(12, 15),
    ).toEqual(["Databases", "AI", "Hosts"]);
    await projectMenu().getByRole("link", { name: "AI", exact: true }).click();

    await expect.poll(() => router.state.location.pathname).toBe(AI);
    await expect.element(page.getByRole("heading", { level: 1, name: "AI" })).toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "AI", exact: true }))
      .toHaveAttribute("data-active");
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    expect(lastQuery(api, "/ai")).toEqual({ period: "7d" });
    expect(lastQuery(api, "/ai/chart")).toEqual({ period: "7d" });
    expect(lastQuery(api, "/ai/calls")).toEqual({ period: "7d" });

    expect(figures()).toEqual([
      ["Estimated cost (USD)", "$32.66", "36%Up 36% from $24.10"],
      ["Calls", "16.5K", "38%Up 38% from 12,000"],
      ["Input tokens", "12.5M", "37%Up 37% from 9,100,000"],
      ["Output tokens", "2.3M", "33%Up 33% from 1,700,000"],
      ["Cache-read share", "37%", "7 ptsUp 7 points from 30%"],
      ["95th percentile", "5.12 s", "7%Up 7% from 4.8 s"],
      ["Failed", "1.0%", "1 ptUp 1 point from 0.3%"],
    ]);
    await expect.element(page.getByText("Up 36% from $24.10", { exact: true })).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "90 calls had no price and are not in the cost: acme-support-ft-2026-10. Set prices in Settings.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Cost is an estimate from token counts and model prices. Changes compare with 3 to 9 Nov 2026.",
        ),
      )
      .toBeVisible();
  });

  test("the header links to the page's docs", async () => {
    installFakeApi();
    renderApp(AI);
    const link = page.getByRole("link", { name: "AI docs (opens in a new tab)", exact: true });
    await expect
      .element(link)
      .toHaveAttribute("href", "https://docs.ottertrail.app/monitoring/ai-usage/");
    await expect.element(link).toHaveAttribute("target", "_blank");
  });

  test("without a price, no line says so", async () => {
    installFakeApi({
      ai: {
        ...fakeAi(),
        report: (query, users) => {
          const report = fakeAiReport(query, users);
          return {
            ...report,
            totals: { ...report.totals, noPriceCalls: 0, noPriceModels: [] },
          };
        },
      },
    });
    renderApp(AI);
    await expect.element(page.getByText(/Cost is an estimate/)).toBeVisible();
    expect(page.getByText(/had no price/).elements()).toEqual([]);
  });

  test("the chart: cost by model by default, another measure, and split by feature", async () => {
    const api = installFakeApi();
    renderApp(AI);
    await expect.element(page.getByRole("heading", { name: "Estimated cost (USD)" })).toBeVisible();
    await expect.element(page.getByText("Estimated cost per day, by model.")).toBeVisible();
    // The models in slot order, as the API orders them: the costliest first.
    await expect.poll(legend).toEqual([
      ["claude-sonnet-4-6", "var(--chart-1)"],
      ["gpt-5-mini", "var(--chart-2)"],
      ["text-embedding-3-small", "var(--chart-3)"],
      ["acme-support-ft-2026-10", "var(--chart-4)"],
    ]);
    await expect
      .element(page.getByRole("button", { name: "Cost", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    // The keyboard readout of the last day: each line's value.
    await expect
      .element(page.getByRole("slider", { name: "Estimated cost (USD), AI calls, per day" }))
      .toHaveAttribute("aria-valuetext", expect.stringContaining("claude-sonnet-4-6 $4.70"));

    await page.getByRole("button", { name: "Tokens", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "Tokens" })).toBeVisible();
    await expect
      .element(page.getByText("Input and output tokens per day, by model."))
      .toBeVisible();
    await page.getByRole("button", { name: "95th percentile", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "95th percentile (s)" })).toBeVisible();

    await page.getByRole("button", { name: "By feature", exact: true }).click();
    await expect
      .poll(() => lastQuery(api, "/ai/chart"))
      .toEqual({ period: "7d", split: "feature" });
    await expect
      .element(page.getByText(/per day, by feature\. A gap means no call\./))
      .toBeVisible();
    await expect.poll(legend).toEqual([
      ["support-chat", "var(--chart-1)"],
      ["summarize-ticket", "var(--chart-2)"],
      ["Unlabeled", "var(--chart-3)"],
      ["search-index", "var(--chart-4)"],
    ]);
    // One y-axis, one measure: a single chart.
    expect(document.querySelectorAll("[data-slot=report-chart]")).toHaveLength(1);
  });

  test("past eight lines, the rest fold into Other, in gray; a 95th percentile is not added up", async () => {
    installFakeApi({ ai: { ...fakeAi(), chart: tenModels } });
    renderApp(AI);
    await expect.poll(() => legend().length).toBe(9);
    expect(legend().slice(7)).toEqual([
      ["model-8", "var(--chart-8)"],
      ["Other models", "var(--ink-tertiary)"],
    ]);
    await page.getByRole("button", { name: "95th percentile", exact: true }).click();
    await expect.poll(() => legend().length).toBe(8);
    expect(legend().map(([name]) => name)).not.toContain("Other models");
  });

  test("the model and feature tables: their figures, No price, and names that filter", async () => {
    const api = installFakeApi();
    const router = renderApp(`${AI}?period=30d`);
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    expect(rowsOf(MODELS)).toEqual([
      [
        "claude-sonnet-4-6",
        "anthropic",
        "4,210",
        "7.6M",
        "$29.37",
        "1.84 s",
        "6.42 s",
        "610 ms",
        "0.5%",
        "0.8%",
      ],
      [
        "gpt-5-mini",
        "openai",
        "9,800",
        "5.9M",
        "$3.27",
        "920 ms",
        "2.81 s",
        "340 ms",
        "1.5%",
        "0%",
      ],
      [
        "text-embedding-3-small",
        "openai",
        "2,400",
        "1.2M",
        "$0.024",
        "120 ms",
        "310 ms",
        "–Not sent",
        "0%",
        "0%",
      ],
      [
        "acme-support-ft-2026-10",
        "openai",
        "90",
        "63K",
        "No price",
        "1.5 s",
        "3.9 s",
        "420 ms",
        "0%",
        "0%",
      ],
    ]);
    expect(rowsOf(FEATURES).map((row) => row[0])).toEqual([
      "support-chat",
      "summarize-ticket",
      "Unlabeled",
      "search-index",
    ]);

    // A model's name filters the page by it: the address and every request take it.
    await page
      .getByRole("table", { name: MODELS })
      .getByRole("link", { name: "Filter by the model gpt-5-mini" })
      .click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", model: "gpt-5-mini" });
    await expect.poll(() => lastQuery(api, "/ai")).toEqual({ period: "30d", model: "gpt-5-mini" });
    expect(lastQuery(api, "/ai/calls")).toEqual({ period: "30d", model: "gpt-5-mini" });
    await expect
      .element(page.getByRole("combobox", { name: "Model" }))
      .toMatchTextContent(/^gpt-5-mini/);

    // Unlabeled is the calls with no feature: an empty filter.
    await page
      .getByRole("table", { name: FEATURES })
      .getByRole("link", { name: "Filter by the feature Unlabeled" })
      .click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", model: "gpt-5-mini", feature: "" });
    await expect
      .poll(() => lastQuery(api, "/ai"))
      .toEqual({ period: "30d", model: "gpt-5-mini", feature: "" });
    await expect
      .element(page.getByRole("combobox", { name: "Feature" }))
      .toMatchTextContent(/^Unlabeled/);
  });

  test("a model priced only from a day inside the period shows its cost and the calls without a price", async () => {
    installFakeApi({
      ai: {
        ...fakeAi(),
        report: (query, users) => {
          const report = fakeAiReport(query, users);
          const [sonnet, ...rest] = report.models;
          if (sonnet === undefined) throw new Error("The fake report has no models");
          // 12 of its 4,210 calls came before its price started.
          return { ...report, models: [{ ...sonnet, priced: false, noPriceCalls: 12 }, ...rest] };
        },
      },
    });
    renderApp(`${AI}?period=30d`);
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    const costs = () => rowsOf(MODELS).map((row) => row[4]);
    expect(costs()).toEqual([
      "$29.3712 calls without a price",
      "$3.27",
      "$0.024",
      // None of its calls had a price.
      "No price",
    ]);
    // A feature whose calls use a model without a price: the same.
    expect(rowsOf(FEATURES)[0]?.[3]).toBe("$24.8090 calls without a price");
  });

  test("an address with filters asks for them, and the filter bar clears one", async () => {
    const api = installFakeApi();
    const router = renderApp(`${AI}?env=staging&service=worker&provider=openai`);
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    expect(lastQuery(api, "/ai")).toEqual({
      period: "7d",
      environment: "staging",
      service: "worker",
      provider: "openai",
    });
    await expect
      .element(page.getByRole("combobox", { name: "Environment" }))
      .toMatchTextContent(/^staging/);
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "Any provider" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ env: "staging", service: "worker" });
  });

  test("users open their pages; failures by type; the latest calls open their traces", async () => {
    installFakeApi();
    const router = renderApp(AI);
    const users = "The 50 users whose calls cost the most, the costliest first";
    await expect.element(page.getByRole("table", { name: users })).toBeVisible();
    expect(rowsOf(users)).toEqual([
      ["user_8f2a", "", "$2.94", "420", "756K"],
      ["ada@example.com", "", "$1.71", "310", "508K"],
    ]);
    expect(rowsOf("Failed calls by error type, the most first")).toEqual([
      ["RateLimitError", "120", "71%", "16 Nov 2026, 15:41"],
      ["APITimeoutError", "40", "24%", "16 Nov 2026, 14:12"],
      ["No error type", "8", "4.8%", "16 Nov 2026, 07:05"],
    ]);

    await expect.element(page.getByRole("table", { name: LATEST })).toBeVisible();
    expect(rowsOf(LATEST).map((row) => row.slice(0, 9))).toEqual([
      [
        "16 Nov 2026, 15:38",
        "claude-sonnet-4-6",
        "support-chat",
        "user_8f2a",
        "1,520",
        "380",
        "$0.0078",
        "2.14 s",
        "OK",
      ],
      [
        "16 Nov 2026, 15:36",
        "gpt-5-mini",
        "Unlabeled",
        "–No user",
        "640",
        "0",
        "$0.00016",
        "310 ms",
        "Failed: RateLimitError",
      ],
      [
        "16 Nov 2026, 15:34",
        "claude-sonnet-4-6",
        "summarize-ticket",
        "ada@example.com",
        "5,200",
        "1,024",
        "$0.031",
        "7.81 s",
        "Cut off",
      ],
      [
        "16 Nov 2026, 15:32",
        "acme-support-ft-2026-10",
        "support-chat",
        "user_8f2a",
        "480",
        "210",
        "No price",
        "1.49 s",
        "OK",
      ],
    ]);

    const [first] = AI_CALLS;
    await page
      .getByRole("table", { name: LATEST })
      .getByRole("link", { name: /^Open its trace \(claude-sonnet-4-6, 16 Nov 2026, 15:38\)$/ })
      .click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/traces/${first?.traceId}`);
    expect(router.state.location.search).toEqual({ at: first?.at, span: first?.spanId });

    router.history.back();
    await page
      .getByRole("table", { name: users })
      .getByRole("link", { name: "ada@example.com" })
      .click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/users/ada%40example.com`);
  });

  test("a call sent over HTTP without a trace has no trace link; with a trace alone, it opens", async () => {
    const [first, second, third] = AI_CALLS;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("the fixtures changed");
    }
    installFakeApi({
      ai: {
        ...fakeAi(),
        calls: (query, users) => ({
          ...fakeAiCalls(query, users),
          calls: [
            { ...first, traceId: "", spanId: "" },
            { ...second, traceId: "", spanId: "" },
            { ...third, spanId: "" },
          ],
        }),
      },
    });
    const router = renderApp(AI);
    await expect.element(page.getByRole("table", { name: LATEST })).toBeVisible();
    expect(rowsOf(LATEST)).toHaveLength(3);
    const links = page.getByRole("table", { name: LATEST }).getByRole("link", {
      name: /^Open its trace/,
    });
    expect(links.elements()).toHaveLength(1);
    await links.click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/traces/${third.traceId}`);
    expect(router.state.location.search).toEqual({ at: third.at });
  });

  test("without the Users area, one line says why calls by user are hidden", async () => {
    const api = installFakeApi({ access: memberAccess({ ai: "view" }) });
    renderApp(AI);
    await expect.element(page.getByRole("table", { name: LATEST })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Calls by user need access to the Users area, which an admin can give you on the Members page.",
        ),
      )
      .toBeVisible();
    expect(page.getByRole("table", { name: /users whose calls cost the most/ }).elements()).toEqual(
      [],
    );
    // The latest calls leave the user out.
    expect(
      [...page.getByRole("table", { name: LATEST }).element().querySelectorAll("thead th")].map(
        (cell) => cell.textContent,
      ),
    ).not.toContain("User");
    expect(api.requests.some((request) => request.includes("/users"))).toBe(false);
  });

  test("the sidebar shows AI only with the AI area, apart from monitoring", async () => {
    installFakeApi({ access: memberAccess({ errors: "view", monitoring: "view" }) });
    renderApp(`/projects/${PROJECT.id}/errors`);
    await expect.element(projectMenu().getByRole("link", { name: "Traces" })).toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "AI", exact: true }))
      .not.toBeInTheDocument();

    unmountAll();
    installFakeApi({ access: memberAccess({ ai: "view" }) });
    renderApp(AI);
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "AI", exact: true }))
      .toBeVisible();
    expect(projectMenu().getByRole("link", { name: "Traces" }).elements()).toEqual([]);
  });

  test("without monitoring, the latest calls have no trace links", async () => {
    installFakeApi({ access: memberAccess({ ai: "view" }) });
    renderApp(AI);
    await expect.element(page.getByRole("table", { name: LATEST })).toBeVisible();
    expect(page.getByRole("link", { name: /Open its trace/ }).elements()).toEqual([]);
  });

  test("monitoring alone does not open the AI page", async () => {
    installFakeApi({ access: memberAccess({ monitoring: "view" }) });
    renderApp(AI);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
  });

  test("a page the member's areas leave out says so", async () => {
    installFakeApi({ access: memberAccess({ errors: "view" }) });
    renderApp(AI);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
  });
});

describe("the AI page's states", () => {
  test("a project that never sent a call: what is needed, the docs, and its settings", async () => {
    installFakeApi({ ai: { ...fakeAi(), report: noAiCalls } });
    renderApp(AI);
    await expect.element(page.getByText("No AI calls yet")).toBeVisible();
    await expect
      .element(
        page.getByText(
          /GenAI instrumentation for your model SDK, or send each call from your server over HTTP,/,
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "How to send AI calls (opens in a new tab)" }))
      .toHaveAttribute("href", "https://docs.ottertrail.app/monitoring/ai-usage/");
    await expect
      .element(page.getByRole("link", { name: "Project settings" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/settings?tab=server`);
    // Nothing that looks like data, and no filters to choose from.
    expect(document.querySelector("dl[aria-label=Figures]")).toBeNull();
    expect(page.getByRole("combobox", { name: "Model" }).elements()).toEqual([]);
  });

  test("a member who cannot change the project gets the docs alone", async () => {
    installFakeApi({
      access: memberAccess({ ai: "view" }),
      ai: { ...fakeAi(), report: noAiCalls },
    });
    renderApp(AI);
    await expect.element(page.getByText("No AI calls yet")).toBeVisible();
    expect(page.getByRole("link", { name: "Project settings" }).elements()).toEqual([]);
  });

  test("no call matches the filters: says so, without figures", async () => {
    installFakeApi({
      ai: {
        ...fakeAi(),
        report: (query, users): AiReport => ({
          ...noAiCalls(query, users),
          received: true,
        }),
      },
    });
    renderApp(`${AI}?model=gpt-5-mini`);
    await expect.element(page.getByText("No AI calls in this period")).toBeVisible();
    await expect
      .element(
        page.getByText("No call matches these filters. Clear a filter or choose a longer period."),
      )
      .toBeVisible();
    expect(document.querySelector("dl[aria-label=Figures]")).toBeNull();
  });

  test("loading shows skeletons, then the report", async () => {
    const held = deferred<AiReport>();
    installFakeApi({ ai: { ...fakeAi(), report: () => held.promise } });
    renderApp(AI);
    await expect.element(page.getByLabelText("Loading the AI report")).toBeVisible();
    held.resolve(fakeAiReport(new URLSearchParams(), true));
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    expect(page.getByLabelText("Loading the AI report").elements()).toEqual([]);
  });

  test("a failed load offers Retry", async () => {
    let fail = true;
    installFakeApi({
      ai: { ...fakeAi(), report: (query, users) => (fail ? busy() : fakeAiReport(query, users)) },
    });
    renderApp(AI);
    await expect.element(page.getByText("The AI report could not load")).toBeVisible();
    await expect.element(page.getByText("This took too long.")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
  });

  test("a failed chart or call list fails alone, and retries", async () => {
    let fail = true;
    installFakeApi({
      ai: {
        ...fakeAi(),
        chart: (query) => (fail ? busy() : fakeAiChart(query)),
        calls: (query, users) => (fail ? busy() : fakeAi().calls(query, users)),
      },
    });
    renderApp(AI);
    await expect.element(page.getByText("The chart could not load")).toBeVisible();
    await expect.element(page.getByText("The latest calls could not load")).toBeVisible();
    await expect.element(page.getByRole("table", { name: MODELS })).toBeVisible();
    fail = false;
    for (const button of page.getByRole("button", { name: "Retry" }).all()) {
      await button.click();
    }
    await expect.element(page.getByRole("table", { name: LATEST })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Estimated cost (USD)" })).toBeVisible();
  });
});
