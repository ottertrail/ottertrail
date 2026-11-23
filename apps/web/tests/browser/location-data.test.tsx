import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { LocationDataStatus } from "../../src/lib/settings-api.ts";
import { ADMIN_ACCESS, installFakeApi, LOCATION_DATA, SETTINGS } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const section = () => page.getByRole("form", { name: "Location data" });
const locations = () => section().getByRole("region", { name: "Location database" });
const dataCenters = () => section().getByRole("region", { name: "Data-center ranges" });
const toggle = () => section().getByRole("switch", { name: "Update location data automatically" });
const save = () => page.getByRole("button", { name: "Save location data settings" });

const NOTHING = { loaded: null, loadError: null, lastUpdate: null };

/** The Settings page's Location data tab (the General tab opens first). */
const LOCATION_TAB = "/settings?tab=location-data";

/**
 * The location database downloaded by the worker `minutesAgo` by the
 * server's clock, newer than the one the API loaded. The browser's own
 * clock is days later (the tests run after November 2026's fixtures).
 */
function newerDownload(minutesAgo: number, loadError: string | null = null): LocationDataStatus {
  const at = "2026-11-17T04:00:00.000Z";
  return {
    ...LOCATION_DATA,
    now: new Date(Date.parse(at) + minutesAgo * 60_000).toISOString(),
    locations: {
      ...LOCATION_DATA.locations,
      loadError,
      lastUpdate: {
        ...LOCATION_DATA.locations.lastUpdate!,
        lastAttemptAt: at,
        lastSuccessAt: at,
        fileModifiedAt: at,
      },
    },
  };
}

