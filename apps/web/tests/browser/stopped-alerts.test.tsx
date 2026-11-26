import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { Rule } from "../../src/lib/alerts-api.ts";
import { fakeAlerts, fakeChannels, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * "Data stops arriving" rules in the dashboard (docs/uptime-alerts.md): one kind in the form,
 * whose source picks the API's kind, the fields each source takes, checked as the API checks
 * them, the body they send, the rule's row, and the sources each member is offered.
 */

const ALERTS = `/projects/${PROJECT.id}/alerts`;
const RULES_PATH = `/api/projects/${PROJECT.id}/alert-rules`;
const CHANNELS = fakeChannels();
const [EMAIL] = CHANNELS.list;
if (EMAIL === undefined) throw new Error("the fixtures changed");

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

async function choose(scope: ReturnType<typeof dialog>, combobox: string, option: string) {
  await scope.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** The options a select offers, once opened. */
async function optionsOf(scope: ReturnType<typeof dialog>, combobox: string): Promise<string[]> {
  await scope.getByRole("combobox", { name: combobox }).click();
  const listbox = page.getByRole("listbox");
  await expect.element(listbox).toBeVisible();
  const options = listbox
    .getByRole("option")
    .elements()
    .map((option) => option.textContent);
  await userEvent.keyboard("{Escape}");
  return options;
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

describe("the rule form's data stops arriving", () => {
  test("events: one item, an hour by default, suggests event names, and sends its settings", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Data stops arriving");
    await expect
      .element(form.getByText(/Choose a window that the quietest hours fill/))
      .toBeVisible();
    await expect
      .element(form.getByRole("combobox", { name: "Data" }))
      .toMatchTextContent(/^Events/);
    await expect
      .element(form.getByRole("combobox", { name: "In the last" }))
      .toMatchTextContent(/^1 hour/);
    await expect.element(form.getByLabelText("Fewer than (records)")).toHaveValue("1");
    // Pageviews, then the product events of the last 7 days.
    await expect
      .poll(() => suggestionsOf("Event name (optional)"))
      .toEqual(["pageview", "signup", "purchase", "invite_sent"]);

    await form.getByLabelText("Fewer than (records)").fill("0");
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(form.getByText("Enter a whole number of records from 1 to 1,000,000."))
      .toBeVisible();
    expect(api.bodies).toEqual([]);

    await form.getByLabelText("Fewer than (records)").fill("5");
    await form.getByLabelText("Event name (optional)").fill("signup");
    await choose(form, "In the last", "30 minutes");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: RULES_PATH,
      body: {
        name: "",
        kind: "events_stopped",
        settings: {
          source: "events",
          environment: null,
          windowMinutes: 30,
          minCount: 5,
          eventName: "signup",
        },
        channelIds: [EMAIL.id],
      },
    });
    await expect
      .element(
        page.getByText("Fewer than 5 events named signup arrive in 30 minutes, in production"),
      )
      .toBeVisible();
  });

  test("telemetry: the source picks the kind and its fields; a metric is required", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Data stops arriving");
    await choose(form, "Data", "Traces");
    expect(form.getByLabelText("Event name (optional)").elements()).toEqual([]);
    await expect.poll(() => suggestionsOf("Service (optional)")).toEqual(["web", "billing"]);

    await choose(form, "Data", "Metrics");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form.getByText("Choose or enter the metric's name.")).toBeVisible();
    expect(api.bodies).toEqual([]);
    await expect.poll(() => suggestionsOf("Host (optional)")).toEqual(["db-1", "web-1"]);
    await form.getByLabelText("Metric").fill("process.memory.usage");
    await form.getByLabelText("Host (optional)").fill("web-1");
    await choose(form, "In the last", "24 hours");
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toEqual({
      name: "",
      kind: "telemetry_stopped",
      settings: {
        source: "metrics",
        environment: null,
        windowMinutes: 1440,
        minCount: 1,
        metric: "process.memory.usage",
        host: "web-1",
      },
      channelIds: [EMAIL.id],
    });
    await expect
      .element(
        page.getByText(
          "No points of the metric process.memory.usage on the host web-1 arrive in 24 hours, in production",
        ),
      )
      .toBeVisible();
  });

  test("a rule's row and its edit form", async () => {
    const alerts = fakeAlerts();
    installFakeApi({
      alerts: {
        ...alerts,
        rules: [
          ruleOf({
            id: "5a5a5a5a-5a5a-4a5a-8a5a-000000000001",
            name: "Worker logs",
            kind: "telemetry_stopped",
            settings: {
              source: "logs",
              environment: "production",
              eventName: null,
              service: "worker",
              metric: null,
              host: null,
              windowMinutes: 120,
              minCount: 1,
            },
          }),
        ],
      },
    });
    renderApp(ALERTS);
    await expect
      .element(
        page.getByText("No log records of the service worker arrive in 2 hours, in production"),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Edit Worker logs" }).click();
    const form = dialog("Edit “Worker logs”");
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Data stops arriving/);
    await expect.element(form.getByRole("combobox", { name: "Data" })).toMatchTextContent(/^Logs/);
    await expect.element(form.getByLabelText("Service (optional)")).toHaveValue("worker");
    await expect
      .element(form.getByRole("combobox", { name: "In the last" }))
      .toMatchTextContent(/^2 hours/);
  });
});

describe("who is offered which data", () => {
  test("web analytics alone: events only", async () => {
    installFakeApi({ access: memberAccess({ uptime_alerts: "manage", web_analytics: "view" }) });
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Data stops arriving");
    expect(await optionsOf(form, "Data")).toEqual(["Events"]);
  });

  test("monitoring alone: traces, logs, and metrics, and the kind starts on traces", async () => {
    installFakeApi({ access: memberAccess({ uptime_alerts: "manage", monitoring: "view" }) });
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Data stops arriving");
    await expect
      .element(form.getByRole("combobox", { name: "Data" }))
      .toMatchTextContent(/^Traces/);
    expect(await optionsOf(form, "Data")).toEqual(["Traces", "Logs", "Metrics"]);
  });

  test("neither: not offered", async () => {
    installFakeApi({ access: memberAccess({ uptime_alerts: "manage", errors: "view" }) });
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    await dialog("Add an alert rule").getByRole("combobox", { name: "When" }).click();
    await expect.element(page.getByRole("option", { name: "New error" })).toBeVisible();
    expect(page.getByRole("option", { name: "Data stops arriving" }).elements()).toEqual([]);
  });
});
