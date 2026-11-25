import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { FunnelStep } from "../../src/lib/product-api.ts";
import { type FakeApi, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * A funnel's breakdown by one dimension, and the lists of signed-in users
 * who dropped off or converted (docs/dashboard.md, "Product analytics").
 */

const FUNNEL = `/projects/${PROJECT.id}/product/funnel`;

const SIGNUP_PURCHASE: FunnelStep[] = [
  { type: "event", name: "signup" },
  { type: "event", name: "purchase" },
];

const PAGE_FIRST: FunnelStep[] = [
  { type: "page", path: "/" },
  { type: "event", name: "purchase" },
];

const funnelAddress = (steps: FunnelStep[], rest = "") =>
  `${FUNNEL}?steps=${encodeURIComponent(JSON.stringify(steps))}${rest}`;

const breakdownPicker = () => page.getByRole("combobox", { name: "Break down by" });

/** A table's rows as the text of their cells, the row's name first. */
function rowsOf(name: string): string[][] {
  const table = page.getByRole("table", { name }).element();
  return [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
  );
}

/** The query of the latest request to `path` ("/funnel/breakdown" …). */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  return Object.fromEntries(new URLSearchParams(request.split("?")[1] ?? ""));
}

describe("a funnel's breakdown", () => {
  test("choosing one puts it in the address, asks for it, and shows a row per value", async () => {
    const api = installFakeApi();
    const router = renderApp(funnelAddress(SIGNUP_PURCHASE));
    await expect.element(page.getByRole("heading", { name: "Breakdown" })).toBeVisible();
    expect(api.requests.some((item) => item.includes("/funnel/breakdown"))).toBe(false);

    await breakdownPicker().click();
    // The event's own properties follow the columns every event has.
    for (const name of ["By device", "By browser", "By operating system", "By plan", "By seats"]) {
      await expect.element(page.getByRole("option", { name, exact: true })).toBeVisible();
    }
    await page.getByRole("option", { name: "By device", exact: true }).click();

    const name = "Funnel steps by device, with the visitors who reached each";
    await expect.element(page.getByRole("table", { name })).toBeVisible();
    expect(router.state.location.search).toMatchObject({ by: "deviceType" });
    expect(lastQuery(api, "/funnel/breakdown")).toMatchObject({
      by: "deviceType",
      steps: JSON.stringify(SIGNUP_PURCHASE),
    });
    expect(rowsOf(name)).toEqual([
      ["Desktop", "600", "300", "50%"],
      ["Mobile", "350", "100", "29%"],
      ["Unknown", "50", "20", "40%"],
    ]);
    // The funnel's own result stays above it.
    await expect
      .element(
        page.getByRole("table", { name: "Funnel steps, with the visitors who reached each" }),
      )
      .toBeVisible();

    await breakdownPicker().click();
    await page.getByRole("option", { name: "No breakdown", exact: true }).click();
    await expect.element(page.getByRole("table", { name })).not.toBeInTheDocument();
    expect(router.state.location.search).not.toHaveProperty("by");
  });

  test("from the address: a property, and the top values with Other and Unknown", async () => {
    installFakeApi();
    renderApp(funnelAddress(SIGNUP_PURCHASE, "&by=p.plan"));
    const plan = "Funnel steps by plan, with the visitors who reached each";
    await expect.element(page.getByRole("table", { name: plan })).toBeVisible();
    expect(rowsOf(plan)).toEqual([
      ["team", "700", "350", "50%"],
      ["free", "300", "70", "23%"],
    ]);

    await breakdownPicker().click();
    await page.getByRole("option", { name: "By browser", exact: true }).click();
    const browser = "Funnel steps by browser, with the visitors who reached each";
    await expect.element(page.getByRole("table", { name: browser })).toBeVisible();
    expect(rowsOf(browser).map((row) => row[0])).toEqual([
      "Chrome",
      "Safari",
      "Firefox",
      "Microsoft Edge",
      "Samsung Internet",
      "Other",
      "Unknown",
    ]);
  });

  test("by the visit's source and campaign, named as the Analytics page names them", async () => {
    const api = installFakeApi();
    const router = renderApp(funnelAddress(SIGNUP_PURCHASE));
    await breakdownPicker().click();
    await page.getByRole("option", { name: "By source", exact: true }).click();

    const source = "Funnel steps by source, with the visitors who reached each";
    await expect.element(page.getByRole("table", { name: source })).toBeVisible();
    expect(router.state.location.search).toMatchObject({ by: "source" });
    expect(lastQuery(api, "/funnel/breakdown")).toMatchObject({ by: "source" });
    expect(rowsOf(source)).toEqual([
      ["google.com", "380", "180", "47%"],
      ["Direct / none", "300", "110", "37%"],
      ["newsletter", "160", "80", "50%"],
      ["news.ycombinator.com", "90", "30", "33%"],
      ["github.com", "40", "12", "30%"],
      ["Other", "20", "5", "25%"],
      ["Unknown", "10", "3", "30%"],
    ]);

    await breakdownPicker().click();
    await page.getByRole("option", { name: "By campaign", exact: true }).click();
    const campaign = "Funnel steps by campaign, with the visitors who reached each";
    await expect.element(page.getByRole("table", { name: campaign })).toBeVisible();
    expect(rowsOf(campaign).map((row) => row[0])).toEqual([
      "No campaign",
      "launch-week",
      "Unknown",
    ]);
  });

  test("a funnel starting on a page offers no properties, and drops one from the address", async () => {
    const api = installFakeApi();
    renderApp(funnelAddress(PAGE_FIRST, "&by=p.plan"));
    await expect.element(page.getByRole("heading", { name: "Breakdown" })).toBeVisible();
    await expect.element(breakdownPicker()).toMatchTextContent(/No breakdown/);
    await breakdownPicker().click();
    await expect.element(page.getByRole("option", { name: "By device" })).toBeVisible();
    expect(page.getByRole("option", { name: "By plan" }).elements()).toEqual([]);
    expect(api.requests.some((item) => item.includes("/funnel/breakdown"))).toBe(false);
  });
});