describe("the location data on the instance's Settings page", () => {
  test("current: both files loaded, with their dates and last updates in the instance's timezone", async () => {
    installFakeApi();
    renderApp(LOCATION_TAB);

    await expect.element(page.getByRole("heading", { name: "Location data" })).toBeVisible();
    await expect.element(toggle()).toBeChecked();
    await expect.element(locations().getByText("Loaded")).toBeVisible();
    await expect
      .element(locations().getByText(/DB-IP City Lite, built 1 Nov 2026\./))
      .toBeVisible();
    // 04:00 UTC is noon in Singapore.
    await expect.element(locations().getByText("Last updated 15 Nov 2026, 12:00.")).toBeVisible();
    await expect
      .element(locations().getByRole("link", { name: "IP geolocation by DB-IP" }))
      .toHaveAttribute("href", "https://db-ip.com");
    await expect.element(dataCenters().getByText("Loaded")).toBeVisible();
    await expect
      .element(dataCenters().getByText("14 cloud and hosting providers, downloaded 17 Nov 2026."))
      .toBeVisible();
    await expect.element(section().getByRole("alert")).not.toBeInTheDocument();
    await expect.element(section().getByText(/Automatic updates are off/)).not.toBeInTheDocument();
    await expect.element(section().getByText(/has not loaded/)).not.toBeInTheDocument();
  });

  test("never updated: both files missing, and what that means", async () => {
    installFakeApi({
      locationData: { ...LOCATION_DATA, locations: NOTHING, dataCenters: NOTHING },
    });
    renderApp(LOCATION_TAB);

    await expect.element(locations().getByText("Missing")).toBeVisible();
    await expect
      .element(
        locations().getByText(
          "No location database is loaded, so events are stored without a location.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        locations().getByText(
          "The worker downloads it within a minute or two, and the API loads it within 10 minutes.",
        ),
      )
      .toBeVisible();
    await expect.element(dataCenters().getByText("Missing")).toBeVisible();
    await expect
      .element(
        dataCenters().getByText(
          "No data-center ranges are loaded, so visits from cloud servers are not recognized as bots.",
        ),
      )
      .toBeVisible();
    await expect.element(section().getByText(/Last updated/)).not.toBeInTheDocument();
  });

  test("failed: the last attempt's error, with the old file still in use", async () => {
    installFakeApi({
      locationData: {
        ...LOCATION_DATA,
        locations: {
          ...LOCATION_DATA.locations,
          lastUpdate: {
            ...LOCATION_DATA.locations.lastUpdate!,
            lastAttemptAt: "2026-11-19T04:00:00.000Z",
            lastError: "the downloaded file failed its check: unexpected database",
          },
        },
      },
    });
    renderApp(LOCATION_TAB);

    await expect.element(locations().getByText("Update failed")).toBeVisible();
    await expect
      .element(locations().getByRole("alert"))
      .toHaveTextContent(
        "The last update failed on 19 Nov 2026, 12:00, and the file was kept as it was: the downloaded file failed its check: unexpected database. The worker tries again later on its own.",
      );
    // The file in use is still the good one.
    await expect
      .element(locations().getByText(/DB-IP City Lite, built 1 Nov 2026\./))
      .toBeVisible();
    await expect.element(dataCenters().getByText("Loaded")).toBeVisible();
    await expect.element(dataCenters().getByRole("alert")).not.toBeInTheDocument();
  });

  test("a new file the API is about to load says so, by the server's clock, not the browser's", async () => {
    // The browser's clock is days ahead of the server's answer.
    expect(Date.now() - Date.parse(newerDownload(2).now)).toBeGreaterThan(86_400_000);
    installFakeApi({ locationData: newerDownload(2) });
    renderApp(LOCATION_TAB);
    await expect
      .element(
        locations().getByText(
          /^A new file was downloaded on .*, and the API loads it within 10 minutes\.$/,
        ),
      )
      .toBeVisible();
    await expect.element(locations().getByText("Loaded")).toBeVisible();
  });

  test("a new file the API did not load within 15 minutes: the API's own error", async () => {
    installFakeApi({ locationData: newerDownload(30, "not a database") });
    renderApp(LOCATION_TAB);
    await expect.element(locations().getByText("Not loaded")).toBeVisible();
    await expect
      .element(
        locations().getByText(
          /^The API has not loaded the file downloaded on .*: not a database\.$/,
        ),
      )
      .toBeVisible();
  });

  test("a new file the API did not load, without an error: the shared folder to check", async () => {
    installFakeApi({ locationData: newerDownload(30) });
    renderApp(LOCATION_TAB);
    await expect.element(locations().getByText("Not loaded")).toBeVisible();
    await expect
      .element(locations().getByText(/share the location data folder \(the geo-data volume\)\.$/))
      .toBeVisible();
  });

  test("off: the switch is off, and a missing file says how to get it", async () => {
    installFakeApi({
      settings: { ...SETTINGS, updateLocationData: false },
      locationData: { ...LOCATION_DATA, locations: NOTHING },
    });
    renderApp(LOCATION_TAB);

    await expect.element(toggle()).not.toBeChecked();
    await expect
      .element(
        section().getByText(
          "Automatic updates are off. The files stay as they are until someone runs update-geo.mjs.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        locations().getByText("Automatic updates are off: run update-geo.mjs to download it."),
      )
      .toBeVisible();
  });

  test("the switch saves with the section's Save, and Discard undoes it", async () => {
    const api = installFakeApi();
    renderApp(LOCATION_TAB);

    await expect.element(toggle()).toBeChecked();
    await expect.element(section().getByText("No unsaved changes")).toBeVisible();
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    // The General tab's button has a name of its own.
    await page.getByRole("tab", { name: "General" }).click();
    await expect
      .element(page.getByRole("button", { name: "Save instance settings" }))
      .toBeVisible();
    await page.getByRole("tab", { name: "Location data" }).click();

    await toggle().click();
    await expect.element(section().getByText("Unsaved changes", { exact: true })).toBeVisible();
    await section().getByRole("button", { name: "Discard" }).click();
    await expect.element(toggle()).toBeChecked();
    await expect.element(section().getByText("No unsaved changes")).toBeVisible();
    expect(api.bodies).toEqual([]);

    await toggle().click();
    await save().click();
    await expect.element(section().getByText("No unsaved changes")).toBeVisible();
    expect(api.bodies).toEqual([
      { method: "PATCH", path: "/api/settings", body: { updateLocationData: false } },
    ]);
    await expect.element(toggle()).not.toBeChecked();
    await expect.element(section().getByText(/^Automatic updates are off\./)).toBeVisible();
    expect(api.settings.updateLocationData).toBe(false);
  });

  test("leaving with the switch changed asks first; unchanged, it does not", async () => {
    installFakeApi();
    const router = renderApp(LOCATION_TAB);
    const projects = page
      .getByRole("navigation", { name: "Instance" })
      .getByRole("link", { name: "Projects" });

    await expect.element(toggle()).toBeChecked();
    await toggle().click();
    await projects.click();
    const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Stay on this page" }).click();
    expect(router.state.location.pathname).toBe("/settings");
    await expect.element(toggle()).not.toBeChecked();

    await section().getByRole("button", { name: "Discard" }).click();
    await projects.click();
    await expect.poll(() => router.state.location.pathname).toBe("/projects");
    await expect.element(dialog).not.toBeInTheDocument();
  });

  test("with location lookup off, no database is needed", async () => {
    installFakeApi({
      locationData: { ...LOCATION_DATA, geoSource: "none", locations: NOTHING },
    });
    renderApp(LOCATION_TAB);

    await expect.element(locations().getByText("Not needed")).toBeVisible();
    await expect
      .element(locations().getByText(/^Location lookup is off \(GEO_SOURCE=none\)/))
      .toBeVisible();
  });

  test("an admin does not see it", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    // An admin's Settings opens on Storage; the channels are their other tab.
    renderApp("/settings?tab=channels");

    await expect
      .element(page.getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Location data" }))
      .not.toBeInTheDocument();
  });
});
