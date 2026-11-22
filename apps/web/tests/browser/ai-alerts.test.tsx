import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { Rule } from "../../src/lib/alerts-api.ts";
import { fakeChannels, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { fakeNotifications } from "./fake-notifications.ts";
import { renderApp } from "./render.tsx";

/**
 * The AI alert rules in the dashboard (docs/ai-usage.md, "Alerts"): the
 * form's fields for AI cost and AI failures, checked as the API checks
 * them, the body they send, how the rule list says what they watch, and
 * the labels and icons of their notifications.
 */

const ALERTS = `/projects/${PROJECT.id}/alerts`;
const RULES_PATH = `/api/projects/${PROJECT.id}/alert-rules`;
const CHANNELS = fakeChannels();
const [EMAIL, WEBHOOK] = CHANNELS.list;
if (EMAIL === undefined || WEBHOOK === undefined) throw new Error("the fixtures changed");

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

async function choose(scope: ReturnType<typeof dialog>, combobox: string, option: string) {
  await scope.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** The suggestions a text field offers: its datalist's options. */
function suggestionsOf(label: string): string[] {
  const field = [...document.querySelectorAll("label")].find(
    (element) => element.textContent === label,
  );
  const input = document.getElementById(field?.htmlFor ?? "");
  const list = input instanceof HTMLInputElement ? input.list : null;
  return [...(list?.options ?? [])].map((option) => option.value);
}

/** A rule as the API answers it, with what differs. */
const ruleOf = (rule: Pick<Rule, "id" | "name" | "kind" | "settings">): Rule => ({
  ...rule,
  channelIds: [EMAIL.id],
  enabled: true,
  disabledReason: null,
  evaluationError: null,
  firing: 0,
  lastFiredAt: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
});

describe("the rule form's AI kinds", () => {
  test("AI cost: checks the amount, suggests models and features, and sends its settings", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "AI cost");
    await expect
      .element(form.getByText(/The cost is an estimate from token counts at list prices/))
      .toBeVisible();
    // The cost rule has no window in minutes: its own windows instead.
    expect(form.getByLabelText("In the last (minutes)").elements()).toEqual([]);
    await expect
      .element(form.getByRole("combobox", { name: "Over" }))
      .toMatchTextContent(/^The last 24 hours/);

    await form.getByLabelText("Estimated cost above (US dollars)").fill("0");
    await form.getByLabelText("Model (optional)").fill("m".repeat(101));
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(
        form.getByText(
          "Enter an amount in US dollars above 0 and at most 1,000,000,000, such as 50 or 2.5.",
        ),
      )
      .toBeVisible();
    await expect.element(form.getByText("A model has at most 100 characters.")).toBeVisible();
    await expect.element(form.getByText("Choose at least one channel.")).toBeVisible();
    await form.getByLabelText("Estimated cost above (US dollars)").fill("abc");
    await expect.element(form.getByText(/Enter an amount in US dollars above 0/)).toBeVisible();
    expect(api.bodies).toEqual([]);

    // The models and features of the last 7 days; calls without a feature cannot be named.
    await expect
      .poll(() => suggestionsOf("Model (optional)"))
      .toEqual([
        "claude-sonnet-4-6",
        "gpt-5-mini",
        "text-embedding-3-small",
        "acme-support-ft-2026-10",
      ]);
    expect(suggestionsOf("Feature (optional)")).toEqual([
      "support-chat",
      "summarize-ticket",
      "search-index",
    ]);
    await form.getByLabelText("Estimated cost above (US dollars)").fill("25.5");
    await form.getByLabelText("Model (optional)").fill("claude-sonnet-4-6");
    await form.getByLabelText("Feature (optional)").fill("support-chat");
    await choose(form, "Over", "The month to date");
    await expect
      .element(form.getByText("From midnight on the 1st, in the instance's timezone."))
      .toBeVisible();
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: RULES_PATH,
      body: {
        name: "",
        kind: "ai_cost",
        settings: {
          environment: null,
          model: "claude-sonnet-4-6",
          feature: "support-chat",
          costWindow: "month",
          thresholdUsd: 25.5,
        },
        channelIds: [EMAIL.id],
      },
    });
    await expect
      .element(
        page.getByText(
          "The estimated cost of AI calls of the model claude-sonnet-4-6 in the feature support-chat is above $25.50 over the month to date, in production",
        ),
      )
      .toBeVisible();
  });

  test("AI failures: checks the share, the window, and the fewest calls, and sends its settings", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "AI failures");
    await expect
      .element(form.getByText(/Windows below the minimum call count do not trigger/))
      .toBeVisible();
    await expect.element(form.getByLabelText("At least (calls)")).toHaveValue("20");
    await expect.element(form.getByLabelText("In the last (minutes)")).toHaveValue("10");

    await form.getByLabelText("Failed above (percent)").fill("100");
    await form.getByLabelText("In the last (minutes)").fill("61");
    await form.getByLabelText("At least (calls)").fill("0");
    await form.getByLabelText("Environment").fill("not an environment");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(form.getByText("Enter a share from 0 to just under 100 percent."))
      .toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of minutes from 5 to 60."))
      .toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of calls from 1 to 1,000,000."))
      .toBeVisible();
    await expect.element(form.getByText(/An environment has 1 to 64 letters/)).toBeVisible();
    expect(api.bodies).toEqual([]);

    await form.getByLabelText("Failed above (percent)").fill("5");
    await form.getByLabelText("In the last (minutes)").fill("60");
    await form.getByLabelText("At least (calls)").fill("50");
    await form.getByLabelText("Environment").fill("staging");
    await form.getByLabelText("Name (optional)").fill("Chat failing");
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toEqual({
      name: "Chat failing",
      kind: "ai_failures",
      settings: {
        environment: "staging",
        model: null,
        feature: null,
        windowMinutes: 60,
        thresholdPercent: 5,
        minCalls: 50,
      },
      channelIds: [EMAIL.id],
    });
    await expect
      .element(
        page.getByText(
          "More than 5% of AI calls fail over 60 minutes, with at least 50 calls, in staging",
        ),
      )
      .toBeVisible();
  });

  test("the rule list says what each AI rule watches, and editing one shows its settings", async () => {
    installFakeApi({
      alerts: {
        rules: [
          ruleOf({
            id: "abababab-abab-4bab-8bab-0000000000a1",
            name: "Support chat budget",
            kind: "ai_cost",
            settings: {
              environment: "production",
              model: null,
              feature: "support-chat",
              costWindow: "1h",
              thresholdUsd: 2,
            },
          }),
          ruleOf({
            id: "abababab-abab-4bab-8bab-0000000000a2",
            name: "Model failures",
            kind: "ai_failures",
            settings: {
              environment: "production",
              model: "gpt-5-mini",
              feature: null,
              windowMinutes: 15,
              thresholdPercent: 2.5,
              minCalls: 20,
            },
          }),
        ],
        firing: [],
        history: [],
      },
    });
    renderApp(ALERTS);
    await expect
      .element(
        page.getByText(
          "The estimated cost of AI calls in the feature support-chat is above $2.00 over the last hour, in production",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "More than 2.5% of AI calls of the model gpt-5-mini fail over 15 minutes, with at least 20 calls, in production",
        ),
      )
      .toBeVisible();

    await page.getByRole("button", { name: "Edit Support chat budget" }).click();
    const form = dialog("Edit “Support chat budget”");
    await expect.element(form.getByLabelText("Estimated cost above (US dollars)")).toHaveValue("2");
    await expect.element(form.getByLabelText("Feature (optional)")).toHaveValue("support-chat");
    await expect
      .element(form.getByRole("combobox", { name: "Over" }))
      .toMatchTextContent(/^The last hour/);
  });

  test("a member without Monitoring is not offered the AI kinds", async () => {
    installFakeApi({ access: memberAccess({ uptime_alerts: "manage" }) });
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    await dialog("Add an alert rule").getByRole("combobox", { name: "When" }).click();
    await expect.element(page.getByRole("option", { name: "Check down" })).toBeVisible();
    expect(page.getByRole("option", { name: "AI cost" }).elements()).toEqual([]);
    expect(page.getByRole("option", { name: "AI failures" }).elements()).toEqual([]);
  });
});

