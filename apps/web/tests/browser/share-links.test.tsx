import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { resetThemeForTests } from "../../src/lib/theme.ts";
import { emulateColorScheme } from "./color-scheme.ts";
import {
  analyticsFixture,
  FAKE_SHARE_TOKEN,
  fakeShareLink,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp, renderShare } from "./render.tsx";

/*
 * Shared links (docs/web-analytics.md, "Shared links"): the project
 * settings' tab that makes, copies, and revokes them, and the page a link
 * opens, without signing in.
 */

const SETTINGS = `/projects/${PROJECT.id}/settings?tab=shared-links`;
const SHARED = `/share/${FAKE_SHARE_TOKEN}`;

/** Stands in for the clipboard, which a headless browser may refuse. */
const fakeClipboard = () => vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

const panel = () => page.getByRole("tabpanel");

beforeEach(async () => {
  await page.viewport(1280, 900);
});

describe("the Shared links tab", () => {
  test("lists the links by name and first characters, never a whole address", async () => {
    installFakeApi();
    renderApp(SETTINGS);
    await expect.element(panel().getByRole("heading", { name: "Shared links" })).toBeVisible();
    const row = panel().getByRole("row", { name: /For the client/ });
    await expect.element(row).toBeVisible();
    await expect.element(row).toMatchTextContent(/production/);
    await expect.element(row).toMatchTextContent(/a-shar…/);
    await expect.element(row).toMatchTextContent(/by Ada Owner/);
    expect(document.body.textContent).not.toContain(FAKE_SHARE_TOKEN);
  });

  test("makes a link, shows its address once with a copy button, then lists it", async () => {
    const api = installFakeApi({ shareLinks: [] });
    const writeText = fakeClipboard();
    renderApp(SETTINGS);
    await expect.element(panel().getByText("No shared links")).toBeVisible();
    await panel().getByRole("button", { name: "New link" }).click();
    const dialog = page.getByRole("dialog", { name: "New shared link" });
    await dialog.getByLabelText("Name").fill("For the client");
    await expect.element(dialog.getByLabelText("Environment")).toHaveValue("production");
    await dialog.getByLabelText("Environment").fill("Staging");
    await dialog.getByRole("button", { name: "Make link" }).click();

    const shown = page.getByRole("dialog", { name: "Copy the link" });
    const url = `${window.location.origin}/share/${FAKE_SHARE_TOKEN}`;
    await expect.element(shown.getByText(url)).toBeVisible();
    await expect.element(shown.getByText(/can't be shown again/)).toBeVisible();
    await shown.getByRole("button", { name: "Copy the link" }).click();
    expect(writeText).toHaveBeenCalledWith(url);
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: `/api/projects/${PROJECT.id}/share-links`,
      body: { name: "For the client", environment: "Staging" },
    });

    await shown.getByRole("button", { name: "Done" }).click();
    await expect.element(shown).not.toBeInTheDocument();
    await expect
      .element(panel().getByRole("row", { name: /For the client/ }))
      .toMatchTextContent(/staging/);
    expect(document.body.textContent).not.toContain(FAKE_SHARE_TOKEN);
  });

  test("revokes a link after asking", async () => {
    const api = installFakeApi({
      shareLinks: [fakeShareLink(), fakeShareLink({ id: "other-link", name: "Board" })],
    });
    renderApp(SETTINGS);
    await panel().getByRole("button", { name: "Revoke Board" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke Board?" });
    await expect.element(dialog.getByText(/stops working at once/)).toBeVisible();
    await dialog.getByRole("button", { name: "Revoke link" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(panel().getByRole("row", { name: /Board/ })).not.toBeInTheDocument();
    await expect.element(panel().getByRole("row", { name: /For the client/ })).toBeVisible();
    expect(api.requests).toContain(`/api/projects/${PROJECT.id}/share-links/other-link`);
    expect(api.shareLinks.map((link) => link.name)).toEqual(["For the client"]);
  });

  test("at the limit, New link says why it is off", async () => {
    installFakeApi({
      shareLinks: Array.from({ length: 10 }, (_, index) =>
        fakeShareLink({ id: `link-${index}`, name: `Link ${index}` }),
      ),
    });
    renderApp(SETTINGS);
    await expect.element(panel().getByRole("button", { name: "New link" })).toBeDisabled();
    await expect.element(panel().getByText(/at most 10 shared links/)).toBeVisible();
  });
});

describe("a shared link's page", () => {
  test("shows the project's Web analytics, read-only, with no sidebar and no dashboard requests", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi({ signedIn: false });
    renderShare(SHARED);

    await expect.element(page.getByRole("heading", { level: 1 })).toMatchTextContent(/Main site/);
    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    await expect.element(page.getByText("Shared with Ottertrail. Read-only.")).toBeVisible();
    await expect.element(page.getByText("3 visitors now")).toBeVisible();
    expect(document.title).toBe("Main site: Web analytics");

    // No shell, no way into the dashboard, nothing to change.
    expect(document.querySelector("[data-sidebar]")).toBeNull();
    expect(document.querySelector('a[href^="/projects"]')).toBeNull();
    expect(document.querySelector('a[aria-label^="Heatmap of "]')).toBeNull();
    expect(document.querySelector('a[aria-label^="Open the "]')).toBeNull();
    await expect.element(page.getByRole("button", { name: "Add goal" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: "Environment" }))
      .not.toBeInTheDocument();

    // Only the link's own routes, never the session's or a project's.
    expect(api.requests.length).toBeGreaterThan(0);
    for (const path of api.requests) {
      expect(path.startsWith(`/api/share/${FAKE_SHARE_TOKEN}`)).toBe(true);
      expect(path).not.toContain("environment=");
    }
  });

  test("filters, the goal filter, and the period work within the link", async () => {
    const api = installFakeApi({ signedIn: false });
    const history = renderShare(SHARED);
    await page.getByRole("link", { name: "Filter by Country: Germany" }).click();
    await expect.element(page.getByRole("list", { name: "Filters" })).toMatchTextContent(/Germany/);
    expect(history.location.pathname).toBe(SHARED);
    expect(history.location.search).toBe("?country=DE");
    await expect
      .poll(() => api.requests.at(-1))
      .toMatch(new RegExp(`^/api/share/${FAKE_SHARE_TOKEN}/analytics\\?period=7d&country=DE$`));

    await page.getByRole("link", { name: "Filter by Goal: Saw pricing" }).click();
    expect(history.location.search).toContain("goal=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");

    await page.getByRole("link", { name: "Clear filters" }).click();
    expect(history.location.search).toBe("");

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    expect(history.location.search).toBe("?period=30d");
    await expect
      .poll(() => api.requests.some((path) => path.endsWith("/analytics?period=30d")))
      .toBe(true);
  });

  test("Show all reads the link's full list", async () => {
    const api = installFakeApi({
      signedIn: false,
      analytics: () =>
        analyticsFixture({
          pages: Array.from({ length: 10 }, (_, i) => ({
            path: `/page-${i + 1}`,
            pageviews: 900 - i,
            visitors: 500 - i,
            avgEngagedMs: null,
          })),
        }),
    });
    renderShare(SHARED);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect.element(page.getByRole("dialog", { name: "Pages: Top pages" })).toBeVisible();
    await expect
      .poll(() =>
        api.requests.some((path) =>
          path.startsWith(`/api/share/${FAKE_SHARE_TOKEN}/analytics/list?`),
        ),
      )
      .toBe(true);
  });

  test("fits a phone, 390 wide", async () => {
    await page.viewport(390, 844);
    installFakeApi({ signedIn: false });
    renderShare(SHARED);
    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    await expect.element(page.getByRole("heading", { level: 1 })).toMatchTextContent(/Main site/);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test("shows the outbound links, file downloads, and not found pages, read-only", async () => {
    installFakeApi({ signedIn: false });
    const history = renderShare(SHARED);
    for (const title of ["Outbound links", "File downloads", "Not found pages"]) {
      await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
    }
    await expect
      .element(
        page.getByRole("link", {
          name: "Filter by File download: acme.example/files/price-list.pdf",
        }),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Filter by Not found page: /old-pricing" }))
      .toBeVisible();
    // A row filters the shared page, as on the dashboard; none leads off it.
    expect(document.querySelector('a[href^="http"]')).toBeNull();
    await page
      .getByRole("link", { name: "Filter by Outbound link: github.com/acme/shop-sdk" })
      .click();
    expect(history.location.pathname).toBe(SHARED);
    expect(history.location.search).toBe("?outbound=https%3A%2F%2Fgithub.com%2Facme%2Fshop-sdk");
  });

  test.each([
    [390, "dark"],
    [390, "light"],
    [1440, "dark"],
    [1440, "light"],
  ] as const)(
    "at %i wide, %s, no list cell paints a band of another surface",
    async (width, scheme) => {
      await page.viewport(width, 900);
      await emulateColorScheme(scheme);
      resetThemeForTests();
      installFakeApi({ signedIn: false });
      renderShare(SHARED);
      await expect.element(page.getByRole("heading", { name: "Not found pages" })).toBeVisible();
      const surface = getComputedStyle(
        document.querySelector("main")?.parentElement ?? document.body,
      ).backgroundColor;
      expect(surface).not.toBe("rgba(0, 0, 0, 0)");
      const cells = [...document.querySelectorAll("main table th, main table td")];
      expect(cells.length).toBeGreaterThan(50);
      for (const cell of cells) {
        const color = getComputedStyle(cell).backgroundColor;
        expect([surface, "rgba(0, 0, 0, 0)"]).toContain(color);
      }
    },
  );

  test("a revoked or unknown link says it does not work", async () => {
    installFakeApi({ signedIn: false, sharedPages: {} });
    renderShare(SHARED);
    await expect.element(page.getByText("This link does not work")).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Visitors per day" }))
      .not.toBeInTheDocument();
  });

  test("an address without a token says so, and asks the API nothing", async () => {
    const api = installFakeApi({ signedIn: false });
    renderShare("/share/");
    await expect.element(page.getByText("This link does not work")).toBeVisible();
    expect(api.requests).toEqual([]);
  });
});

test("the dashboard's own page still links to heatmaps and Right now", async () => {
  installFakeApi();
  renderApp(`/projects/${PROJECT.id}/web-analytics`);
  await expect.element(page.getByRole("link", { name: /visitors? now$/ })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Heatmap of /pricing" }).first())
    .toBeVisible();
});
