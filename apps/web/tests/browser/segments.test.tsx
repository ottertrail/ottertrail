import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  FAKE_SHARE_TOKEN,
  type FakeApi,
  fakeSegment,
  installFakeApi,
  OWNER_ACCESS,
  PROJECT,
} from "./fake-api.ts";
import { renderApp, renderShare } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;

/** The active filters as their chips read, such as ["Country is Germany"]. */
function chips(): string[] {
  const list = document.querySelector("ul[aria-label=Filters]");
  return [...(list?.querySelectorAll("li") ?? [])].map((item) => item.textContent);
}

/** The query of the page's latest analytics request. */
function lastQuery(api: FakeApi): Record<string, string[]> {
  const path = api.requests.findLast((request) => request.includes("/analytics?")) ?? "";
  const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  return Object.fromEntries([...new Set(query.keys())].map((key) => [key, query.getAll(key)]));
}

const segmentsButton = () => page.getByRole("button", { name: /^Segments/ });

async function openMenu() {
  await segmentsButton().click();
  await expect.element(page.getByRole("menu")).toBeVisible();
}

const MEMBER = {
  ...OWNER_ACCESS,
  role: "member" as const,
  projects: [PROJECT.id],
  areas: { ...OWNER_ACCESS.areas, web_analytics: "view" as const },
};

