import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import type { StorageReport } from "../../src/lib/storage-api.ts";
import { ADMIN_ACCESS, deferred, installFakeApi } from "./fake-api.ts";
import { renderApp } from "./render.tsx";
import { BUDGET_WARNING, DISK_WARNING, STORAGE } from "./storage-fixtures.ts";

/*
 * The Storage tab (features/settings/storage-tab.tsx), on today's Settings
 * page: the warnings, one row per store with its bars, the Garage note,
 * the four states, and the storage-warnings channels under the save rule.
 */

afterEach(async () => {
  await page.viewport(1280, 900);
});

/** The Storage tab's address: notifications link here too. */
const STORAGE_TAB = "/settings?tab=storage";
const panel = () => page.getByRole("tabpanel", { name: "Storage" });
const storage = () => panel().getByRole("region", { name: "What fills the disk" });
const stores = () => page.getByRole("list", { name: "Stores" });
const row = (name: string) =>
  stores()
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
const warnings = () => page.getByRole("list", { name: "Storage warnings" });
const channelsForm = () => page.getByRole("form", { name: "Storage warnings" });
const save = () => page.getByRole("button", { name: "Save storage warnings" });

/** A row's four figures, as "Used: 40 GB" lines. */
function figures(name: string): string[] {
  const element = row(name).element();
  return [...element.querySelectorAll("dl > div")].map(
    (item) => `${item.querySelector("dt")?.textContent}: ${item.querySelector("dd")?.textContent}`,
  );
}

