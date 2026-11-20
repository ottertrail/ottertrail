import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { FAKE_SECRET, fakeChannels, installFakeApi, ROTATED_SECRET } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const [EMAIL, WEBHOOK] = fakeChannels().list;
if (EMAIL === undefined || WEBHOOK === undefined) throw new Error("fakeChannels changed");

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });
const channelList = () => page.getByRole("list", { name: "Notification channels" });
const item = (name: string) => channelList().getByRole("listitem").filter({ hasText: name });

const rowsOf = (caption: string) => {
  const table = [...document.querySelectorAll("table")].find(
    (element) => element.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent ?? ""),
  );
};

describe("notification channels on the Settings page", () => {
  test("lists the channels, and says email is not set up", async () => {
    installFakeApi();
    renderApp("/settings?tab=channels");

    await expect
      .element(page.getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
    await expect
      .element(page.getByText("Email is not set up on this instance", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(/until whoever runs the server sets SMTP_URL/))
      .toBeVisible();
    await expect.element(page.getByText("2 of 20 channels")).toBeVisible();
    await expect
      .element(item("On call").getByText("ops@example.com, dev@example.com"))
      .toBeVisible();
    await expect
      .element(
        item("On call").getByText(
          "Not sent yet: SMTP_URL and EMAIL_FROM aren't set on this server.",
        ),
      )
      .toBeVisible();
    await expect
      .element(item("Ops relay").getByText("https://hooks.example.com/ottertrail"))
      .toBeVisible();
    await expect.element(item("Ops relay").getByText("Webhook", { exact: true })).toBeVisible();
  });

  test("says when email is set up", async () => {
    const api = installFakeApi();
    api.channels.emailConfigured = true;
    renderApp("/settings?tab=channels");

    await expect.element(page.getByText("Email set up")).toBeVisible();
    await expect
      .element(page.getByText("Email is not set up on this instance", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("Not sent yet: SMTP_URL and EMAIL_FROM aren't set on this server."))
      .not.toBeInTheDocument();
  });

  test("with no channels, explains them and offers to add one", async () => {
    const api = installFakeApi();
    api.channels.list = [];
    renderApp("/settings?tab=channels");

    await expect.element(page.getByText("No channels yet")).toBeVisible();
    await page.getByRole("button", { name: "Add channel" }).click();
    await expect.element(dialog("Add a notification channel")).toBeVisible();
  });

  test("adds an email channel, checking the addresses first", async () => {
    const api = installFakeApi();
    renderApp("/settings?tab=channels");
    await page.getByRole("button", { name: "Add channel" }).click();
    const form = dialog("Add a notification channel");

    await form.getByRole("button", { name: "Add channel" }).click();
    await expect.element(form.getByText("Enter 1 to 20 addresses.")).toBeVisible();

    await form
      .getByRole("textbox", { name: "Addresses" })
      .fill("sre@example.com\nboss@example.com, sre@example.com");
    await form.getByRole("textbox", { name: "Name" }).fill("SRE");
    await form.getByRole("button", { name: "Add channel" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/channels",
      body: { kind: "email", name: "SRE", addresses: ["sre@example.com", "boss@example.com"] },
    });
    await expect.element(item("SRE").getByText("sre@example.com, boss@example.com")).toBeVisible();
    await expect.element(page.getByText("3 of 20 channels")).toBeVisible();
  });

  test("adds a webhook, showing the API's refusal under the URL", async () => {
    const api = installFakeApi();
    renderApp("/settings?tab=channels");
    await page.getByRole("button", { name: "Add channel" }).click();
    const form = dialog("Add a notification channel");

    await form.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: "Webhook", exact: true }).click();
    const url = form.getByRole("textbox", { name: "URL" });
    await url.fill("https://relay.internal/hook");
    await form.getByRole("button", { name: "Add channel" }).click();
    await expect
      .element(form.getByText("relay.internal resolves to an address webhooks may not reach."))
      .toBeVisible();
    await expect.element(url).toHaveAttribute("aria-invalid", "true");

    await url.fill("https://relay.example.com/hook");
    await form.getByRole("button", { name: "Add channel" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/channels",
      body: { kind: "webhook", name: "", url: "https://relay.example.com/hook" },
    });
    await expect.element(item("relay.example.com").getByText("Signing secret")).toBeVisible();
  });

  test("edits and deletes a channel, asking first", async () => {
    const api = installFakeApi();
    renderApp("/settings?tab=channels");

    await page.getByRole("button", { name: "Edit On call" }).click();
    const form = dialog("Edit “On call”");
    await expect.element(form.getByRole("combobox", { name: "Kind" })).not.toBeInTheDocument();
    const addresses = form.getByRole("textbox", { name: "Addresses" });
    await expect.element(addresses).toHaveValue("ops@example.com\ndev@example.com");
    await addresses.fill("ops!pager@example.com");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect
      .element(form.getByText(/"ops!pager@example.com" is not a supported email address/))
      .toBeVisible();
    await addresses.fill("pager@example.com");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "PATCH",
      path: `/api/channels/${EMAIL.id}`,
      body: { name: "On call", addresses: ["pager@example.com"] },
    });
    await expect.element(item("On call").getByText("pager@example.com")).toBeVisible();

    await page.getByRole("button", { name: "Delete On call" }).click();
    const confirm = dialog("Delete the channel “On call”?");
    await confirm.getByRole("button", { name: "Delete channel" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect.element(page.getByText("On call", { exact: true })).not.toBeInTheDocument();
    expect(api.channels.list.map((channel) => channel.id)).toEqual([WEBHOOK.id]);
  });

  test("shows a webhook's secret on request, copies it, and replaces it after asking", async () => {
    const api = installFakeApi();
    renderApp("/settings?tab=channels");
    const relay = item("Ops relay");
    const secretPath = `/api/channels/${WEBHOOK.id}/secret`;

    // The list does not carry it, and nothing asks for it until Show.
    await expect.element(relay.getByText("Signing secret")).toBeVisible();
    await expect.element(relay.getByText(FAKE_SECRET)).not.toBeInTheDocument();
    expect(api.requests).not.toContain(secretPath);
    await relay.getByRole("button", { name: "Show secret of Ops relay" }).click();
    await expect.element(relay.getByText(FAKE_SECRET)).toBeVisible();
    expect(api.requests).toContain(secretPath);
    // Hide forgets it; Show asks again.
    await relay.getByRole("button", { name: "Hide secret of Ops relay" }).click();
    await expect.element(relay.getByText(FAKE_SECRET)).not.toBeInTheDocument();
    await relay.getByRole("button", { name: "Show secret of Ops relay" }).click();
    await expect.element(relay.getByText(FAKE_SECRET)).toBeVisible();
    expect(api.requests.filter((path) => path === secretPath)).toHaveLength(2);
    await expect
      .element(relay.getByRole("button", { name: "Copy the secret of Ops relay" }))
      .toBeVisible();

    await relay.getByRole("button", { name: "Replace secret of Ops relay" }).click();
    const confirm = dialog("Replace the secret of “Ops relay”?");
    await expect
      .element(confirm.getByText(/rejects them until it has the new secret/))
      .toBeVisible();
    await confirm.getByRole("button", { name: "Replace secret" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect.element(relay.getByText(ROTATED_SECRET)).toBeVisible();
  });

  test("sends a test, which shows in the channel's deliveries, and says when there were too many", async () => {
    const api = installFakeApi();
    api.channels.testsLeft = 1;
    renderApp("/settings?tab=channels");
    const onCall = item("On call");

    await onCall.getByRole("button", { name: "Send test to On call" }).click();
    await expect
      .element(onCall.getByText(/Test queued. It will be sent within seconds/))
      .toBeVisible();
    expect(api.requests).toContain(`/api/channels/${EMAIL.id}/test`);
    // The deliveries open with the test in them, queued.
    await expect
      .element(onCall.getByRole("button", { name: "Deliveries to On call" }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(onCall.getByText("Queued")).toBeVisible();
    await expect.element(onCall.getByText("Test", { exact: true })).toBeVisible();

    await onCall.getByRole("button", { name: "Send test to On call" }).click();
    await expect
      .element(
        onCall.getByText(
          "A channel takes at most 5 test sends a minute. Wait a moment. Then try again.",
        ),
      )
      .toBeVisible();
  });

  test("shows a delivery whose first attempt is under way as Sending, not Retrying", async () => {
    const api = installFakeApi();
    const [first] = api.channels.deliveries[WEBHOOK.id] ?? [];
    if (first === undefined) throw new Error("no delivery");
    api.channels.deliveries[WEBHOOK.id] = [
      { ...first, attempts: 1, lastError: null },
      { ...first, id: "eeeeeeee-eeee-4eee-8eee-000000000099", attempts: 0, lastError: null },
    ];
    renderApp("/settings?tab=channels");
    const relay = item("Ops relay");
    await relay.getByRole("button", { name: "Deliveries to Ops relay" }).click();
    await expect.element(relay.getByText("Sending")).toBeVisible();
    await expect.element(relay.getByText("Queued")).toBeVisible();
    await expect.element(relay.getByText("Retrying")).not.toBeInTheDocument();
  });

  test("lists a channel's deliveries with their status and error, page by page", async () => {
    installFakeApi();
    renderApp("/settings?tab=channels");
    const relay = item("Ops relay");

    await relay.getByRole("button", { name: "Deliveries to Ops relay" }).click();
    const caption = "Deliveries to Ops relay in the last 30 days, newest first";
    await expect.poll(() => rowsOf(caption).length).toBe(20);
    const [retrying, failed, sent] = rowsOf(caption);
    expect(retrying).toEqual([
      "16 Nov 2026, 10:10",
      "Check up",
      "Retrying",
      "2",
      "It answered 503. A webhook must return 2xx. Next try 16 Nov 2026, 10:12.",
    ]);
    expect(failed).toEqual([
      "16 Nov 2026, 09:50",
      "Check down",
      "Failed",
      "8",
      "hooks.example.com resolves to an address webhooks may not reach.",
    ]);
    expect(sent).toEqual([
      "15 Nov 2026, 20:00",
      "Check down",
      "Sent",
      "1",
      "Sent 15 Nov 2026, 20:00.",
    ]);

    await relay.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => rowsOf(caption).length).toBe(25);
    await expect.element(relay.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();

    // An email channel with none yet says so.
    await item("On call").getByRole("button", { name: "Deliveries to On call" }).click();
    await expect
      .element(item("On call").getByText(/No deliveries in the last 30 days/))
      .toBeVisible();
  });

  test("turns Add off at 20 channels, saying why", async () => {
    const api = installFakeApi();
    const [email] = fakeChannels().list;
    if (email === undefined) throw new Error("no channel");
    api.channels.list = Array.from({ length: 20 }, (_, index) => ({
      ...email,
      id: `cccccccc-cccc-4ccc-8ccc-${String(100 + index).padStart(12, "0")}`,
      name: `List ${index + 1}`,
    }));
    renderApp("/settings?tab=channels");

    await expect
      .element(page.getByText("20 of 20 channels: delete one to add another"))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add channel" })).toBeDisabled();
  });

  test("a failed load says so, with Retry", async () => {
    installFakeApi();
    const original = window.fetch;
    // The channels' route fails, and its two automatic retries too; the rest of the page loads.
    let failures = 0;
    window.fetch = async (input, init) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (failures < 3 && new URL(href, window.location.origin).pathname === "/api/channels") {
        failures += 1;
        return new Response(JSON.stringify({ error: "x", message: "The database is busy." }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return original(input, init);
    };
    try {
      renderApp("/settings?tab=channels");
      await expect.element(page.getByText("The channels could not load")).toBeVisible();
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.element(page.getByText("2 of 20 channels")).toBeVisible();
    } finally {
      window.fetch = original;
    }
  });
});
