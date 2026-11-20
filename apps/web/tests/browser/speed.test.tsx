import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { formatVital, rate } from "@/features/speed/format";

import {
  emptySpeed,
  type FakeApi,
  fakeSpeed,
  installFakeApi,
  json,
  PROJECT,
  speedFixture,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const SPEED = `/projects/${PROJECT.id}/speed`;

/** The query of the latest request for the speed report. */
function lastQuery(api: FakeApi): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith("/speed")) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** A Core Web Vital's label in the strip of figures, found by its full name. */
const card = (name: string) => page.getByText(name, { exact: true });

/** A vital's figure in the strip (`StatStrip`): its label, value, and details. */
function statOf(name: string): Element {
  const stat = card(name).element().closest("[data-slot=stat]");
  if (stat === null) throw new Error(`No figure for ${name}`);
  return stat;
}

/** What a vital shows: its p75, its rating, the shares, and the loads measured. */
function cardFigures(name: string) {
  const element = statOf(name);
  return {
    value: element.querySelector("dd")?.textContent,
    rating: element.querySelector("[data-slot=status-badge]")?.textContent,
    shares: [...element.querySelectorAll("ul[aria-label='Share of page loads'] li")].map(
      (item) => item.textContent,
    ),
    measured: element.querySelector("[data-slot=stat-measured]")?.textContent,
  };
}

/** A cell's text, without the labels a stacked row shows on a phone. */
function cellText(cell: Element): string | null {
  const copy = cell.cloneNode(true);
  if (!(copy instanceof Element)) return cell.textContent;
  for (const label of copy.querySelectorAll("[data-slot=breakdown-label]")) label.remove();
  return copy.textContent;
}

/**
 * The rows of a table, as their cells' text (a rating icon reads as its
 * name). A breakdown's bar cell has no text and is left out.
 */
function tableRows(name: string) {
  return [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map(cellText),
  );
}

/** The figure and rating of FCP or TTFB. */
function secondary(name: string) {
  const item = [...document.querySelectorAll("dl > div")].find((element) =>
    element.querySelector("dt")?.textContent?.startsWith(name),
  );
  return `${item?.querySelector("dd")?.textContent ?? ""}${
    item?.querySelector("[data-slot=status-badge]")?.textContent ?? ""
  }`;
}

