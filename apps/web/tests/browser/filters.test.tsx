import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  analyticsFixture,
  emptyAnalytics,
  fakeList,
  type FakeApi,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The query of the page's latest analytics request, such as { period: "7d", country: "DE" }. */
function lastQuery(api: FakeApi): Record<string, string> {
  const path = api.requests.findLast((request) => request.includes("/analytics?")) ?? "";
  return Object.fromEntries(new URLSearchParams(path.slice(path.indexOf("?") + 1)));
}

const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;
const currentHref = (router: ReturnType<typeof renderApp>) => router.state.location.href;

/** The active filters as their chips read, such as ["Country is Germany"]. */
function chips(): string[] {
  const list = document.querySelector("ul[aria-label=Filters]");
  return [...(list?.querySelectorAll("li") ?? [])].map((item) => item.textContent);
}

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("filters", () => {
  test("a row filters the whole page to its visits", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Country: Germany" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ country: "DE" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", country: "DE" });
    await expect.poll(chips).toEqual(["Country is Germany"]);
  });

  test("a page from Top pages filters to the visits that viewed it", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Page: /pricing" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ page: "/pricing" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", page: "/pricing" });
  });

  test("an Unknown row filters to visits where the value is unknown", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Country: Unknown" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ country: "" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", country: "" });
    await expect.poll(chips).toEqual(["Country is Unknown"]);
  });

  test("filters combine, and each can be removed, or all at once", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE&source=google.com`);

    await expect.poll(chips).toEqual(["Source is google.com", "Country is Germany"]);
    expect(lastQuery(api)).toEqual({ period: "7d", source: "google.com", country: "DE" });

    await page.getByRole("link", { name: "Remove the filter Source is google.com" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ country: "DE" });
    await expect.poll(chips).toEqual(["Country is Germany"]);

    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({});
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    await expect.element(page.getByRole("list", { name: "Filters" })).not.toBeInTheDocument();
  });

  test("a new period keeps the filters", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ period: "30d", country: "DE" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "30d", country: "DE" });
  });

  test("a value the address bar reads as a number stays text", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?city=2024`);

    await expect.poll(chips).toEqual(["City is 2024"]);
    expect(lastQuery(api)).toEqual({ period: "7d", city: "2024" });
  });

  test("keeps a hand-written value exactly, even one that looks like a number", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?utmCampaign=2024.10&city=1e3&os=12345678901234567890`);

    await expect
      .poll(chips)
      .toEqual(["Campaign is 2024.10", "City is 1e3", "Operating system is 12345678901234567890"]);
    expect(lastQuery(api)).toEqual({
      period: "7d",
      utmCampaign: "2024.10",
      city: "1e3",
      os: "12345678901234567890",
    });
  });

  test("a value that looks like a number survives the app's own links", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?city=2024`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();

    await expect.poll(() => lastQuery(api)).toEqual({ period: "30d", city: "2024" });
    expect(currentHref(router)).toBe(`${ANALYTICS}?period=30d&city=%222024%22`);
    await expect.poll(chips).toEqual(["City is 2024"]);
  });

  test("ignores a value it cannot use, instead of sending it", async () => {
    const api = installFakeApi();
    const object = encodeURIComponent(JSON.stringify({ a: 1 }));
    renderApp(
      `${ANALYTICS}?country=${object}&page=/${"a".repeat(2048)}&region=%00&source=google.com`,
    );

    await expect.poll(chips).toEqual(["Source is google.com"]);
    expect(lastQuery(api)).toEqual({ period: "7d", source: "google.com" });
  });

  test("says when no visit matches, with a way to clear the filters", async () => {
    const api = installFakeApi({
      analytics: (_id, _period, query) =>
        query.has("country") ? emptyAnalytics() : analyticsFixture(),
    });
    const router = renderApp(`${ANALYTICS}?country=FR`);

    await expect.element(page.getByText("No visits match these filters")).toBeVisible();
    await page.getByRole("main").getByRole("link", { name: "Clear filters" }).last().click();

    await expect.poll(() => addressQuery(router)).toEqual({});
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
  });
});

/** Every parameter of the page's latest analytics request, repeats kept, in order. */
function lastParams(api: FakeApi): [string, string][] {
  const path = api.requests.findLast((request) => request.includes("/analytics?")) ?? "";
  return [...new URLSearchParams(path.slice(path.indexOf("?") + 1)).entries()];
}