const BLOG = fakeSegment({
  id: "5e5e5e5e-0000-4000-8000-000000000002",
  name: "Blog readers",
  visibility: "personal",
  filters: { "page.contains": ["/blog"] },
});

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("segments", () => {
  test("applying one replaces the filters and keeps the period and goal, and marks it", async () => {
    const api = installFakeApi({ segments: [fakeSegment(), BLOG] });
    const router = renderApp(`${ANALYTICS}?period=30d&goalEvent=signup&source=google.com`);
    await expect.poll(chips).toEqual(["Goal: signup", "Source is google.com"]);

    await openMenu();
    await expect.element(page.getByRole("group", { name: "Project segments" })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Your segments" })).toBeVisible();
    await page.getByRole("menuitem", { name: "German visitors" }).click();

    await expect
      .poll(() => addressQuery(router))
      .toEqual({ period: "30d", goalEvent: "signup", country: "DE" });
    await expect.poll(chips).toEqual(["Goal: signup", "Country is Germany"]);
    await expect.poll(() => lastQuery(api).country).toEqual(["DE"]);
    await expect
      .element(page.getByRole("button", { name: "Segments, German visitors applied" }))
      .toBeVisible();
    await openMenu();
    await expect
      .element(page.getByRole("menuitem", { name: "German visitors" }))
      .toHaveAttribute("aria-current", "true");
    await expect
      .element(page.getByRole("menuitem", { name: "Blog readers" }))
      .not.toHaveAttribute("aria-current");
    await userEvent.keyboard("{Escape}");

    // Once the filters change, the mark goes.
    await page.getByRole("link", { name: "Remove the filter Country is Germany" }).click();
    await expect.poll(chips).toEqual(["Goal: signup"]);
    await expect.element(page.getByRole("button", { name: "Segments", exact: true })).toBeVisible();
  });

  test("saves the current filters, for oneself or for the project", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?country=DE&page.contains=/blog`);
    await openMenu();
    await expect.element(page.getByText("No saved segments yet.")).toBeVisible();
    await page.getByRole("menuitem", { name: "Save current filters…" }).click();

    const dialog = page.getByRole("dialog", { name: "Save the filters as a segment" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Page contains /blog; Country is Germany")).toBeVisible();
    await dialog.getByRole("button", { name: "Save segment" }).click();
    await expect.element(dialog.getByText("Name the segment.")).toBeVisible();
    await dialog.getByRole("textbox", { name: "Name" }).fill("  German blog ");
    await dialog.getByRole("radio", { name: "Everyone in the project" }).click();
    await dialog.getByRole("button", { name: "Save segment" }).click();
    await expect.element(dialog).not.toBeInTheDocument();

    expect(api.segments).toMatchObject([
      {
        name: "German blog",
        visibility: "project",
        filters: { country: ["DE"], "page.contains": ["/blog"] },
      },
    ]);
    // Saved from the filters shown, so it is the one applied.
    await expect
      .element(page.getByRole("button", { name: "Segments, German blog applied" }))
      .toBeVisible();

    // A name taken shows in the dialog.
    await openMenu();
    await page.getByRole("menuitem", { name: "Save current filters…" }).click();
    await dialog.getByRole("textbox", { name: "Name" }).fill("german BLOG");
    await dialog.getByRole("radio", { name: "Everyone in the project" }).click();
    await dialog.getByRole("button", { name: "Save segment" }).click();
    await expect
      .element(dialog.getByText("The project already has a segment with this name."))
      .toBeVisible();
  });

  test("updates, renames, and deletes a segment from Manage segments", async () => {
    const api = installFakeApi({ segments: [fakeSegment(), BLOG] });
    renderApp(`${ANALYTICS}?country=FR`);
    await openMenu();
    await page.getByRole("menuitem", { name: "Manage segments…" }).click();
    const manage = page.getByRole("dialog", { name: "Segments" });
    await expect.element(manage).toBeVisible();

    await manage.getByRole("button", { name: "Save current filters to German visitors" }).click();
    await expect.poll(() => api.segments[0]?.filters).toEqual({ country: ["FR"] });
    await expect.element(manage.getByText("Applied")).toBeVisible();
    await expect
      .element(manage.getByRole("button", { name: "Save current filters to German visitors" }))
      .toBeDisabled();

    await manage.getByRole("button", { name: "Rename Blog readers" }).click();
    const rename = page.getByRole("dialog", { name: "Rename the segment" });
    await rename.getByRole("textbox", { name: "Name" }).fill("Blog fans");
    await rename.getByRole("button", { name: "Rename" }).click();
    await expect.element(rename).not.toBeInTheDocument();
    await expect
      .poll(() => api.segments[1])
      .toMatchObject({
        name: "Blog fans",
        filters: { "page.contains": ["/blog"] },
      });

    await manage.getByRole("button", { name: "Delete Blog fans" }).click();
    const remove = page.getByRole("dialog", { name: "Delete the segment “Blog fans”?" });
    await remove.getByRole("button", { name: "Delete segment" }).click();
    await expect.poll(() => api.segments.map((item) => item.name)).toEqual(["German visitors"]);
    await expect.element(manage.getByText("Blog fans")).not.toBeInTheDocument();
  });

  test("a segment the page no longer takes is shown as invalid, never applied", async () => {
    const api = installFakeApi({
      segments: [
        fakeSegment({ name: "Gone", filters: null }),
        fakeSegment({
          id: "5e5e5e5e-0000-4000-8000-000000000003",
          name: "Contains a country",
          filters: { "country.contains": ["D"] },
        }),
      ],
    });
    const router = renderApp(`${ANALYTICS}?source=google.com`);
    await openMenu();
    for (const name of ["Gone", "Contains a country"]) {
      const item = page.getByRole("menuitem", { name: new RegExp(`^${name}`) });
      await expect.element(item).toHaveAttribute("aria-disabled", "true");
      await expect.element(item.getByText("Invalid")).toBeVisible();
    }
    await page.getByRole("menuitem", { name: "Manage segments…" }).click();
    const manage = page.getByRole("dialog", { name: "Segments" });
    await expect.element(manage.getByText(/no longer takes/).first()).toBeVisible();
    await expect.element(manage.getByRole("button", { name: "Rename Gone" })).toBeDisabled();
    expect(addressQuery(router)).toEqual({ source: "google.com" });
    // Saving the current filters over it makes it usable.
    await manage.getByRole("button", { name: "Save current filters to Gone" }).click();
    await expect.poll(() => api.segments[0]?.filters).toEqual({ source: ["google.com"] });
  });

  test("a member saves personal segments only, and cannot change the project's", async () => {
    const api = installFakeApi({ access: MEMBER, segments: [fakeSegment(), BLOG] });
    renderApp(`${ANALYTICS}?country=DE`);
    await openMenu();
    await page.getByRole("menuitem", { name: "Save current filters…" }).click();
    const dialog = page.getByRole("dialog", { name: "Save the filters as a segment" });
    await expect.element(dialog.getByRole("radio")).not.toBeInTheDocument();
    await dialog.getByRole("textbox", { name: "Name" }).fill("Mine");
    await dialog.getByRole("button", { name: "Save segment" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(api.segments.at(-1)).toMatchObject({ name: "Mine", visibility: "personal" });

    await openMenu();
    await page.getByRole("menuitem", { name: "Manage segments…" }).click();
    const manage = page.getByRole("dialog", { name: "Segments" });
    await expect.element(manage.getByText(/Only the owner and admins change them\./)).toBeVisible();
    await expect.element(manage.getByRole("button", { name: "Delete Blog readers" })).toBeVisible();
    await expect
      .element(manage.getByRole("button", { name: "Delete German visitors" }))
      .not.toBeInTheDocument();
  });

  test("fit a phone", async () => {
    await page.viewport(390, 844);
    installFakeApi({
      segments: [
        fakeSegment({ name: "A rather long segment name that will not fit on a phone screen" }),
        BLOG,
      ],
    });
    renderApp(`${ANALYTICS}?country=DE`);
    await openMenu();
    const menu = page.getByRole("menu").element();
    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    await page.getByRole("menuitem", { name: /^A rather long/ }).click();
    await expect
      .element(page.getByRole("button", { name: /^Segments, A rather long/ }))
      .toBeVisible();
    expect(segmentsButton().element().getBoundingClientRect().right).toBeLessThanOrEqual(390);

    await openMenu();
    await page.getByRole("menuitem", { name: "Manage segments…" }).click();
    const manage = page.getByRole("dialog", { name: "Segments" });
    await expect.element(manage).toBeVisible();
    expect(manage.element().getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test("a shared link has no Segments menu", async () => {
    installFakeApi({ signedIn: false, segments: [fakeSegment()] });
    renderShare(`/share/${FAKE_SHARE_TOKEN}?country=DE`);
    await expect.poll(chips).toEqual(["Country is Germany"]);
    await expect.element(page.getByRole("button", { name: "Filter" })).toBeVisible();
    await expect.element(segmentsButton()).not.toBeInTheDocument();
  });
});