describe("the speed page", () => {
  test("opens from the sidebar with the three Core Web Vitals, their ratings and shares", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/web-analytics`);

    await page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Speed" })
      .click();

    await expect.poll(() => router.state.location.pathname).toBe(SPEED);
    await expect.element(card("Largest Contentful Paint (LCP), p75")).toBeVisible();
    expect(lastQuery(api)).toEqual({ period: "7d" });
    await expect
      .element(
        page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Speed" }),
      )
      .toHaveAttribute("data-active");

    expect(cardFigures("Largest Contentful Paint (LCP), p75")).toEqual({
      value: "2.3 s",
      rating: "Good",
      shares: ["Good80%", "Needs improvement15%", "Poor5%"],
      measured: "Measured on 380 page loads.",
    });
    expect(cardFigures("Interaction to Next Paint (INP), p75")).toEqual({
      value: "240 ms",
      rating: "Needs improvement",
      shares: ["Good60%", "Needs improvement30%", "Poor10%"],
      measured: "Measured on 150 page loads. INP only counts loads with an interaction.",
    });
    expect(cardFigures("Cumulative Layout Shift (CLS), p75")).toEqual({
      value: "0.31",
      rating: "Poor",
      shares: ["Good50%", "Needs improvement25%", "Poor25%"],
      measured: "Measured on 400 page loads.",
    });
    await expect.element(page.getByText("When the main content appeared.")).toBeVisible();
    await expect
      .element(page.getByText("How quickly the page responded to clicks, taps, and key presses."))
      .toBeVisible();
    // Each explanation sits with its own figure.
    expect(statOf("Largest Contentful Paint (LCP), p75").textContent).toContain(
      "When the main content appeared.",
    );
    expect(statOf("Interaction to Next Paint (INP), p75").textContent).toContain(
      "How quickly the page responded to clicks, taps, and key presses.",
    );
    await expect
      .element(
        page.getByText(
          /^Values are the 75th percentile \(p75\) of 10 to 16 Nov 2026 \(Asia\/Singapore\): 75% of page loads were at least this fast\. Thresholds are Google's\.$/,
        ),
      )
      .toBeVisible();
  });

  test("shows FCP and TTFB with their ratings, to explain LCP", async () => {
    installFakeApi();
    renderApp(SPEED);

    await expect
      .element(page.getByRole("heading", { name: "Measurements before LCP" }))
      .toBeVisible();
    expect(secondary("First Contentful Paint (FCP), p75")).toBe("1.2 sGood");
    expect(secondary("Time to First Byte (TTFB), p75")).toBe("950 msNeeds improvement");
  });

  test("formats milliseconds as ms below a second and s from one, and CLS with two decimals", async () => {
    const fixture = speedFixture();
    installFakeApi({
      speed: () => ({
        ...fixture,
        metrics: {
          ...fixture.metrics,
          lcp: { ...fixture.metrics.lcp, p75: 999 },
          inp: { ...fixture.metrics.inp, p75: 1000 },
          cls: { ...fixture.metrics.cls, p75: 0.1 },
          ttfb: { ...fixture.metrics.ttfb, p75: 12_345 },
        },
      }),
    });
    renderApp(SPEED);

    await expect.element(card("Largest Contentful Paint (LCP), p75")).toBeVisible();
    expect(cardFigures("Largest Contentful Paint (LCP), p75").value).toBe("999 ms");
    expect(cardFigures("Interaction to Next Paint (INP), p75")).toMatchObject({
      value: "1.0 s",
      rating: "Poor",
    });
    // At the threshold is still good.
    expect(cardFigures("Cumulative Layout Shift (CLS), p75")).toMatchObject({
      value: "0.10",
      rating: "Good",
    });
    expect(secondary("Time to First Byte (TTFB), p75")).toBe("12.3 sPoor");
  });

  test("filters by device, in the address and the request", async () => {
    const api = installFakeApi();
    const router = renderApp(`${SPEED}?period=30d`);
    await expect.element(card("Largest Contentful Paint (LCP), p75")).toBeVisible();

    await page.getByRole("combobox", { name: "Device" }).click();
    await page.getByRole("option", { name: "Mobile" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", device: "mobile" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "30d", device: "mobile" });

    await page.getByRole("combobox", { name: "Device" }).click();
    await page.getByRole("option", { name: "All devices" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "30d" });
    // All devices again: the first answer, still fresh in the cache.
    await expect
      .element(page.getByRole("combobox", { name: "Device" }))
      .toMatchTextContent(/^All devices/);
  });

  test("reads the device from the address", async () => {
    const api = installFakeApi();
    renderApp(`${SPEED}?device=tablet`);
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", device: "tablet" });
    await expect
      .element(page.getByRole("combobox", { name: "Device" }))
      .toMatchTextContent(/^Tablet/);
  });

  test("ignores a device it does not know", async () => {
    const api = installFakeApi();
    const router = renderApp(`${SPEED}?device=watch`);
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    expect(router.state.location.search).toEqual({});
  });

  test("switches environment", async () => {
    const api = installFakeApi({
      speed: (query) => ({ ...fakeSpeed(query), environments: ["production", "staging"] }),
    });
    const router = renderApp(SPEED);
    await expect.element(card("Largest Contentful Paint (LCP), p75")).toBeVisible();

    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: "staging" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ env: "staging" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", environment: "staging" });
  });

  test("lists devices and pages with each p75 and its rating", async () => {
    installFakeApi();
    renderApp(SPEED);
    await expect.element(page.getByRole("table", { name: "Speed by device" })).toBeVisible();

    expect(tableRows("Speed by device")).toEqual([
      ["Desktop", "250", "1.8 sGood", "120 msGood", "0.05Good"],
      ["Mobile", "140", "4.6 sPoor", "520 msPoor", "0.30Poor"],
      ["(unknown)", "10", "–", "–", "0.00Good"],
    ]);
    expect(tableRows("Pages, most measured loads first")).toEqual([
      ["/", "200", "2.1 sGood", "180 msGood", "0.08Good"],
      ["/pricing", "120", "3.8 sNeeds improvement", "–", "0.12Needs improvement"],
    ]);
  });

  test("charts LCP per day, with the numbers on demand", async () => {
    installFakeApi();
    renderApp(SPEED);

    await expect.element(page.getByRole("slider", { name: "LCP per day, p75" })).toBeVisible();
    await page.getByRole("button", { name: "Show the numbers" }).click();
    const days = page.getByRole("table", { name: "Page loads and p75 per day" });
    await expect.element(days).toMatchTextContent(/Thu 12 Nov0–––/);
    await expect.element(days).toMatchTextContent(/Mon 16 Nov652\.4 s235 ms0\.32/);
  });

  test("says how Web Vitals are measured while there are none", async () => {
    installFakeApi({ speed: () => emptySpeed() });
    renderApp(SPEED);

    await expect.element(page.getByText("No page loads measured in this period")).toBeVisible();
    await expect.element(page.getByText("v.js", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(/navigation within the app has no values of its own/))
      .toBeVisible();
    await expect.element(page.getByText('data-vitals="off"', { exact: true })).toBeVisible();
    await expect.element(card("Largest Contentful Paint (LCP), p75")).not.toBeInTheDocument();
  });

  test("shows a failed load with a retry", async () => {
    let failing = true;
    installFakeApi({
      speed: (query) =>
        failing ? json({ message: "The database is down." }, 503) : fakeSpeed(query),
    });
    renderApp(SPEED);

    await expect.element(page.getByText("The speed report could not load")).toBeVisible();
    await expect.element(page.getByText("The database is down.")).toBeVisible();

    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    await expect.element(card("Largest Contentful Paint (LCP), p75")).toBeVisible();
    await expect.element(page.getByText("The speed report could not load")).not.toBeInTheDocument();
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      speed: () => json({ error: "not_found", message: "No project has this ID." }, 404),
    });
    renderApp(SPEED);

    await expect.element(page.getByText("No such project")).toBeVisible();
  });
});

describe("ratings near a threshold", () => {
  test("follow the value as shown, so a badge never contradicts its number", () => {
    const lcp = [2500, 4000] as const;
    expect([formatVital("lcp", 2549), rate("lcp", 2549, lcp)]).toEqual(["2.5 s", "good"]);
    expect([formatVital("lcp", 2551), rate("lcp", 2551, lcp)]).toEqual([
      "2.6 s",
      "needsImprovement",
    ]);
    const cls = [0.1, 0.25] as const;
    expect([formatVital("cls", 0.1049), rate("cls", 0.1049, cls)]).toEqual(["0.10", "good"]);
    expect([formatVital("inp", 200.4), rate("inp", 200.4, [200, 500])]).toEqual(["200 ms", "good"]);
  });
});