describe("the Storage tab", () => {
  test("names the heatmaps table in words", async () => {
    const clickhouse = STORAGE.clickhouse;
    if (!clickhouse.ok) throw new Error("The fixture measures ClickHouse");
    const heatmaps = {
      name: "heatmaps",
      bytes: 50 * 1024 ** 2,
      rows: 120_000,
      retention: { kind: "days", days: 90 },
    } as const;
    installFakeApi({
      storage: {
        ...STORAGE,
        clickhouse: { ...clickhouse, tables: [...clickhouse.tables, heatmaps] },
      },
    });
    renderApp(STORAGE_TAB);
    await expect.element(row("ClickHouse").getByText(/^Heatmaps:/)).toBeVisible();
    expect(
      row("ClickHouse")
        .getByText(/^heatmaps:/)
        .elements(),
    ).toEqual([]);
  });

  test("full: each store's figures, the disk's bars, and no warnings", async () => {
    installFakeApi();
    renderApp(STORAGE_TAB);

    await expect.element(storage()).toBeVisible();
    // 04:00 UTC is noon in Singapore, the instance's timezone.
    await expect.element(storage().getByText("Measured 19 Nov 2026, 12:00.")).toBeVisible();
    await expect.element(storage().getByText("No warnings")).toBeVisible();

    await expect.element(row("The disk")).toBeVisible();
    expect(figures("The disk")).toEqual([
      "Used: 40 GB",
      "Limit: 100 GB",
      "Left: 60 GB",
      "Share of the disk: 40%",
    ]);
    const diskMeter = row("The disk").getByRole("meter", { name: "The disk, used of its size" });
    await expect.element(diskMeter).toHaveAttribute("aria-valuetext", "40 GB of 100 GB (40%)");
    // What fills it: the stores in the chart colors, the rest, and what is free.
    await expect
      .element(row("The disk").getByRole("button", { name: /^The disk, 100 GB: / }))
      .toBeVisible();
    const bar = row("The disk").element().querySelector("[data-slot=disk-bar]");
    expect(bar?.getAttribute("aria-label")).toBe(
      "The disk, 100 GB: ClickHouse 26 GB (26%); PostgreSQL 3 GB (3%); Replays and source maps (Garage) 620 MB (under 1%); Everything else (the system, images, backups, logs) 10 GB (10%); Free 60 GB (60%)",
    );
    expect(
      [...(bar?.querySelectorAll("[data-part]") ?? [])].map((part) =>
        part.getAttribute("data-part"),
      ),
    ).toEqual(["clickhouse", "postgres", "objects", "other", "free"]);
    await expect
      .element(page.getByRole("list", { name: "What fills the disk" }).getByText("Free"))
      .toBeVisible();

    expect(figures("ClickHouse")).toEqual([
      "Used: 26 GB",
      "Limit: –No limit of its own: the disk",
      "Left: –See the disk",
      "Share of the disk: 26%",
    ]);
    await expect
      .element(
        row("ClickHouse").getByText(
          "Kept as long as each project's retention says. 1 project keeps events forever: set a retention in its settings to limit them.",
        ),
      )
      .toBeVisible();
    await expect.element(row("ClickHouse").getByText("Kept 30 days.")).toBeVisible();
    await expect.element(row("PostgreSQL").getByText("replay_chunks")).toBeVisible();

    expect(figures("Session replays")).toEqual([
      "Used: 512 MB",
      "Limit: 2 GB",
      "Left: 1.5 GB",
      "Share of the disk: under 1%",
    ]);
    await expect
      .element(row("Session replays").getByRole("meter"))
      .toHaveAttribute("aria-valuetext", "512 MB of 2 GB (25%)");
    expect(figures("Source maps")[2]).toBe("Left: 924 MB");

    expect(figures("Garage")).toEqual([
      "Used: 620 MB",
      "Limit: 3.3 GB",
      "Left: 60 GB",
      "Share of the disk: under 1%",
    ]);
    await expect.element(row("Garage").getByText(/The bucket holds 1,234 objects/)).toBeVisible();
  });

  test("the warnings come first, critical and warning, each with what to do", async () => {
    installFakeApi({ storage: { ...STORAGE, warnings: [DISK_WARNING, BUDGET_WARNING] } });
    renderApp(STORAGE_TAB);

    await expect.element(warnings()).toBeVisible();
    const items = warnings().getByRole("listitem");
    await expect.element(items.nth(1)).toBeVisible();
    expect(items.elements().map((item) => item.textContent)).toEqual([
      `CriticalThe disk is 93% full${DISK_WARNING.text}`,
      `WarningSession replays use 95% of their budget${BUDGET_WARNING.text}`,
    ]);
    // Above the stores.
    const list = warnings().element();
    expect(
      list.compareDocumentPosition(stores().element()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect.element(storage().getByText("No warnings")).not.toBeInTheDocument();
  });

  test("without Garage's admin token: the note says how to enable it", async () => {
    installFakeApi({
      storage: {
        ...STORAGE,
        garage: {
          state: "no_token",
          message:
            "Garage's own figures need its admin token. Set GARAGE_ADMIN_TOKEN in .env, then run `docker compose up -d`.",
        },
      },
    });
    renderApp(STORAGE_TAB);

    await expect.element(row("Garage").getByText("Not available").first()).toBeVisible();
    await expect
      .element(row("Garage").getByText("Garage's real usage is not available"))
      .toBeVisible();
    await expect.element(row("Garage").getByText(/Set GARAGE_ADMIN_TOKEN/)).toBeVisible();
    // Ottertrail's own figures still show.
    expect(figures("Session replays")[0]).toBe("Used: 512 MB");
  });

  test("a store that could not be measured says why, with missing figures, never 0", async () => {
    installFakeApi({
      storage: {
        ...STORAGE,
        disk: { ok: false, error: "ClickHouse did not answer: connect ECONNREFUSED" },
        garage: { state: "failed", error: "Garage refused the admin token." },
      },
    });
    renderApp(STORAGE_TAB);

    await expect
      .element(
        row("The disk").getByText(
          "Could not measure: ClickHouse did not answer: connect ECONNREFUSED",
        ),
      )
      .toBeVisible();
    expect(figures("The disk")).toEqual([
      "Used: –Not measured",
      "Limit: –Not measured",
      "Left: –Not measured",
      "Share of the disk: –Not measured",
    ]);
    expect(row("The disk").element().querySelector("[data-slot=disk-bar]")).toBeNull();
    // Shares need the disk.
    expect(figures("ClickHouse")[3]).toBe("Share of the disk: –Not measured");
    await expect
      .element(row("Garage").getByText("Could not measure: Garage refused the admin token."))
      .toBeVisible();
  });

  test("no object store: replays and source maps are off, with no bars", async () => {
    installFakeApi({
      storage: { ...STORAGE, objectStore: "none", budgets: null, garage: null },
    });
    renderApp(STORAGE_TAB);

    await expect
      .element(row("Session replays").getByText(/Off: no object store is set up/))
      .toBeVisible();
    expect(row("Session replays").element().querySelector("[role=meter]")).toBeNull();
    expect(figures("Source maps")[0]).toBe("Used: –Off");
    await expect.element(row("Garage")).not.toBeInTheDocument();
  });

  test("loading, then a failure with a retry that works", async () => {
    const held = deferred<void>();
    const api = installFakeApi({ holdStorage: held.promise });
    renderApp(STORAGE_TAB);

    // The tabs' section skeleton, inside the Storage tab.
    await expect.element(panel()).toBeVisible();
    expect(panel().element().querySelector("[aria-busy=true] [data-slot=skeleton]")).not.toBeNull();
    api.storage = new Response(JSON.stringify({ error: "internal", message: "It broke." }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    held.resolve();
    await expect.element(page.getByText("Storage could not load")).toBeVisible();
    await expect.element(page.getByText("It broke.")).toBeVisible();

    api.storage = STORAGE;
    await panel().getByRole("button", { name: "Retry" }).click();
    await expect.element(storage()).toBeVisible();
    await expect.element(page.getByText("Storage could not load")).not.toBeInTheDocument();
  });

  test("a failed refresh keeps the figures, dimmed, and says they are older", async () => {
    const api = installFakeApi();
    renderApp(STORAGE_TAB);
    await expect.element(row("The disk")).toBeVisible();

    api.storage = new Response(JSON.stringify({ error: "internal", message: "It broke." }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await page.getByRole("button", { name: "Measure again" }).click();
    await expect
      .element(storage().getByText("Measuring again failed: these figures are older"))
      .toBeVisible();
    expect(figures("The disk")[0]).toBe("Used: 40 GB");
  });

  test("admins see it too", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(STORAGE_TAB);
    await expect.element(row("The disk")).toBeVisible();
    await expect.element(save()).toBeVisible();
  });
});

describe("figures that could not be measured", () => {
  test('a warning on when last measured shows as still on; never "No warnings"', async () => {
    installFakeApi({
      storage: {
        ...STORAGE,
        disk: { ok: false, error: "ClickHouse did not answer." },
        held: [
          {
            id: "disk_used",
            level: "critical",
            title: "The disk is nearly full",
            since: "2026-11-19T03:00:00.000Z",
          },
        ],
        undetermined: ["merge_headroom", "backup_space", "disk_used", "budgets_exceed_disk"],
      },
    });
    renderApp(STORAGE_TAB);

    const held = warnings().getByRole("listitem");
    await expect.element(held).toBeVisible();
    expect(held.element().textContent).toBe(
      "CriticalThe disk is nearly fullStill on: it was on when last measured, and could not be measured now. The rows below say what failed.",
    );
    await expect.element(storage().getByText("No warnings")).not.toBeInTheDocument();
    await expect
      .element(
        storage().getByText(
          "Not checked, as their figures could not be measured: room to merge, room for a backup, whether the budgets fit the disk.",
        ),
      )
      .toBeVisible();
    // The reason is short and fixed, in ink, not a status color.
    const reason = row("The disk").getByText("Could not measure: ClickHouse did not answer.");
    await expect.element(reason).toBeVisible();
    expect(reason.element().className).not.toContain("status");
  });

  test('nothing on, some figures not measured: "Not checked", not "No warnings"', async () => {
    installFakeApi({
      storage: {
        ...STORAGE,
        budgets: { ok: false, error: "PostgreSQL did not answer." },
        undetermined: ["replay_budget", "source_map_budget", "budgets_exceed_disk"],
      },
    });
    renderApp(STORAGE_TAB);
    await expect.element(storage().getByText("Not checked")).toBeVisible();
    await expect
      .element(
        storage().getByText(
          /these were not checked: the replay budget, the source map budget, whether the budgets fit the disk\./,
        ),
      )
      .toBeVisible();
    await expect.element(storage().getByText("No warnings")).not.toBeInTheDocument();
  });

  test('no object store: "No warnings" says nothing of budgets', async () => {
    installFakeApi({ storage: { ...STORAGE, objectStore: "none", budgets: null, garage: null } });
    renderApp(STORAGE_TAB);
    await expect.element(storage().getByText("No warnings")).toBeVisible();
    expect(
      storage()
        .getByText(/The disk has room/)
        .element().textContent,
    ).toBe("No warningsThe disk has room.");
    await expect.element(storage().getByText(/budgets are below 90%/)).not.toBeInTheDocument();
  });

  test("a budget's badge follows its warning, which holds down to 88%", async () => {
    const replays = { usedBytes: 89 * 1024 ** 2, limitBytes: 100 * 1024 ** 2 };
    const sourceMaps = { usedBytes: 91 * 1024 ** 2, limitBytes: 100 * 1024 ** 2 };
    installFakeApi({
      storage: {
        ...STORAGE,
        budgets: { ok: true, replays, sourceMaps },
        // The replay warning is still on at 89%; the source maps' has not started yet.
        warnings: [BUDGET_WARNING],
      },
    });
    renderApp(STORAGE_TAB);
    await expect.element(row("Session replays").getByText("89% of the budget")).toBeVisible();
    await expect.element(row("Source maps").getByText(/of the budget/)).not.toBeInTheDocument();
  });
});

describe("the storage-warnings channels follow the save rule", () => {
  test("Save waits for a change, Discard undoes it, and Save sends the chosen channels", async () => {
    const held = deferred<void>();
    const api = installFakeApi();
    renderApp(STORAGE_TAB);

    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    const form = channelsForm();
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    const pager = form.getByRole("checkbox", { name: "Pager webhook (webhook)" });
    await expect.element(pager).not.toBeChecked();

    // Changed, then changed back: nothing to save.
    await pager.click();
    await expect.element(form.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await expect.element(save()).not.toHaveAttribute("aria-disabled", "true");
    await pager.click();
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    // Discard.
    await pager.click();
    await form.getByRole("button", { name: "Discard" }).click();
    await expect.element(pager).not.toBeChecked();

    // Save.
    api.holdStorage = held.promise;
    await pager.click();
    await form.getByRole("checkbox", { name: "Ops email (email)" }).click();
    await save().click();
    await expect.element(form.getByRole("button", { name: "Saving…" })).toBeVisible();
    held.resolve();
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    await expect.element(pager).toBeChecked();
    expect(api.bodies.filter((body) => body.path === "/api/settings/storage")).toEqual([
      {
        method: "PATCH",
        path: "/api/settings/storage",
        body: { warningChannelIds: ["channel-hook", "channel-ops"] },
      },
    ]);
  });

  test("a failed save keeps the choice and says why", async () => {
    const api = installFakeApi();
    renderApp(STORAGE_TAB);
    const pager = channelsForm().getByRole("checkbox", { name: "Pager webhook (webhook)" });
    await pager.click();
    api.storage = new Response(
      JSON.stringify({ error: "channel_not_found", message: "A chosen channel is gone." }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    await save().click();
    await expect.element(channelsForm().getByText("The changes were not saved")).toBeVisible();
    await expect.element(channelsForm().getByText("A chosen channel is gone.")).toBeVisible();
    await expect.element(pager).toBeChecked();
  });

  test("a channel deleted in the channels card leaves the choice, and Save never sends it", async () => {
    const api = installFakeApi();
    renderApp(STORAGE_TAB);
    const form = channelsForm();
    const pager = form.getByRole("checkbox", { name: "Pager webhook (webhook)" });
    await pager.click();
    await expect.element(form.getByText("Unsaved changes", { exact: true })).toBeVisible();

    // The channel goes; the Storage section loads again without it.
    api.storage = {
      ...STORAGE,
      warningChannels: {
        channelIds: [],
        channels: [{ id: "channel-ops", name: "Ops email", kind: "email" }],
      },
    };
    await page.getByRole("tab", { name: /^Storage/ }).click();
    // The Notification channels tab; the Storage tab says it is unsaved.
    await page.getByRole("tab", { name: "Notification channels" }).click();
    await expect
      .element(page.getByRole("tab", { name: /^Storage\s*, unsaved changes$/ }))
      .toBeVisible();
    await page.getByRole("button", { name: "Delete On call" }).click();
    await page.getByRole("button", { name: "Delete channel" }).click();
    await page.getByRole("tab", { name: /^Storage/ }).click();
    await expect.element(pager).not.toBeInTheDocument();
    // The choice it was in is gone with it: nothing left to save.
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();

    await form.getByRole("checkbox", { name: "Ops email (email)" }).click();
    await save().click();
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    expect(api.bodies.filter((body) => body.path === "/api/settings/storage")).toEqual([
      {
        method: "PATCH",
        path: "/api/settings/storage",
        body: { warningChannelIds: ["channel-ops"] },
      },
    ]);
  });

  test("no channels yet: says where to add one", async () => {
    installFakeApi({
      storage: {
        ...STORAGE,
        warningChannels: { channelIds: [], channels: [] },
      } satisfies StorageReport,
    });
    renderApp(STORAGE_TAB);
    await expect
      .element(channelsForm().getByText(/This instance has no notification channels/))
      .toBeVisible();
  });
});

describe("the Storage tab fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} wide: nothing sideways, the figures in ${width < 640 ? "two columns" : "one row"}`, async () => {
      await page.viewport(width, height);
      installFakeApi({ storage: { ...STORAGE, warnings: [DISK_WARNING] } });
      renderApp(STORAGE_TAB);

      await expect.element(row("The disk")).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const content = document.querySelector("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
      const cells = [...row("The disk").element().querySelectorAll("dl > div")];
      const tops = new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top)));
      expect(tops.size).toBe(width < 640 ? 2 : 1);
      // The bars take the row's width.
      const meter = row("The disk")
        .element()
        .querySelector("[data-slot=storage-meter]")!
        .getBoundingClientRect();
      expect(meter.width).toBeGreaterThan(width < 640 ? 200 : 400);
    });
  }
});