describe("who dropped off", () => {
  test("each step of a funnel of users lists its people, each a link to their page", async () => {
    installFakeApi();
    renderApp(funnelAddress(SIGNUP_PURCHASE, "&count=users&window=3600&env=staging"));
    const dropped = page.getByRole("button", { name: "580 dropped off after step 1: list them" });
    await expect.element(dropped).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "420 converted: list them" }))
      .toBeVisible();

    await dropped.click();
    const dialog = page.getByRole("dialog", { name: "Dropped off after step 1" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByText("The 100 most recent of 580 users.", { exact: true }))
      .toBeVisible();
    const links = dialog.getByRole("list", { name: "Users" }).getByRole("link");
    expect(links.elements()).toHaveLength(100);
    // The most recent first, to their page in Users, in the funnel's environment.
    await expect
      .element(dialog.getByRole("link", { name: "user-1", exact: true }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/users/user-1?env=staging`);
  });

  test("says how many when all fit, and the converted list for the last step", async () => {
    const api = installFakeApi();
    const steps: FunnelStep[] = [
      ...SIGNUP_PURCHASE,
      { type: "event", name: "invite" },
      { type: "event", name: "upgrade" },
    ];
    const router = renderApp(funnelAddress(steps, "&count=users&window=3600"));
    await page.getByRole("button", { name: "76 dropped off after step 3: list them" }).click();
    const dialog = page.getByRole("dialog", { name: "Dropped off after step 3" });
    await expect.element(dialog.getByText("76 users.", { exact: true })).toBeVisible();
    expect(dialog.getByRole("link").elements()).toHaveLength(76);
    expect(lastQuery(api, "/funnel/people")).toMatchObject({ step: "3", outcome: "dropped" });

    await dialog.getByRole("link", { name: "user-2", exact: true }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/users/user-2`);
  });

  test("nothing to list for visitors", async () => {
    installFakeApi();
    renderApp(funnelAddress(SIGNUP_PURCHASE));
    await expect
      .element(
        page.getByRole("table", { name: "Funnel steps, with the visitors who reached each" }),
      )
      .toBeVisible();
    expect(page.getByRole("button", { name: /list them/ }).elements()).toEqual([]);
    expect(page.getByRole("columnheader", { name: "People" }).elements()).toEqual([]);
  });

  test("a member without the users area sees counts, not lists", async () => {
    installFakeApi({ access: memberAccess({ product_analytics: "view" }) });
    renderApp(funnelAddress(SIGNUP_PURCHASE, "&count=users&window=3600"));
    await expect
      .element(page.getByRole("table", { name: "Funnel steps, with the users who reached each" }))
      .toBeVisible();
    expect(page.getByRole("button", { name: /list them/ }).elements()).toEqual([]);
  });
});
