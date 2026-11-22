import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { AI_MODELS, fakeAiModels, LONG_MODEL } from "./fake-ai-models.ts";
import { ADMIN_ACCESS, type FakeApi, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/**
 * Settings → AI models (features/settings/ai-models-tab.tsx): the table
 * with each price's source, the No price filter in the address, Edit
 * price from a date and for all calls, Price as another model, Add model,
 * Reset to built-in with its confirm, the loading and failed states, who
 * sees the tab, and the AI page's link to it. The API's side is
 * apps/api/tests/ai-models.test.ts.
 */

afterEach(async () => {
  await page.viewport(1280, 900);
});

const TAB = "/settings?tab=ai-models";
const TABLE = /^AI models, the most called/;
const panel = () => page.getByRole("tabpanel", { name: "AI models" });
const table = () => panel().getByRole("table", { name: TABLE });

const rowOf = (model: string) =>
  [...document.querySelectorAll<HTMLTableRowElement>("[role=tabpanel] tbody tr")].find(
    (row) => row.cells[0]?.textContent === model,
  );
const cellsOf = (model: string) => [...(rowOf(model)?.cells ?? [])].map((cell) => cell.textContent);
const shownModels = () =>
  [...document.querySelectorAll<HTMLTableRowElement>("[role=tabpanel] tbody tr")].map(
    (row) => row.cells[0]?.textContent,
  );

/** Opens a model's menu and picks an item. */
async function act(model: string, item: string) {
  await page.getByRole("button", { name: `Actions for ${model}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

const dialog = () => page.getByRole("dialog");
const lastChange = (api: FakeApi) => api.aiModels.changes.at(-1);

describe("the AI models tab", () => {
  test("lists every model with its prices, their source, calls, and whether it has a price", async () => {
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await expect
      .element(
        panel().getByText(
          "Prices are USD per million tokens. Changes apply to the AI page and AI cost alerts.",
        ),
      )
      .toBeVisible();
    expect(shownModels()).toEqual(AI_MODELS.models.map((model) => model.model));
    expect(cellsOf("claude-sonnet-4-6")).toEqual([
      "claude-sonnet-4-6",
      "anthropic",
      "$3.00",
      "$15.00",
      "$0.30",
      "$3.75",
      "Built-in, checked 22 Nov 2026",
      "12,000",
      "Priced",
      "",
    ]);
    expect(cellsOf("gpt-5-mini").slice(2, 6)).toEqual(["$0.25", "$2.00", "$0.025", "As input"]);
    expect(cellsOf("gpt-5-mini")[6]).toBe(
      "Built-in, checked 22 Nov 2026Covers gpt-5-mini and gpt-5-mini-2025-08-07Changes on 1 Dec 2026",
    );
    expect(cellsOf("llama-3.3-70b").slice(2, 7)).toEqual([
      "$0.00",
      "$0.00",
      "As input",
      "As input",
      "Custom, by Test Owner on 18 Nov 2026",
    ]);
    expect(cellsOf("claude-sonnet-eu-2026-10")[6]).toBe(
      "Price as claude-sonnet-4-6, on 18 Nov 2026",
    );
    expect(cellsOf("acme-support-ft-2026-10").slice(2, 9)).toEqual([
      "–No price",
      "–No price",
      "–No price",
      "–No price",
      "None",
      "90",
      "No price",
    ]);
  });

  test("a long model ID is cut off, with the whole of it in a tooltip", async () => {
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    const name = page.getByText(LONG_MODEL, { exact: true });
    const element = name.element() as HTMLElement;
    await expect.poll(() => element.getAttribute("tabindex")).toBe("0");
    await name.hover();
    await expect
      .poll(() => document.querySelector("[data-slot=tooltip-content]")?.textContent)
      .toBe(LONG_MODEL);
  });

  test("No price lists only the models without one, and is kept in the address", async () => {
    installFakeApi();
    const router = renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await panel().getByRole("button", { name: "No price (2)" }).click();
    await expect.poll(shownModels).toEqual(["acme-support-ft-2026-10", LONG_MODEL]);
    expect(currentPath(router)).toBe("/settings?tab=ai-models&show=no-price");
    await panel().getByRole("button", { name: "All models" }).click();
    await expect.poll(() => shownModels().length).toBe(AI_MODELS.models.length);
  });

  test("with every model priced, No price says so", async () => {
    installFakeApi({
      aiModels: fakeAiModels({
        list: {
          ...AI_MODELS,
          models: AI_MODELS.models.filter((model) => model.price !== null),
        },
      }),
    });
    renderApp(`${TAB}&show=no-price`);
    await expect.element(panel().getByText("Every model has a price")).toBeVisible();
  });

  test("Edit price from a date on: a price change, sent as the day", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await act("claude-sonnet-4-6", "Edit price");
    await expect
      .element(dialog().getByRole("heading", { name: "Edit the price of claude-sonnet-4-6" }))
      .toBeVisible();
    await expect.element(dialog().getByLabelText("Input", { exact: true })).toHaveValue("3");
    await expect
      .element(dialog().getByRole("radio", { name: "Calls from a date on" }))
      .toBeChecked();
    await dialog().getByLabelText("Input", { exact: true }).fill("2.5");
    await dialog().getByLabelText("From", { exact: true }).fill("2026-11-01");
    await dialog().getByRole("button", { name: "Save price" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(lastChange(api)).toEqual({
      path: "/api/settings/ai-models/price",
      body: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effectiveFrom: "2026-11-01",
        input: 2.5,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    });
    await expect
      .poll(() => cellsOf("claude-sonnet-4-6")[6])
      .toBe("Custom from 1 Nov 2026, by Test Owner on 20 Nov 2026");
  });

  test("Edit price for all calls: a correction; the fields are checked first", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await act("acme-support-ft-2026-10", "Edit price");
    await expect.element(dialog().getByRole("radio", { name: "All calls" })).toBeChecked();
    await dialog().getByLabelText("Input", { exact: true }).fill("-1");
    await dialog().getByLabelText("Output", { exact: true }).fill("0.1234567");
    await dialog().getByLabelText("Cache read", { exact: true }).fill("20000");
    await dialog().getByRole("button", { name: "Save price" }).click();
    await expect
      .element(dialog().getByText("Enter a number of 0 or more, such as 0.25."))
      .toBeVisible();
    await expect.element(dialog().getByText("Use at most 6 decimals.")).toBeVisible();
    await expect.element(dialog().getByText("Enter at most $10,000.00.")).toBeVisible();
    expect(api.aiModels.changes).toEqual([]);

    await dialog().getByLabelText("Input", { exact: true }).fill("1.5");
    await dialog().getByLabelText("Output", { exact: true }).fill("6");
    await dialog().getByLabelText("Cache read", { exact: true }).fill("");
    await dialog().getByRole("button", { name: "Save price" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(lastChange(api)?.body).toEqual({
      provider: "openai",
      model: "acme-support-ft-2026-10",
      effectiveFrom: null,
      input: 1.5,
      output: 6,
      cacheRead: null,
      cacheWrite: null,
    });
    await expect.poll(() => cellsOf("acme-support-ft-2026-10")[8]).toBe("Priced");
  });

  test("All calls says which dated prices and price as it replaces, and which IDs it covers", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await act("gpt-5-mini", "Edit price");
    await expect
      .element(
        dialog().getByText("USD per million tokens. Covers gpt-5-mini and gpt-5-mini-2025-08-07."),
      )
      .toBeVisible();
    await dialog().getByRole("radio", { name: "All calls" }).click();
    await expect
      .element(
        dialog().getByText(
          "A correction: past calls take it too. Replaces its dated price (from 1 Dec 2026).",
        ),
      )
      .toBeVisible();
    await dialog().getByRole("button", { name: "Save price" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(lastChange(api)?.body).toMatchObject({ model: "gpt-5-mini", effectiveFrom: null });

    await act("claude-sonnet-eu-2026-10", "Edit price");
    await expect
      .element(dialog().getByText("USD per million tokens. Covers only claude-sonnet-eu-2026-10."))
      .toBeVisible();
    await expect
      .element(
        dialog().getByText(
          "A correction: past calls take it too. Replaces its price as claude-sonnet-4-6.",
        ),
      )
      .toBeVisible();
  });

  test("without call counts, the prices still list and can be changed", async () => {
    installFakeApi({
      aiModels: fakeAiModels({
        list: {
          ...AI_MODELS,
          callsCounted: false,
          models: AI_MODELS.models.map((model) => ({ ...model, calls: null })),
        },
      }),
    });
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await expect
      .element(
        panel().getByText("Calls could not be counted right now. Prices can still be changed."),
      )
      .toBeVisible();
    expect(cellsOf("claude-sonnet-4-6")[7]).toBe("–Not counted");
    await act("claude-sonnet-4-6", "Edit price");
    await expect.element(dialog().getByRole("button", { name: "Save price" })).toBeVisible();
  });

  test("a refused save says why and keeps the dialog open", async () => {
    const api = installFakeApi();
    api.aiModels.refuseNext = new Response(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many price changes. Try again in 10 seconds.",
      }),
      { status: 429 },
    );
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await act("llama-3.3-70b", "Edit price");
    await dialog().getByRole("button", { name: "Save price" }).click();
    await expect
      .element(dialog().getByText("Too many price changes. Try again in 10 seconds."))
      .toBeVisible();
  });

  test("Price as another model: an unknown model takes a priced model's price", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    // A built-in model has its own price: no Price as.
    await page.getByRole("button", { name: "Actions for claude-sonnet-4-6", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: "Edit price" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Price as another model" }).elements()).toEqual([]);
    await userEvent.keyboard("{Escape}");

    await act(LONG_MODEL, "Price as another model");
    await dialog().getByRole("button", { name: "Save" }).click();
    await expect.element(dialog().getByText("Choose the model whose price to use.")).toBeVisible();
    await dialog().getByLabelText("Model", { exact: true }).fill("sonnet-4");
    await page.getByRole("option", { name: "claude-sonnet-4-6" }).click();
    await dialog().getByRole("button", { name: "Save" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(lastChange(api)).toEqual({
      path: "/api/settings/ai-models/price-as",
      body: {
        provider: "aws.bedrock",
        model: LONG_MODEL,
        priceAs: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    });
    await expect
      .poll(() => cellsOf(LONG_MODEL)[6])
      .toBe("Price as claude-sonnet-4-6, by Test Owner on 20 Nov 2026");
    expect(cellsOf(LONG_MODEL)[2]).toBe("$3.00");
  });

  test("Add model: a self-hosted model at $0; one already listed is refused", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await panel().getByRole("button", { name: "Add model" }).click();
    await expect.element(dialog().getByRole("heading", { name: "Add a model" })).toBeVisible();
    await dialog().getByLabelText("Provider").fill("vllm");
    await dialog().getByLabelText("Model ID").fill("llama-3.3-70b");
    await dialog().getByLabelText("Input", { exact: true }).fill("0");
    await dialog().getByLabelText("Output", { exact: true }).fill("0");
    await dialog().getByRole("button", { name: "Add model" }).click();
    await expect
      .element(dialog().getByText("This model is already in the table. Edit its price there."))
      .toBeVisible();
    await dialog().getByLabelText("Model ID").fill("Qwen3-32B");
    await dialog().getByRole("button", { name: "Add model" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(lastChange(api)?.body).toEqual({
      provider: "vllm",
      model: "Qwen3-32B",
      effectiveFrom: null,
      input: 0,
      output: 0,
      cacheRead: null,
      cacheWrite: null,
    });
    await expect.poll(() => cellsOf("qwen3-32b")[8]).toBe("Priced");
  });

  test("Reset to built-in asks first; Cancel changes nothing", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await act("gpt-5-mini", "Reset to built-in");
    await expect
      .element(dialog().getByRole("heading", { name: "Reset gpt-5-mini to built-in?" }))
      .toBeVisible();
    await expect
      .element(
        dialog().getByText(
          "This removes its custom prices. All its calls take the built-in price.",
        ),
      )
      .toBeVisible();
    await dialog().getByRole("button", { name: "Cancel" }).click();
    expect(api.aiModels.changes).toEqual([]);

    await act("gpt-5-mini", "Reset to built-in");
    await dialog().getByRole("button", { name: "Reset to built-in" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(lastChange(api)).toEqual({
      path: "/api/settings/ai-models/reset",
      body: { model: "gpt-5-mini" },
    });
    await expect
      .poll(() => cellsOf("gpt-5-mini")[6])
      .toBe("Built-in, checked 22 Nov 2026Covers gpt-5-mini and gpt-5-mini-2025-08-07");
    // Nothing custom left: no Reset.
    await page.getByRole("button", { name: "Actions for gpt-5-mini", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: "Edit price" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Reset to built-in" }).elements()).toEqual([]);
  });

  test("loading, then a failure with Retry", async () => {
    const api = installFakeApi({
      aiModels: fakeAiModels({
        list: new Response(
          JSON.stringify({
            error: "internal_error",
            message: "The reports could not be calculated. Try again.",
          }),
          { status: 500 },
        ),
      }),
    });
    renderApp(TAB);
    await expect.element(panel().getByText("The AI models could not load")).toBeVisible();
    api.aiModels.list = structuredClone(AI_MODELS);
    await panel().getByRole("button", { name: "Retry" }).click();
    await expect.element(table()).toBeVisible();
  });

  test("an admin sees the tab; a member does not get the list", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(TAB);
    await expect
      .element(page.getByRole("tab", { name: "AI models", selected: true }))
      .toBeVisible();
    await expect.element(table()).toBeVisible();
  });

  test("on a phone, the table scrolls inside itself with the model and the menu pinned", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const cells = rowOf("claude-sonnet-4-6")?.cells;
    expect(getComputedStyle(cells?.[0] as HTMLElement).position).toBe("sticky");
    expect(getComputedStyle(cells?.[cells.length - 1] as HTMLElement).position).toBe("sticky");
  });

  test("at 1440 wide, the table runs the page's width and fits without scrolling", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    const scroller = table().element().closest<HTMLElement>("[data-slot=table-container]");
    const content = document.querySelector("[data-slot=app-content]");
    expect(scroller?.scrollWidth).toBeLessThanOrEqual(scroller?.clientWidth ?? 0);
    // Past the 64rem a table section is held to.
    expect(scroller?.clientWidth).toBeGreaterThan(1024);
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
  });
});

describe("the AI page's no-price line", () => {
  test("links to the tab, filtered to No price, for the owner and admins", async () => {
    installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/ai`);
    const link = page.getByRole("link", { name: "Set prices in Settings" });
    await expect.element(link).toBeVisible();
    await link.click();
    await expect.poll(() => currentPath(router)).toBe("/settings?tab=ai-models&show=no-price");
    await expect.poll(shownModels).toEqual(["acme-support-ft-2026-10", LONG_MODEL]);
  });

  test("is plain text for a member", async () => {
    installFakeApi({ access: memberAccess({ monitoring: "view" }) });
    renderApp(`/projects/${PROJECT.id}/ai`);
    await expect
      .element(
        page.getByText("90 calls had no price and are not in the cost: acme-support-ft-2026-10."),
      )
      .toBeVisible();
    expect(page.getByRole("link", { name: "Set prices in Settings" }).elements()).toEqual([]);
  });
});