/** The address after the page's path, as the address bar shows it, decoded. */
const addressText = (router: ReturnType<typeof renderApp>) =>
  decodeURIComponent(router.state.location.href.slice(ANALYTICS.length));

/** Countries for the value picker, found by code or English name as the API finds them. */
const COUNTRIES: [string | null, string][] = [
  ["DE", "germany"],
  ["FR", "france"],
  ["SG", "singapore"],
  [null, "unknown"],
];
function countryList(query: URLSearchParams) {
  if (query.get("report") !== "country") return fakeList(query);
  const search = (query.get("search") ?? "").toLowerCase();
  const rows = COUNTRIES.filter(
    ([code, name]) => name.includes(search) || (code ?? "").toLowerCase().includes(search),
  ).map(([value], index) => ({ value, visitors: 100 - index, visits: 110, bounceRate: 0.5 }));
  return { rows, hasMore: false };
}

describe("operators and several values", () => {
  test("the address holds each filter as its own parameter, repeated for several values", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?country=DE&country=FR&page.contains=/blog&deviceType.not=mobile`);

    await expect
      .poll(chips)
      .toEqual(["Page contains /blog", "Country is Germany, France", "Device is not Mobile"]);
    expect(lastParams(api)).toEqual([
      ["period", "7d"],
      ["page.contains", "/blog"],
      ["country", "DE"],
      ["country", "FR"],
      ["deviceType.not", "mobile"],
    ]);
  });

  test("adds a contains filter from typed text", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("combobox", { name: "Filter by" }).click();
    await page.getByRole("option", { name: "Page", exact: true }).click();
    await page.getByRole("combobox", { name: "Operator" }).click();
    await page.getByRole("option", { name: "contains", exact: true }).click();
    const text = page.getByRole("textbox", { name: "Text to look for" });
    await text.fill("/blog");
    await userEvent.keyboard("{Enter}");
    await text.fill("/Docs");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .element(page.getByRole("list", { name: "Values" }))
      .toHaveTextContent("/blog/Docs");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect.poll(() => addressText(router)).toBe("?page.contains=/blog&page.contains=/Docs");
    await expect.poll(chips).toEqual(["Page contains /blog, /Docs"]);
    expect(lastParams(api)).toEqual([
      ["period", "7d"],
      ["page.contains", "/blog"],
      ["page.contains", "/Docs"],
    ]);
  });

  test("picks is not values from the dimension's list, with search", async () => {
    const api = installFakeApi({ list: countryList });
    const router = renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("combobox", { name: "Filter by" }).click();
    await page.getByRole("option", { name: "Country" }).click();
    // A fixed value takes is and is not only.
    await page.getByRole("combobox", { name: "Operator" }).click();
    await expect.element(page.getByRole("option", { name: "is not" })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: "contains", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("option", { name: "is not" }).click();

    const values = page.getByRole("combobox", { name: "Search country values" });
    await values.fill("germ");
    // The API searches, as Show all does, and only its rows are offered.
    await expect
      .poll(() =>
        api.requests.some(
          (request) => request.includes("report=country") && request.includes("search=germ"),
        ),
      )
      .toBe(true);
    await expect.element(page.getByRole("option", { name: "France" })).not.toBeInTheDocument();
    await page.getByRole("option", { name: "Germany" }).click();
    await values.fill("fra");
    await page.getByRole("option", { name: "France" }).click();
    await page.getByText("Add a filter").click();
    await expect
      .element(page.getByRole("list", { name: "Values" }))
      .toHaveTextContent("GermanyFrance");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect.poll(() => addressText(router)).toBe("?country.not=DE&country.not=FR");
    await expect.poll(chips).toEqual(["Country is not Germany, France"]);
  });

  test("a chip opens its editor: another operator, a value removed and one added", async () => {
    installFakeApi({ list: countryList });
    const router = renderApp(`${ANALYTICS}?country=DE&country=FR&source=google.com`);

    await page.getByRole("button", { name: "Edit the filter Country is Germany, France" }).click();
    await page.getByRole("combobox", { name: "Operator" }).click();
    await page.getByRole("option", { name: "is not" }).click();
    await page.getByRole("button", { name: "Remove Germany" }).click();
    await page.getByRole("combobox", { name: "Search country values" }).fill("sing");
    await page.getByRole("option", { name: "Singapore" }).click();
    await page.getByText("Edit the filter", { exact: true }).click();
    await page.getByRole("button", { name: "Apply" }).click();

    await expect
      .poll(() => addressText(router))
      .toBe("?source=google.com&country.not=FR&country.not=SG");
    await expect.poll(chips).toEqual(["Source is google.com", "Country is not France, Singapore"]);
  });

  test("an operator the dimension already has joins its values into that filter", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE&country.not=FR`);

    await page.getByRole("button", { name: "Edit the filter Country is Germany" }).click();
    await page.getByRole("combobox", { name: "Operator" }).click();
    await page.getByRole("option", { name: "is not" }).click();
    await page.getByRole("button", { name: "Apply" }).click();

    await expect.poll(() => addressText(router)).toBe("?country.not=FR&country.not=DE");
    await expect.poll(chips).toEqual(["Country is not France, Germany"]);
  });

  test("the chip opens and closes its editor, and the focus goes back to it", async () => {
    installFakeApi();
    renderApp(`${ANALYTICS}?page.contains=/blog`);
    const chip = page.getByRole("button", { name: "Edit the filter Page contains /blog" });

    await expect.element(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect.element(page.getByRole("button", { name: "Apply" })).toBeVisible();
    await expect.element(chip).toHaveAttribute("aria-expanded", "true");
    // A second press on the chip closes it rather than opening it again.
    await chip.click();
    await expect.element(page.getByRole("button", { name: "Apply" })).not.toBeInTheDocument();

    await chip.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => document.activeElement === chip.element()).toBe(true);
  });

  test("Cancel and Escape leave the filters as they were", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?page.contains=/blog`);

    await page.getByRole("button", { name: "Edit the filter Page contains /blog" }).click();
    await page.getByRole("button", { name: "Remove /blog" }).click();
    // With no values left, there is nothing to apply.
    await expect.element(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("button", { name: "Apply" })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Edit the filter Page contains /blog" }).click();
    await page.getByRole("button", { name: "Remove /blog" }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Apply" })).not.toBeInTheDocument();

    expect(addressText(router)).toBe("?page.contains=/blog");
    await expect.poll(chips).toEqual(["Page contains /blog"]);
  });

  test("switching to contains drops Unknown, which typed text cannot match", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?city=&city=Munich`);

    await page.getByRole("button", { name: "Edit the filter City is Unknown, Munich" }).click();
    await page.getByRole("combobox", { name: "Operator" }).click();
    await page.getByRole("option", { name: "does not contain" }).click();
    await expect.element(page.getByRole("list", { name: "Values" })).toHaveTextContent("Munich");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect.poll(() => addressText(router)).toBe("?city.notContains=Munich");
    await expect.poll(chips).toEqual(["City does not contain Munich"]);
  });

  test("a row sets is <value>, replacing an is filter of its name and keeping the others", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=SG&country=DE&page.notContains=/admin`);

    await page.getByRole("link", { name: "Filter by Country: Germany" }).click();

    await expect.poll(() => addressText(router)).toBe("?page.notContains=/admin&country=DE");
    await expect.poll(chips).toEqual(["Page does not contain /admin", "Country is Germany"]);
  });

  test("keeps at most 10 values of a filter, and refuses contains on a fixed value", async () => {
    const api = installFakeApi();
    const many = Array.from({ length: 12 }, (_, index) => `page=/p${index}`).join("&");
    renderApp(`${ANALYTICS}?${many}&country.contains=D&os.notContains=mac`);

    await expect.poll(() => lastParams(api).length).toBe(11);
    expect(lastParams(api).at(-1)).toEqual(["page", "/p9"]);
    await expect.poll(chips).toHaveLength(1);
  });

  test("the editor fits a phone's screen", async () => {
    installFakeApi({ list: countryList });
    await page.viewport(390, 844);
    renderApp(`${ANALYTICS}?country=DE`);

    await page.getByRole("button", { name: "Edit the filter Country is Germany" }).click();
    const popup = page.getByRole("dialog");
    await expect.element(popup).toBeVisible();
    const box = popup.element().getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await page.getByRole("combobox", { name: "Search country values" }).click();
    await expect.element(page.getByRole("option", { name: "France" })).toBeVisible();
    const list = page.getByRole("listbox").element().getBoundingClientRect();
    expect(list.right).toBeLessThanOrEqual(390);
  });
});
