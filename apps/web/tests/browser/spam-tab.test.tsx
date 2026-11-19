import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT, SPAM_COUNTS } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The project settings' Spam and bots tab: the data-center switch, blocked
 * addresses and referrers under the save rule, "Add my address", the
 * checks as typed, and deleting spam (count, then confirm by typing the
 * number of visits).
 */

const SPAM = `/projects/${PROJECT.id}/settings?tab=spam`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const panel = () => page.getByRole("tabpanel");
const form = () => panel().getByRole("form", { name: "Spam and bots" });
/** The Save bar's status; "Add my address" has a status line of its own. */
const status = () => form().getByText(/^(No unsaved changes|Unsaved changes|Saving…)$/);
const save = () => form().getByRole("button", { name: "Save changes" });
const addresses = () => page.getByRole("textbox", { name: "Blocked addresses" });
const referrers = () => page.getByRole("textbox", { name: "Blocked referrers" });
const dataCenters = () => page.getByRole("checkbox", { name: "Ignore visits from data centers" });

describe("the Spam and bots form", () => {
  test("holds the data-center switch, moved from General, with its name", async () => {
    installFakeApi();
    renderApp(SPAM);
    await expect.element(dataCenters()).toBeChecked();
    expect(document.querySelector("[name=ignoreDataCenters]")).not.toBeNull();
    await page.getByRole("tab", { name: "General" }).click();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(panel().getByRole("checkbox").elements()).toEqual([]);
  });

  test("Save waits for a change; the three save together; Discard undoes; the tab says unsaved", async () => {
    const api = installFakeApi({
      projects: [{ ...PROJECT, blockedAddresses: ["203.0.113.7"], blockedReferrers: [] }],
    });
    renderApp(SPAM);
    await expect.element(addresses()).toHaveValue("203.0.113.7");
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    // The same address written another way is no change.
    await addresses().fill("203.0.113.7/32");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    await addresses().fill("203.0.113.7\n198.51.100.0/24");
    await expect.element(status()).toHaveTextContent("Unsaved changes");
    await expect
      .element(page.getByRole("tab", { name: /^Spam and bots\s*, unsaved changes$/ }))
      .toBeVisible();
    await form().getByRole("button", { name: "Discard" }).click();
    await expect.element(addresses()).toHaveValue("203.0.113.7");
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    expect(api.bodies).toEqual([]);

    await dataCenters().click();
    await addresses().fill("203.0.113.7\n::ffff:198.51.100.9");
    await referrers().fill("Spam.Example\nhttps://ads.other.example/landing");
    await save().click();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `/api/projects/${PROJECT.id}`,
      body: {
        ignoreDataCenters: false,
        blockedAddresses: ["203.0.113.7", "198.51.100.9"],
        blockedReferrers: ["spam.example", "ads.other.example"],
      },
    });
  });

  test("leaving with unsaved changes asks first", async () => {
    installFakeApi();
    const router = renderApp(SPAM);
    await referrers().fill("spam.example");
    await page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Web analytics" })
      .click();
    const ask = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(ask).toBeVisible();
    await ask.getByRole("button", { name: "Stay on this page" }).click();
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT.id}/settings`);
    await expect.element(referrers()).toHaveValue("spam.example");
  });

  test("checks the lists as the API does, and saves nothing while one is wrong", async () => {
    const api = installFakeApi();
    renderApp(SPAM);
    await addresses().fill("203.0.113.7\nnot an address");
    await referrers().click();
    await expect.element(addresses()).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByText(/^"not an address" is not an IP address or range\./))
      .toBeVisible();

    await addresses().fill("10.0.0.0/7");
    await expect.element(page.getByText(/^"10\.0\.0\.0\/7" is not an IP address/)).toBeVisible();

    await addresses().fill(Array.from({ length: 101 }, (_, i) => `198.51.${i}.1`).join("\n"));
    await expect.element(page.getByText("Enter at most 100 addresses and ranges.")).toBeVisible();

    await addresses().fill("203.0.113.7");
    await expect.element(addresses()).not.toHaveAttribute("aria-invalid");
    await referrers().fill("com");
    await addresses().click();
    await expect.element(page.getByText(/^"com" is not a domain you can block\./)).toBeVisible();
    await save().click();
    expect(api.bodies).toEqual([]);

    await referrers().fill("bücher.example");
    await save().click();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)?.body).toMatchObject({ blockedReferrers: ["xn--bcher-kva.example"] });
  });

  test("refuses a referrer that is the project's own site, or a public suffix", async () => {
    const api = installFakeApi({
      projects: [{ ...PROJECT, allowedHostnames: ["www.example.com"] }],
    });
    renderApp(SPAM);
    await referrers().fill("example.com");
    await addresses().click();
    await expect
      .element(
        page.getByText(
          '"example.com" would block your own site, www.example.com: its pages refer visitors to each other. Remove it.',
        ),
      )
      .toBeVisible();
    await referrers().fill("co.uk");
    await expect.element(page.getByText(/^"co\.uk" is not a domain you can block\./)).toBeVisible();
    await save().click();
    expect(api.bodies).toEqual([]);
  });

  test("Add my address adds the address the API sees, once, and waits for Save", async () => {
    const api = installFakeApi();
    renderApp(SPAM);
    await page.getByRole("button", { name: "Add my address" }).click();
    await expect.element(addresses()).toHaveValue("203.0.113.7");
    await expect
      .element(page.getByText("Added your address 203.0.113.7. Save to apply it."))
      .toBeVisible();
    await expect.element(status()).toHaveTextContent("Unsaved changes");

    await page.getByRole("button", { name: "Add my address" }).click();
    await expect
      .element(page.getByText("Your address 203.0.113.7 is already in the list."))
      .toBeVisible();
    await expect.element(addresses()).toHaveValue("203.0.113.7");
    expect(api.bodies).toEqual([]);
  });

  test("Add my address adds an IPv6 address's /64", async () => {
    installFakeApi({ clientAddress: { address: "2001:db8:1:2::7", network: "2001:db8:1:2::/64" } });
    renderApp(SPAM);
    await addresses().fill("198.51.100.4");
    await page.getByRole("button", { name: "Add my address" }).click();
    await expect.element(addresses()).toHaveValue("198.51.100.4\n2001:db8:1:2::/64");
  });
});

const deleteButton = () => panel().getByRole("button", { name: "Delete visits" });

describe("deleting spam", () => {
  test("Delete waits for a count of the current filters, and asks for the visits typed", async () => {
    const api = installFakeApi();
    renderApp(SPAM);
    await expect.element(deleteButton()).toBeDisabled();
    await expect
      .element(page.getByText("Count the visits first. Changing a filter asks for a new count."))
      .toBeVisible();

    await page.getByRole("textbox", { name: "Referrer domain (optional)" }).fill("spam.example");
    await page.getByRole("button", { name: "Count visits" }).click();
    await expect
      .element(
        page.getByText(
          /^12 visits match, with 40 events: 20 pageviews, 3 custom events, 2 errors, and 15 other events/,
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText(/1 session replay goes with them\./)).toBeVisible();
    await expect.element(deleteButton()).toBeEnabled();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: `/api/projects/${PROJECT.id}/spam-visits/preview`,
      body: expect.objectContaining({ referrer: "spam.example" }),
    });

    // A changed filter needs a new count.
    await page.getByRole("textbox", { name: "Page path (optional)" }).fill("/pricing");
    await expect.element(deleteButton()).toBeDisabled();
    await expect
      .element(page.getByText("The filters changed. Count the visits again."))
      .toBeVisible();
    await page.getByRole("button", { name: "Count visits" }).click();
    await expect.element(deleteButton()).toBeEnabled();

    await deleteButton().click();
    const dialog = page.getByRole("dialog", { name: "Delete 12 visits?" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(
        dialog.getByText(
          /permanently deletes 12 visits with 40 events: 20 pageviews, 3 custom events, 2 errors, and 15 other events .*, and 1 session replay\./,
        ),
      )
      .toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Delete permanently" });
    await expect.element(confirm).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Type 12 to confirm" }).fill("11");
    await expect.element(confirm).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Type 12 to confirm" }).fill("12");
    await confirm.click();

    await expect.element(dialog).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Deleted 12 visits and 40 events. Reports no longer count them."))
      .toBeVisible();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: `/api/projects/${PROJECT.id}/spam-visits/delete`,
      body: expect.objectContaining({
        referrer: "spam.example",
        path: "/pricing",
        confirmVisits: 12,
      }),
    });
    // The count went with the visits: Delete waits for a new one.
    await expect.element(deleteButton()).toBeDisabled();
  });

  test("Count waits for a filter, saying why, and the period's last day warns about visits still going on", async () => {
    const api = installFakeApi();
    renderApp(SPAM);
    const count = page.getByRole("button", { name: "Count visits" });
    await expect.element(count).toBeDisabled();
    await expect
      .element(count)
      .toHaveAccessibleDescription("Enter a referrer domain, a page path, or a country first.");
    // The default period ends today.
    await expect
      .element(
        page.getByText(/Visits still going on keep the events that arrive after the delete\./),
      )
      .toBeVisible();
    await page.getByRole("textbox", { name: "Country (optional)" }).fill("DE");
    await expect.element(count).toBeEnabled();
    await page.getByRole("textbox", { name: "Country (optional)" }).fill("");
    await expect.element(count).toBeDisabled();
    expect(api.bodies).toEqual([]);
  });

  test("bad filters say what is wrong and count nothing", async () => {
    const api = installFakeApi();
    renderApp(SPAM);
    await page.getByRole("textbox", { name: "Country (optional)" }).fill("D1");
    await page.getByRole("textbox", { name: "Page path (optional)" }).fill("pricing");
    await page.getByRole("button", { name: "Count visits" }).click();
    await expect
      .element(page.getByText("Enter a two-letter country code, such as DE."))
      .toBeVisible();
    await expect
      .element(page.getByText("Enter a path that starts with /, such as /pricing."))
      .toBeVisible();
    expect(api.bodies).toEqual([]);
  });

  test("no matching visits leaves Delete disabled, and a failed count says why", async () => {
    installFakeApi({ spamCounts: { ...SPAM_COUNTS, visits: 0, events: 0 } });
    renderApp(SPAM);
    await page.getByRole("textbox", { name: "Referrer domain (optional)" }).fill("spam.example");
    await page.getByRole("button", { name: "Count visits" }).click();
    await expect
      .element(page.getByText("No visits match these filters in this period."))
      .toBeVisible();
    await expect.element(deleteButton()).toBeDisabled();
  });

  test("a failed count shows the API's message", async () => {
    installFakeApi({
      spamCounts: new Response(
        JSON.stringify({ error: "reports_busy", message: "The calculation took too long." }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    });
    renderApp(SPAM);
    await page.getByRole("textbox", { name: "Referrer domain (optional)" }).fill("spam.example");
    await page.getByRole("button", { name: "Count visits" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent(/The visits could not be counted\s*The calculation took too long\./);
  });
});

describe("the tab fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} wide, nothing scrolls sideways`, async () => {
      await page.viewport(width, height);
      installFakeApi();
      renderApp(SPAM);
      await expect.element(addresses()).toBeVisible();
      await page.getByRole("textbox", { name: "Referrer domain (optional)" }).fill("spam.example");
      await page.getByRole("button", { name: "Count visits" }).click();
      await expect.element(page.getByText(/^12 visits match/)).toBeVisible();
      const content = document.querySelector("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      // Buttons keep their labels on one line.
      for (const name of ["Add my address", "Count visits", "Delete visits"]) {
        const button = panel().getByRole("button", { name }).element();
        const lineHeight = Number.parseFloat(getComputedStyle(button).lineHeight) || 20;
        expect(button.getBoundingClientRect().height).toBeLessThan(lineHeight * 2 + 16);
      }
    });
  }
});
