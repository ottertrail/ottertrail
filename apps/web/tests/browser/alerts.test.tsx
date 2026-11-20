import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  ALERT_RULE_IDS,
  ERROR_FINGERPRINTS,
  fakeChannels,
  fakeChecks,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ALERTS = `/projects/${PROJECT.id}/alerts`;
const RULES_PATH = `/api/projects/${PROJECT.id}/alert-rules`;
const [EMAIL, WEBHOOK] = fakeChannels().list;
const [SHOP, API] = fakeChecks();
if (EMAIL === undefined || WEBHOOK === undefined || SHOP === undefined || API === undefined) {
  throw new Error("the fixtures changed");
}

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

const rowsOf = (caption: string) => {
  const table = [...document.querySelectorAll("table")].find(
    (element) => element.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent ?? ""),
  );
};

async function choose(scope: ReturnType<typeof dialog>, combobox: string, option: string) {
  await scope.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

describe("the Alerts page", () => {
  test("opens from the sidebar after Uptime, with each rule's watch, channels, and state", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/uptime`);
    const nav = page.getByRole("navigation", { name: "Project" });
    await expect.element(nav.getByRole("link", { name: "Alerts" })).toBeVisible();
    const names = nav
      .getByRole("link")
      .elements()
      .map((link) => link.textContent.trim());
    expect(names.indexOf("Alerts")).toBe(names.indexOf("Uptime") + 1);
    await nav.getByRole("link", { name: "Alerts" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(ALERTS);
    await expect.element(page.getByRole("table", { name: "Alert rules" })).toBeVisible();
    expect(api.requests).toContain(RULES_PATH);
    // Each rule, what it watches, and its state; where it sends, in its detail.
    expect(rowsOf("Alert rules").map((cells) => cells.slice(0, 2))).toEqual([
      ["API downAPI health goes down", "Firing"],
      ["New errorsAn error group is seen for the first time, in production", "Quiet"],
      [
        `Checkout spike20 or more occurrences of the group ${ERROR_FINGERPRINTS.typeError} in 10 minutes, in any environment`,
        "Off",
      ],
      [
        "CertificatesThe certificate of any of the project's checks expires within 14 days",
        "OffDisabled because its last channel was deleted. Choose a channel to enable the rule again.",
      ],
    ]);
    const sendsTo = [];
    for (const name of ["API down", "New errors", "Checkout spike", "Certificates"]) {
      await page
        .getByRole("region", { name: "Alerts, list" })
        .getByRole("link", { name, exact: true })
        .click();
      const detail = page.getByRole("region", { name: "Alerts, selected" });
      await expect.element(detail.getByRole("heading", { name, exact: true })).toBeVisible();
      const term = [...detail.element().querySelectorAll("dt")].find(
        (dt) => dt.textContent === "Sends to",
      );
      sendsTo.push(term?.nextElementSibling?.textContent);
    }
    expect(sendsTo).toEqual(["On call", "On call, Ops relay", "Ops relay", "No channel"]);
    await userEvent.keyboard("{Escape}");
    // On or off is a switch named for its rule.
    await expect.element(page.getByRole("switch", { name: "Turn off API down" })).toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Turn on Checkout spike" }))
      .not.toBeChecked();

    const firing = page.getByRole("list", { name: "Firing now" });
    await expect.element(firing.getByText("API health", { exact: true })).toBeVisible();
    await expect.element(firing.getByText(/since 16 Nov 2026, 09:41/)).toBeVisible();
    // The subject, the rule and the time read apart, with words between them.
    expect(firing.element().querySelector("li")?.textContent).toMatch(
      /^FiringAPI health, rule API down, since 16 Nov 2026, 09:41/,
    );

    await expect.element(page.getByRole("table", { name: /Recent alerts/ })).toBeVisible();
    const history = rowsOf("Recent alerts, newest first");
    expect(history.map((cells) => [cells[0], cells[1], cells[3]])).toEqual([
      // Not resolved: the dash for the eye, the words for a screen reader.
      ["16 Nov 2026, 09:41", "API down", "–Not resolved"],
      ["16 Nov 2026, 06:10", "New errors", "–Not resolved"],
      ["16 Nov 2026, 03:06", "API down", "16 Nov 2026, 03:31"],
    ]);
    expect(history[1]?.[2]).toBe(
      "Main site: a new error in production. NetworkError: Failed to fetchHeld back",
    );
  });

  test("explains alerts and offers to add one while the project has none", async () => {
    installFakeApi({ alerts: { rules: [], firing: [], history: [] } });
    renderApp(ALERTS);
    await expect.element(page.getByText("No alert rules yet")).toBeVisible();
    await expect
      .element(page.getByText(/Add a rule to receive email or webhook notifications/))
      .toBeVisible();
    expect(page.getByRole("table").elements()).toEqual([]);
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect.element(dialog("Add an alert rule")).toBeVisible();
  });

  test("says when the instance has no channels, links to Settings, and does not add", async () => {
    const api = installFakeApi({ alerts: { rules: [], firing: [], history: [] } });
    api.channels.list = [];
    const router = renderApp(ALERTS);
    await expect.element(page.getByText("No notification channels yet")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add rule" })).toBeDisabled();
    await page.getByRole("link", { name: "Go to Settings" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/settings");
  });

  test("adds a rule: the form checks its fields, then sends the kind's settings", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await expect.element(form).toBeVisible();

    await choose(form, "When", "Error spike");
    await expect.element(form.getByText(/Notifies at the threshold/)).toBeVisible();
    await form.getByLabelText("Environment (optional)").fill("not an environment");
    await form.getByLabelText("Errors").fill("0");
    await form.getByLabelText("In the last (minutes)").fill("90");
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form.getByText(/An environment has 1 to 64 letters/)).toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of errors from 1 to 1,000,000."))
      .toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of minutes from 5 to 60."))
      .toBeVisible();
    await expect.element(form.getByText("Choose at least one channel.")).toBeVisible();
    await expect
      .element(form.getByText("The rule is incomplete. Correct the marked fields above."))
      .toBeVisible();
    expect(api.bodies).toEqual([]);

    await form.getByLabelText("Environment (optional)").fill("staging");
    await form.getByLabelText("Errors").fill("25");
    await form.getByLabelText("In the last (minutes)").fill("15");
    await form.getByLabelText("Name (optional)").fill("Staging spike");
    await form.getByRole("checkbox", { name: /Ops relay/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: RULES_PATH,
      body: {
        name: "Staging spike",
        kind: "error_spike",
        settings: { environment: "staging", fingerprint: null, windowMinutes: 15, threshold: 25 },
        channelIds: [WEBHOOK.id],
      },
    });
    await expect
      .element(page.getByText("25 or more errors in 15 minutes, in staging"))
      .toBeVisible();
  });

  test("shows the API's refusal beside the channels", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    // Deleted in another tab meanwhile.
    api.channels.list = api.channels.list.filter((channel) => channel.id !== EMAIL.id);
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(form.getByText("This instance has no notification channel with one of these IDs."))
      .toBeVisible();
  });

  test("turns a rule off and on, edits it, and deletes it after asking", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("switch", { name: "Turn off API down" }).click();
    await expect.element(page.getByRole("switch", { name: "Turn on API down" })).toBeVisible();
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `${RULES_PATH}/${ALERT_RULE_IDS.apiDown}`,
      body: { enabled: false },
    });
    await page.getByRole("switch", { name: "Turn on API down" }).click();
    await expect.element(page.getByRole("switch", { name: "Turn off API down" })).toBeVisible();

    await page.getByRole("button", { name: "Edit API down" }).click();
    const form = dialog("Edit “API down”");
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Check down/);
    await expect
      .element(form.getByRole("combobox", { name: "Check" }))
      .toMatchTextContent(/^API health/);
    await expect.element(form.getByRole("checkbox", { name: /On call/ })).toBeChecked();
    await form.getByLabelText("Name (optional)").fill("API is down");
    await choose(form, "Check", "All the project's checks");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `${RULES_PATH}/${ALERT_RULE_IDS.apiDown}`,
      body: {
        name: "API is down",
        kind: "check_down",
        settings: { checkId: null },
        channelIds: [EMAIL.id],
      },
    });
    await expect.element(page.getByText("Any of the project's checks goes down")).toBeVisible();

    await page.getByRole("button", { name: "Delete New errors" }).click();
    const ask = dialog("Delete the rule “New errors”?");
    await ask.getByRole("button", { name: "Delete rule" }).click();
    await expect.element(ask).not.toBeInTheDocument();
    expect(api.bodies).toHaveLength(3);
    expect(api.requests).toContain(`${RULES_PATH}/${ALERT_RULE_IDS.newErrors}`);
    await expect.poll(() => rowsOf("Alert rules").length).toBe(3);
  });
  test("editing drops a channel the instance no longer has, so the rule saves", async () => {
    const api = installFakeApi();
    api.alerts.rules = api.alerts.rules.map((rule) =>
      rule.id === ALERT_RULE_IDS.apiDown
        ? { ...rule, channelIds: [EMAIL.id, "dddddddd-dddd-4ddd-8ddd-00000000dead"] }
        : rule,
    );
    renderApp(`${ALERTS}?rule=${ALERT_RULE_IDS.apiDown}`);
    await expect
      .element(
        page
          .getByRole("region", { name: "Alerts, selected" })
          .getByText("On call, A deleted channel"),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Edit API down" }).click();
    const form = dialog("Edit “API down”");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toMatchObject({ channelIds: [EMAIL.id] });
  });
});

describe("alert rules on a check's and an error's page", () => {
  test("a check's page lists the rules that watch it, and adds one for it", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/uptime/${API.id}`);
    const card = page.getByRole("list", { name: "Alert rules that watch it" });
    await expect.element(card.getByRole("link", { name: "API down" })).toBeVisible();
    // The certificates rule watches every check; it is off, and says so.
    await expect.element(card.getByRole("link", { name: "Certificates" })).toBeVisible();
    expect(card.getByRole("link", { name: "New errors" }).elements()).toEqual([]);

    await page.getByRole("link", { name: "Add an alert rule" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(ALERTS);
    expect(router.state.location.search).toEqual({ add: "check_down", check: API.id });
    const form = dialog("Add an alert rule");
    await expect.element(form).toBeVisible();
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Check down/);
    await expect
      .element(form.getByRole("combobox", { name: "Check" }))
      .toMatchTextContent(/^API health/);
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toEqual({
      name: "",
      kind: "check_down",
      settings: { checkId: API.id },
      channelIds: [EMAIL.id],
    });
    // Closing the form leaves the page without the link's query.
    await expect.poll(() => router.state.location.search).toEqual({});
  });

  test("a check no rule watches says so", async () => {
    const api = installFakeApi();
    api.alerts.rules = api.alerts.rules.filter((rule) => rule.kind !== "certificate_expiring");
    renderApp(`/projects/${PROJECT.id}/uptime/${SHOP.id}`);
    await expect.element(page.getByText("No rule watches it yet.")).toBeVisible();
  });

  test("an error's page lists the rules that watch its group, and adds a spike rule for it", async () => {
    installFakeApi();
    const router = renderApp(
      `/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}?env=staging`,
    );
    const card = page.getByRole("list", { name: "Alert rules that watch it" });
    await expect.element(card.getByRole("link", { name: "Checkout spike" })).toBeVisible();
    // A new-error rule watches groups not seen yet: not this one.
    expect(card.getByRole("link", { name: "New errors" }).elements()).toEqual([]);

    await page.getByRole("link", { name: "Add an alert rule" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(ALERTS);
    expect(router.state.location.search).toEqual({
      add: "error_spike",
      fingerprint: ERROR_FINGERPRINTS.typeError,
      env: "staging",
    });
    const form = dialog("Add an alert rule");
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Error spike/);
    await expect
      .element(form.getByLabelText("Error group (optional)"))
      .toHaveValue(ERROR_FINGERPRINTS.typeError);
    await expect.element(form.getByLabelText("Environment (optional)")).toHaveValue("staging");
  });
});
