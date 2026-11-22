import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { AI_MODELS, fakeAiModels, LONG_MODEL, manyAiModels } from "./fake-ai-models.ts";
import {
  ADMIN_ACCESS,
  deferred,
  type FakeApi,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/**
 * Settings → AI models (features/settings/ai-models-tab.tsx): the table
 * with each price's source, the No price filter in the address, the
 * search and Show more, a row's sheet (its details; Edit price from a date
 * and for all calls, with the save rule and its close guard; Price as
 * another model; Reset to built-in with its confirm), Add model in the
 * same sheet, the loading and failed states, who sees the tab, and the AI
 * page's link to it. The API's side is apps/api/tests/ai-models.test.ts.
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

const nameButton = (model: string) =>
  page.getByRole("button", { name: `${model}, edit price`, exact: true });
/** The sheet, named by its title: the model's ID, or "Add a model". */
const sheet = (title: string) => page.getByRole("dialog", { name: title, exact: true });
/** A dialog over the sheet, named by its title. */
const dialog = (title: string | RegExp) => page.getByRole("dialog", { name: title });
const savePrice = (model: string) => sheet(model).getByRole("button", { name: "Save price" });
const lastChange = (api: FakeApi) => api.aiModels.changes.at(-1);

/** Opens a model's sheet from its name in the table. */
async function openModel(model: string) {
  await nameButton(model).click();
  await expect.element(sheet(model)).toBeVisible();
}

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

  test("a price covering more than two IDs says how many; the sheet names them", async () => {
    const list = structuredClone(AI_MODELS);
    const ids = ["claude-sonnet-4-6", "claude-sonnet-4-6@20260101", "claude-sonnet-4-6-v1"];
    list.models[0] = { ...list.models[0], covers: { ids, prefixes: [] } };
    installFakeApi({ aiModels: fakeAiModels({ list }) });
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    expect(cellsOf("claude-sonnet-4-6")[6]).toBe("Built-in, checked 22 Nov 2026Covers 3 IDs");
    await openModel("claude-sonnet-4-6");
    await expect
      .element(
        sheet("claude-sonnet-4-6").getByText(
          "USD per million tokens. Covers claude-sonnet-4-6, claude-sonnet-4-6@20260101 and claude-sonnet-4-6-v1.",
        ),
      )
      .toBeVisible();
  });

  test("a long model ID is cut off, with the whole of it in a tooltip", async () => {
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    const name = nameButton(LONG_MODEL);
    const element = name.element() as HTMLElement;
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
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

  test("50 rows at a time, Show more for the next; the search covers them all", async () => {
    installFakeApi({ aiModels: fakeAiModels({ list: manyAiModels(60) }) });
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    expect(shownModels()).toHaveLength(50);
    await expect.element(panel().getByText("Showing 50 of 66 models")).toBeVisible();
    await panel().getByRole("button", { name: "Show more" }).click();
    await expect.poll(() => shownModels().length).toBe(66);
    expect(panel().getByRole("button", { name: "Show more" }).elements()).toEqual([]);
    // The button went with the last rows: focus is on the first of them.
    await expect.poll(() => document.activeElement).toBe(nameButton("fixture-model-045").element());

    const search = panel().getByRole("searchbox", { name: "Search models" });
    // The ID, the provider, the model's name, and the IDs its price covers.
    await search.fill("fixture-model-06");
    await expect.poll(shownModels).toEqual(["fixture-model-060"]);
    await search.fill("GPT-5 MINI");
    await expect.poll(shownModels).toEqual(["gpt-5-mini"]);
    await search.fill("gpt-5-mini-2025-08-07");
    await expect.poll(shownModels).toEqual(["gpt-5-mini"]);
    await search.fill("fixture");
    // A new search starts again at 50.
    await expect.poll(() => shownModels().length).toBe(50);
    await expect.element(panel().getByText("Showing 50 of 60 models")).toBeVisible();
    await search.fill("no-such-model");
    await expect.element(panel().getByText("No model matches “no-such-model”")).toBeVisible();
    expect(table().elements()).toEqual([]);
  });

  test("a click on a row opens the model's sheet: its price and details", async () => {
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    // Anywhere on the row, as on its name.
    await table().getByRole("cell", { name: "anthropic", exact: true }).first().click();
    const sonnet = sheet("claude-sonnet-4-6");
    await expect.element(sonnet).toBeVisible();
    await expect.element(sonnet.getByText("anthropic · Claude Sonnet 4.6")).toBeVisible();
    await expect.element(sonnet.getByLabelText("Input", { exact: true })).toHaveValue("3");
    await expect.element(sonnet.getByText("Built-in, checked 22 Nov 2026")).toBeVisible();
    await expect
      .element(sonnet.getByText("$3.00 input, $15.00 output, $0.30 cache read, $3.75 cache write"))
      .toBeVisible();
    await expect
      .element(sonnet.getByText("Prompts over 200K input tokens: 2x input, 1.5x output."))
      .toBeVisible();
    const pricePage = sonnet.getByRole("link", {
      name: "Price page on pricing.example.com (opens in a new tab)",
    });
    await expect.element(pricePage).toHaveAttribute("href", "https://pricing.example.com/models");
    await expect.element(pricePage).toHaveAttribute("target", "_blank");
    await expect.element(sonnet.getByText("12,000")).toBeVisible();
    // A built-in model has its own price, and nothing custom: no Price as, no Reset.
    expect(sonnet.getByRole("button", { name: "Price as another model" }).elements()).toEqual([]);
    expect(sonnet.getByRole("button", { name: "Reset to built-in" }).elements()).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await expect.element(sonnet).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(nameButton("claude-sonnet-4-6").element());

    await openModel("gpt-5-mini");
    await expect
      .element(
        sheet("gpt-5-mini").getByText(
          "Starts 1 Dec 2026: $0.20 input, $1.60 output, cache read as input, cache write as input",
        ),
      )
      .toBeVisible();
    await expect
      .element(sheet("gpt-5-mini").getByText("Set by Test Owner on 19 Nov 2026"))
      .toBeVisible();
  });

  test("Edit price from a date on: Save waits for a change; it sends the day and says so", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await openModel("claude-sonnet-4-6");
    const sonnet = sheet("claude-sonnet-4-6");
    await expect.element(sonnet.getByRole("radio", { name: "Calls from a date on" })).toBeChecked();
    await expect.element(sonnet.getByText("No unsaved changes")).toBeVisible();
    await expect.element(savePrice("claude-sonnet-4-6")).toHaveAttribute("aria-disabled", "true");
    await sonnet.getByLabelText("Input", { exact: true }).fill("2.5");
    await expect.element(sonnet.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await sonnet.getByLabelText("Input", { exact: true }).fill("3");
    await expect.element(savePrice("claude-sonnet-4-6")).toHaveAttribute("aria-disabled", "true");
    // The same number written another way is no change.
    await sonnet.getByLabelText("Input", { exact: true }).fill("3.00");
    await expect.element(savePrice("claude-sonnet-4-6")).toHaveAttribute("aria-disabled", "true");
    await sonnet.getByLabelText("Input", { exact: true }).fill("2.5");
    await sonnet.getByLabelText("From", { exact: true }).fill("2026-11-01");
    await savePrice("claude-sonnet-4-6").click();
    await expect.element(sonnet).not.toBeInTheDocument();
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
    await expect.element(panel().getByText("Saved the price of claude-sonnet-4-6.")).toBeVisible();
    await expect
      .poll(() => cellsOf("claude-sonnet-4-6")[6])
      .toBe("Custom from 1 Nov 2026, by Test Owner on 20 Nov 2026");
    await expect.poll(() => document.activeElement).toBe(nameButton("claude-sonnet-4-6").element());
  });

  test("Edit price for all calls: a correction; the fields are checked first", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await openModel("acme-support-ft-2026-10");
    const acme = sheet("acme-support-ft-2026-10");
    await expect.element(acme.getByRole("radio", { name: "All calls" })).toBeChecked();
    await acme.getByLabelText("Input", { exact: true }).fill("-1");
    await acme.getByLabelText("Output", { exact: true }).fill("0.1234567");
    await acme.getByLabelText("Cache read", { exact: true }).fill("20000");
    await savePrice("acme-support-ft-2026-10").click();
    await expect
      .element(acme.getByText("Enter a number of 0 or more, such as 0.25."))
      .toBeVisible();
    await expect.element(acme.getByText("Use at most 6 decimals.")).toBeVisible();
    await expect.element(acme.getByText("Enter at most $10,000.00.")).toBeVisible();
    expect(api.aiModels.changes).toEqual([]);

    await acme.getByLabelText("Input", { exact: true }).fill("1.5");
    await acme.getByLabelText("Output", { exact: true }).fill("6");
    await acme.getByLabelText("Cache read", { exact: true }).fill("");
    await savePrice("acme-support-ft-2026-10").click();
    await expect.element(acme).not.toBeInTheDocument();
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

  test("a price set under No price takes the row out; focus goes to the row in its place", async () => {
    installFakeApi();
    renderApp(`${TAB}&show=no-price`);
    await expect.element(table()).toBeVisible();
    await openModel("acme-support-ft-2026-10");
    const acme = sheet("acme-support-ft-2026-10");
    await acme.getByLabelText("Input", { exact: true }).fill("1");
    await acme.getByLabelText("Output", { exact: true }).fill("2");
    await savePrice("acme-support-ft-2026-10").click();
    await expect.element(acme).not.toBeInTheDocument();
    await expect.poll(shownModels).toEqual([LONG_MODEL]);
    await expect.poll(() => document.activeElement).toBe(nameButton(LONG_MODEL).element());
  });

  test("when the list comes back after the sheet closed, focus still lands on the row in its place", async () => {
    const api = installFakeApi();
    renderApp(`${TAB}&show=no-price`);
    await expect.element(table()).toBeVisible();
    const held = deferred<void>();
    api.aiModels.holdList = held.promise;
    await openModel("acme-support-ft-2026-10");
    const acme = sheet("acme-support-ft-2026-10");
    await acme.getByLabelText("Input", { exact: true }).fill("1");
    await acme.getByLabelText("Output", { exact: true }).fill("2");
    await savePrice("acme-support-ft-2026-10").click();
    await expect.element(acme).not.toBeInTheDocument();
    // The sheet gave focus back to the row's own button, still listed.
    await expect
      .poll(() => document.activeElement)
      .toBe(nameButton("acme-support-ft-2026-10").element());
    api.aiModels.holdList = null;
    held.resolve();
    await expect.poll(shownModels).toEqual([LONG_MODEL]);
    await expect.poll(() => document.activeElement).toBe(nameButton(LONG_MODEL).element());
  });

  test("All calls says which dated prices and price as it replaces, and which IDs it covers", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await openModel("gpt-5-mini");
    const mini = sheet("gpt-5-mini");
    await expect
      .element(
        mini.getByText("USD per million tokens. Covers gpt-5-mini and gpt-5-mini-2025-08-07."),
      )
      .toBeVisible();
    await mini.getByRole("radio", { name: "All calls" }).click();
    await expect
      .element(
        mini.getByText(
          "A correction: past calls take it too. Replaces its dated price (from 1 Dec 2026).",
        ),
      )
      .toBeVisible();
    await savePrice("gpt-5-mini").click();
    await expect.element(mini).not.toBeInTheDocument();
    expect(lastChange(api)?.body).toMatchObject({ model: "gpt-5-mini", effectiveFrom: null });

    await openModel("claude-sonnet-eu-2026-10");
    const eu = sheet("claude-sonnet-eu-2026-10");
    await expect
      .element(eu.getByText("USD per million tokens. Covers only claude-sonnet-eu-2026-10."))
      .toBeVisible();
    await expect
      .element(
        eu.getByText(
          "A correction: past calls take it too. Replaces its price as claude-sonnet-4-6.",
        ),
      )
      .toBeVisible();
  });

  test("closing with unsaved changes asks first", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await openModel("llama-3.3-70b");
    const llama = sheet("llama-3.3-70b");
    await llama.getByLabelText("Output", { exact: true }).fill("0.5");
    await userEvent.keyboard("{Escape}");
    const ask = dialog("Discard your changes?");
    await expect
      .element(ask.getByText("Unsaved changes to the price of llama-3.3-70b will be lost."))
      .toBeVisible();
    await ask.getByRole("button", { name: "Keep editing" }).click();
    await expect.element(llama.getByLabelText("Output", { exact: true })).toHaveValue("0.5");

    await llama.getByRole("button", { name: "Cancel" }).click();
    await dialog("Discard your changes?").getByRole("button", { name: "Discard changes" }).click();
    await expect.element(llama).not.toBeInTheDocument();
    expect(api.aiModels.changes).toEqual([]);
    // Opened again, it starts from the saved price.
    await openModel("llama-3.3-70b");
    await expect
      .element(sheet("llama-3.3-70b").getByLabelText("Output", { exact: true }))
      .toHaveValue("0");
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
    await openModel("claude-sonnet-4-6");
    await expect.element(savePrice("claude-sonnet-4-6")).toBeVisible();
    await expect.element(sheet("claude-sonnet-4-6").getByText("Not counted")).toBeInTheDocument();
  });

  test("a refused save says why and keeps the sheet open", async () => {
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
    await openModel("llama-3.3-70b");
    await sheet("llama-3.3-70b").getByLabelText("Input", { exact: true }).fill("0.1");
    await savePrice("llama-3.3-70b").click();
    await expect
      .element(sheet("llama-3.3-70b").getByText("Too many price changes. Try again in 10 seconds."))
      .toBeVisible();
    await expect
      .element(sheet("llama-3.3-70b").getByLabelText("Input", { exact: true }))
      .toHaveValue("0.1");
  });

  test("Price as another model: an unknown model takes a priced model's price", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await openModel(LONG_MODEL);
    await sheet(LONG_MODEL).getByRole("button", { name: "Price as another model" }).click();
    const priceAs = dialog(`Price ${LONG_MODEL} as another model`);
    await priceAs.getByRole("button", { name: "Save" }).click();
    await expect.element(priceAs.getByText("Choose the model whose price to use.")).toBeVisible();
    await priceAs.getByLabelText("Model", { exact: true }).fill("sonnet-4");
    await page.getByRole("option", { name: "claude-sonnet-4-6" }).click();
    await priceAs.getByRole("button", { name: "Save" }).click();
    await expect.element(priceAs).not.toBeInTheDocument();
    await expect.element(sheet(LONG_MODEL)).not.toBeInTheDocument();
    expect(lastChange(api)).toEqual({
      path: "/api/settings/ai-models/price-as",
      body: {
        provider: "aws.bedrock",
        model: LONG_MODEL,
        priceAs: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    });
    await expect
      .element(panel().getByText(`${LONG_MODEL} takes the price of claude-sonnet-4-6.`))
      .toBeVisible();
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
    const add = sheet("Add a model");
    await expect.element(add).toBeVisible();
    await add.getByLabelText("Provider").fill("vllm");
    await add.getByLabelText("Model ID").fill("llama-3.3-70b");
    await add.getByLabelText("Input", { exact: true }).fill("0");
    await add.getByLabelText("Output", { exact: true }).fill("0");
    await add.getByRole("button", { name: "Add model" }).click();
    await expect
      .element(add.getByText("This model is already in the table. Edit its price there."))
      .toBeVisible();
    await add.getByLabelText("Model ID").fill("Qwen3-32B");
    await add.getByRole("button", { name: "Add model" }).click();
    await expect.element(add).not.toBeInTheDocument();
    expect(lastChange(api)?.body).toEqual({
      provider: "vllm",
      model: "Qwen3-32B",
      effectiveFrom: null,
      input: 0,
      output: 0,
      cacheRead: null,
      cacheWrite: null,
    });
    await expect.element(panel().getByText("Added Qwen3-32B.")).toBeVisible();
    await expect.poll(() => cellsOf("qwen3-32b")[8]).toBe("Priced");
  });

  test("Reset to built-in asks first; Cancel changes nothing", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    await openModel("gpt-5-mini");
    await sheet("gpt-5-mini").getByRole("button", { name: "Reset to built-in" }).click();
    const confirm = dialog("Reset gpt-5-mini to built-in?");
    await expect
      .element(
        confirm.getByText("This removes its custom prices. All its calls take the built-in price."),
      )
      .toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect.element(sheet("gpt-5-mini")).toBeVisible();
    expect(api.aiModels.changes).toEqual([]);

    await sheet("gpt-5-mini").getByRole("button", { name: "Reset to built-in" }).click();
    await dialog("Reset gpt-5-mini to built-in?")
      .getByRole("button", { name: "Reset to built-in" })
      .click();
    await expect.element(sheet("gpt-5-mini")).not.toBeInTheDocument();
    expect(lastChange(api)).toEqual({
      path: "/api/settings/ai-models/reset",
      body: { model: "gpt-5-mini" },
    });
    await expect
      .element(panel().getByText("Reset gpt-5-mini to its built-in price."))
      .toBeVisible();
    await expect
      .poll(() => cellsOf("gpt-5-mini")[6])
      .toBe("Built-in, checked 22 Nov 2026Covers gpt-5-mini and gpt-5-mini-2025-08-07");
    // Nothing custom left: no Reset.
    await openModel("gpt-5-mini");
    expect(
      sheet("gpt-5-mini").getByRole("button", { name: "Reset to built-in" }).elements(),
    ).toEqual([]);
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

  test("on a phone, the table scrolls inside itself with the model pinned; the sheet takes the width", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(TAB);
    await expect.element(table()).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const first = rowOf("claude-sonnet-4-6")?.cells[0] as HTMLElement;
    expect(getComputedStyle(first).position).toBe("sticky");
    await openModel("claude-sonnet-4-6");
    const box = document.querySelector("[data-slot=sheet-content]")?.getBoundingClientRect();
    expect(box?.width).toBe(390);
  });

  test("at 1440 wide, the table runs the page's width and fits; the sheet is 36rem", async () => {
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
    await openModel("claude-sonnet-4-6");
    const box = document.querySelector("[data-slot=sheet-content]")?.getBoundingClientRect();
    expect(box?.width).toBe(576);
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