describe("AI notifications", () => {
  test("a channel's deliveries name the AI events", async () => {
    const [first] = CHANNELS.deliveries[WEBHOOK.id] ?? [];
    if (first === undefined) throw new Error("the fixtures changed");
    installFakeApi({
      channels: {
        ...CHANNELS,
        deliveries: {
          ...CHANNELS.deliveries,
          [WEBHOOK.id]: [
            { ...first, id: "ai-1", type: "ai.cost", status: "sent", lastError: null },
            { ...first, id: "ai-2", type: "ai.cost_resolved", status: "sent", lastError: null },
            { ...first, id: "ai-3", type: "ai.failures", status: "sent", lastError: null },
            { ...first, id: "ai-4", type: "ai.failures_resolved", status: "sent", lastError: null },
          ],
        },
      },
    });
    renderApp("/settings?tab=channels");
    await page.getByRole("button", { name: `Deliveries to ${WEBHOOK.name}` }).click();
    const table = page.getByRole("table", {
      name: `Deliveries to ${WEBHOOK.name} in the last 30 days, newest first`,
    });
    await expect.element(table).toBeVisible();
    expect(
      [...table.element().querySelectorAll("tbody tr")].map((row) => row.children[1]?.textContent),
    ).toEqual(["AI cost", "AI cost back under", "AI failures", "AI failures over"]);
  });

  test("the inbox marks AI alerts with their own icon, and their recovery as fine again", async () => {
    const notifications = fakeNotifications();
    const [item] = notifications.items;
    if (item === undefined) throw new Error("the fixtures changed");
    installFakeApi({
      notifications: {
        ...notifications,
        items: [
          { ...item, id: "ai-1", kind: "ai.cost", title: "AI cost over limit: Chat budget" },
          {
            ...item,
            id: "ai-2",
            kind: "ai.failures_resolved",
            title: "AI failures normal: Model failures",
          },
        ],
      },
    });
    renderApp("/notifications");
    await expect.element(page.getByText("AI cost over limit: Chat budget")).toBeVisible();
    const icons = [...document.querySelectorAll("main li")].map((entry) => {
      const icon = entry.querySelector("svg");
      return [
        icon?.classList.contains("lucide-sparkles"),
        icon?.classList.contains("text-warning"),
      ];
    });
    expect(icons).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});
