import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { Rule } from "../../src/lib/alerts-api.ts";
import { fakeAlerts, fakeChannels, fakeLogs, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * "Log lines match" rules in the dashboard (docs/uptime-alerts.md): the Add rule dialog's
 * fields, defaults, and checks, the body it sends, the rule's row and edit form, and the Logs
 * page opened from an alert's link with the rule's filters and time window.
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

describe("the rule form's log lines", () => {
  test("defaults to any line of Error or above in 5 minutes, checks, and sends its settings", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Log lines match");
    await expect.element(form.getByText(/Lines match as on the Logs page/)).toBeVisible();
    await expect
      .element(form.getByRole("combobox", { name: "Minimum severity" }))
      .toMatchTextContent(/^Error and above/);
    await expect.element(form.getByLabelText("More than (lines)")).toHaveValue("0");
    await expect.element(form.getByLabelText("In the last (minutes)")).toHaveValue("5");
    // The services the dialog suggests for route rules: the last day's.
    await expect.poll(() => suggestionsOf("Service (optional)")).toEqual(["web", "billing"]);

    await form.getByLabelText("More than (lines)").fill("-1");
    await form.getByLabelText("Words in the message (optional)").fill("a b c d e f g h i");
    await form.getByLabelText("In the last (minutes)").fill("61");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(form.getByText("Enter a whole number of lines from 0 to 1,000,000."))
      .toBeVisible();
    await expect.element(form.getByText("Enter at most 8 words, in 200 characters.")).toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of minutes from 5 to 60."))
      .toBeVisible();
    expect(api.bodies).toEqual([]);

    await form.getByLabelText("More than (lines)").fill("3");
    await form.getByLabelText("Words in the message (optional)").fill("payment declined");
    await form.getByLabelText("In the last (minutes)").fill("15");
    await form.getByLabelText("Service (optional)").fill("server");
    await choose(form, "Minimum severity", "Warning and above");
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: RULES_PATH,
      body: {
        name: "",
        kind: "log_lines",
        settings: {
          environment: null,
          service: "server",
          severity: "warn",
          search: "payment declined",
          windowMinutes: 15,
          maxCount: 3,
        },
        channelIds: [EMAIL.id],
      },
    });
    await expect
      .element(
        page.getByText(
          'More than 3 log lines of Warning or above from server with the words "payment declined" arrive in 15 minutes, in production',
        ),
      )
      .toBeVisible();
  });

  test("any severity sends null", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Log lines match");
    await choose(form, "Minimum severity", "Any severity");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toMatchObject({
      kind: "log_lines",
      settings: { service: null, severity: null, search: null, windowMinutes: 5, maxCount: 0 },
    });
  });

  test("a rule's row and its edit form", async () => {
    installFakeApi({
      alerts: {
        ...fakeAlerts(),
        rules: [
          ruleOf({
            id: "6b6b6b6b-6b6b-4b6b-8b6b-000000000001",
            name: "Server errors",
            kind: "log_lines",
            settings: {
              environment: "production",
              service: "server",
              severity: "error",
              search: null,
              windowMinutes: 5,
              maxCount: 0,
            },
          }),
        ],
      },
    });
    renderApp(ALERTS);
    await expect
      .element(
        page.getByText(
          "More than 0 log lines of Error or above from server arrive in 5 minutes, in production",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Edit Server errors" }).click();
    const form = dialog("Edit “Server errors”");
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Log lines match/);
    await expect.element(form.getByLabelText("Service (optional)")).toHaveValue("server");
    await expect
      .element(form.getByRole("combobox", { name: "Minimum severity" }))
      .toMatchTextContent(/^Error and above/);
    await expect.element(form.getByLabelText("More than (lines)")).toHaveValue("0");
  });
});

describe("the Logs page from an alert's link", () => {
  test("opens on the rule's filters and time window, and clears the window", async () => {
    const asked: URLSearchParams[] = [];
    installFakeApi({
      logs: (query) => {
        asked.push(new URLSearchParams(query));
        return fakeLogs(query);
      },
    });
    // As the API writes the link (alerts/log-rules.ts): each value as JSON.
    const link = new URLSearchParams();
    for (const [key, value] of Object.entries({
      env: "production",
      severity: "error",
      start: "2026-11-16T02:20:00.000Z",
      end: "2026-11-16T02:31:00.000Z",
      service: "server",
      q: "declined",
    })) {
      link.set(key, JSON.stringify(value));
    }
    renderApp(`/projects/${PROJECT.id}/logs?${link.toString()}`);
    // In the instance's timezone, Asia/Singapore.
    const window = page.getByRole("button", { name: "Clear the time window" });
    await expect.element(window).toHaveTextContent("16 Nov 2026, 10:20 to 10:31");
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    const first = asked[0];
    expect(Object.fromEntries(first ?? [])).toEqual({
      start: "2026-11-16T02:20:00.000Z",
      end: "2026-11-16T02:31:00.000Z",
      service: "server",
      severity: "error",
      search: "declined",
    });
    await expect
      .element(page.getByRole("searchbox", { name: "Words in the message" }))
      .toHaveValue("declined");

    await window.click();
    await expect.element(window).not.toBeInTheDocument();
    await expect.poll(() => asked.at(-1)?.has("start")).toBe(false);
    expect(asked.at(-1)?.get("search")).toBe("declined");
  });

  test("ignores a window that is backwards or longer than a day", async () => {
    const asked: URLSearchParams[] = [];
    installFakeApi({
      logs: (query) => {
        asked.push(new URLSearchParams(query));
        return fakeLogs(query);
      },
    });
    renderApp(
      `/projects/${PROJECT.id}/logs?start=2026-11-16T02:31:00.000Z&end=2026-11-16T02:20:00.000Z`,
    );
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0]?.has("start")).toBe(false);
    expect(page.getByRole("button", { name: "Clear the time window" }).elements()).toEqual([]);
  });
});
