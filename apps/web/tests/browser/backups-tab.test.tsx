import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { ADMIN_ACCESS, installFakeApi } from "./fake-api.ts";
import {
  BACKUPS_FAILED,
  BACKUPS_REUSED,
  BACKUPS_SEPARATE,
  FAKE_KEY,
  FAKE_PASSWORD,
  fakeBackups,
} from "./fake-backups.ts";
import { renderApp } from "./render.tsx";

/*
 * The Backups tab (features/settings/backups-tab.tsx), for the owner: its
 * states (off, a reused destination, a separate one, the key not yet
 * saved, a failed backup), the schedule and destination under the save
 * rule, Test connection, Back up now, and the key's view, copy, and
 * download. The API's side is apps/api/tests/backups.test.ts.
 */

afterEach(async () => {
  await page.viewport(1280, 900);
  vi.restoreAllMocks();
});

const BACKUPS_TAB = "/settings?tab=backups";
const panel = () => page.getByRole("tabpanel", { name: "Backups" });
const status = () => panel().getByRole("region", { name: "Backups" });
const form = () => page.getByRole("form", { name: "Schedule and destination" });
const keySection = () => panel().getByRole("region", { name: "Backup key" });
const save = () => page.getByRole("button", { name: "Save backup settings" });

describe("the Backups tab's states", () => {
  test("off: says how to turn backups on, asks for a destination, and has no key yet", async () => {
    installFakeApi();
    renderApp(BACKUPS_TAB);

    await expect.element(page.getByRole("tab", { name: "Backups", selected: true })).toBeVisible();
    await expect.element(status().getByText(/^Backups are off\.$/)).toBeVisible();
    await expect
      .element(form().getByRole("switch", { name: "Back up every day" }))
      .not.toBeChecked();
    await expect
      .element(form().getByText(/^Use an S3-compatible bucket, such as Amazon S3/))
      .toBeVisible();
    for (const name of [
      "Endpoint",
      "Region",
      "Bucket",
      "Folder",
      "Access key ID",
      "Secret access key",
    ]) {
      await expect.element(form().getByLabelText(name, { exact: true })).toBeVisible();
    }
    await expect.element(form().getByLabelText("Time of day")).toHaveValue("03:00");
    await expect.element(form().getByText("Asia/Singapore", { exact: true })).toBeVisible();
    await expect.element(status().getByRole("button", { name: "Back up now" })).toBeDisabled();
    await expect
      .element(keySection().getByText(/^Made when backups are first turned on\./))
      .toBeVisible();
  });

  test("a reused off-site object store: a bucket and folder only, and the last backup", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_REUSED }) });
    renderApp(BACKUPS_TAB);

    await expect
      .element(
        form().getByText(
          /^Backups use the object store's connection \(acct\.r2\.cloudflarestorage\.com\)/,
        ),
      )
      .toBeVisible();
    await expect.element(form().getByLabelText("Bucket")).toHaveValue("acme-backups");
    await expect.element(form().getByLabelText("Endpoint")).not.toBeInTheDocument();
    await expect.element(form().getByLabelText("Secret access key")).not.toBeInTheDocument();
    // 19:00 UTC is 03:00 in Singapore.
    await expect.element(status().getByText("Succeeded")).toBeVisible();
    await expect.element(status().getByText("20 Nov 2026, 03:04")).toBeVisible();
    await expect.element(status().getByText("1.5 GB, took 4 min")).toBeVisible();
    await expect.element(status().getByText("21 Nov 2026, 03:00")).toBeVisible();
    // The backups in the bucket.
    const table = status().getByRole("table", { name: "Backups in the bucket" });
    await expect.element(table.getByRole("row")).toHaveLength(3);
    await expect.element(table.getByText("20 Nov 2026, 03:00")).toBeVisible();
    // The key was saved: no reminder.
    await expect.element(keySection().getByText("Confirmed")).toBeVisible();
    await expect
      .element(keySection().getByText(/^Save the backup key somewhere other than this server/))
      .not.toBeInTheDocument();
  });

  test("a separate destination, as the stack's Garage is on this disk; the secret never shown", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_SEPARATE }) });
    renderApp(BACKUPS_TAB);

    await expect
      .element(
        form().getByText(
          /^The object store is this server's own Garage, so a backup there isn't a backup/,
        ),
      )
      .toBeVisible();
    await expect
      .element(form().getByLabelText("Endpoint"))
      .toHaveValue("https://s3.eu-central-1.amazonaws.com");
    await expect.element(form().getByLabelText("Access key ID")).toHaveValue("AKIAEXAMPLE");
    const secret = form().getByLabelText("Secret access key");
    await expect.element(secret).toHaveValue("");
    await expect.element(secret).toHaveAttribute("type", "password");
    await expect.element(form().getByText(/^Saved, and never shown again/)).toBeVisible();
  });

  test("the key not yet saved: a reminder that stays until the owner confirms", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_SEPARATE }) });
    renderApp(BACKUPS_TAB);

    const reminder = keySection().getByText("Save the backup key somewhere other than this server");
    await expect.element(reminder).toBeVisible();
    await expect
      .element(
        keySection().getByText(
          /^If the server and the key are both lost, the backups can't be restored/,
        ),
      )
      .toBeVisible();
    await keySection().getByRole("button", { name: "I've saved the key" }).click();
    await expect.element(reminder).not.toBeInTheDocument();
    await expect.element(keySection().getByText("Confirmed")).toBeVisible();
    expect(api.requests).toContain("/api/settings/backups/key/saved");
  });

  test("the last backup failed: why, when the worker tries again, and the last good one", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_FAILED }) });
    renderApp(BACKUPS_TAB);

    await expect.element(status().getByText("Failed")).toBeVisible();
    await expect.element(status().getByText("The last backup failed")).toBeVisible();
    await expect
      .element(
        status().getByText(
          /^Uploading PostgreSQL's dump failed: The storage refused it: this access key may not write files/,
        ),
      )
      .toBeVisible();
    await expect
      .element(status().getByText(/The worker tries once more at 21 Nov 2026, 04:00\.$/))
      .toBeVisible();
    await expect.element(status().getByText("Last good backup")).toBeVisible();
  });

  test("a failed load says so, with Retry; admins don't see the tab", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: new Response(JSON.stringify({ message: "The database is down." }), { status: 500 }),
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect.element(panel().getByText("Backups could not load")).toBeVisible();
    await expect.element(panel().getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("an admin has no Backups tab, and its address falls back to Storage", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(BACKUPS_TAB);
    await expect.element(page.getByRole("tab", { name: "Storage", selected: true })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Backups" })).not.toBeInTheDocument();
  });
});

describe("the schedule and destination", () => {
  test("Save waits for a change, sends only what the destination takes, and empties the secret", async () => {
    const api = installFakeApi();
    renderApp(BACKUPS_TAB);

    await expect.element(save()).toBeVisible();
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    await form().getByRole("switch", { name: "Back up every day" }).click();
    await expect.element(form().getByText("Unsaved changes")).toBeVisible();
    await expect
      .element(page.getByRole("tab", { name: /^Backups\s*, unsaved changes$/ }))
      .toBeVisible();
    // Undone: Save waits again.
    await form().getByRole("switch", { name: "Back up every day" }).click();
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();

    await form().getByRole("switch", { name: "Back up every day" }).click();
    await form().getByLabelText("Endpoint").fill("https://s3.eu-central-1.amazonaws.com");
    await form().getByLabelText("Region").fill("eu-central-1");
    await form().getByLabelText("Bucket").fill("acme-backups");
    await form().getByLabelText("Access key ID").fill("AKIAEXAMPLE");
    await form().getByLabelText("Secret access key").fill("the-secret");
    // A new destination needs the current password.
    await form().getByLabelText("Current password").fill(FAKE_PASSWORD);
    await form().getByLabelText("Days to keep").fill("30");
    await save().click();

    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
    await expect.element(form().getByLabelText("Secret access key")).toHaveValue("");
    await expect.element(form().getByText(/^Saved, and never shown again/)).toBeVisible();
    expect(api.bodies.find((body) => body.path === "/api/settings/backups")?.body).toEqual({
      enabled: true,
      timeOfDay: "03:00",
      keepDays: 30,
      bucket: "acme-backups",
      prefix: "ottertrail-backups",
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      region: "eu-central-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "the-secret",
      currentPassword: FAKE_PASSWORD,
    });
    // The password field goes once saved.
    await expect.element(form().getByLabelText("Current password")).not.toBeInTheDocument();
    // Turning on made the key: the reminder shows.
    await expect
      .element(keySection().getByText("Save the backup key somewhere other than this server"))
      .toBeVisible();
  });

  test("a reused destination saves no endpoint or keys", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_REUSED }) });
    renderApp(BACKUPS_TAB);
    await expect.element(form().getByLabelText("Current password")).not.toBeInTheDocument();
    await form().getByLabelText("Folder").fill("instance-1");
    await form().getByLabelText("Current password").fill(FAKE_PASSWORD);
    await save().click();
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
    expect(api.bodies.find((body) => body.path === "/api/settings/backups")?.body).toEqual({
      enabled: true,
      timeOfDay: "03:00",
      keepDays: 14,
      bucket: "acme-backups",
      prefix: "instance-1",
      currentPassword: FAKE_PASSWORD,
    });
  });

  test("Test connection tries the form's values and says which step failed", async () => {
    const api = installFakeApi({
      backups: fakeBackups({
        view: BACKUPS_SEPARATE,
        connection: {
          ok: false,
          steps: [
            { step: "put", status: "ok" },
            { step: "list", status: "ok" },
            { step: "get", status: "ok" },
            {
              step: "delete",
              status: "failed",
              error:
                "The storage refused it: this access key may not delete files in the bucket's folder (AccessDenied). Give the key permission to delete objects there.",
            },
          ],
        },
      }),
    });
    renderApp(BACKUPS_TAB);
    await form().getByLabelText("Bucket").fill("other-bucket");
    await form().getByRole("button", { name: "Test connection" }).click();

    await expect
      .element(form().getByText("The connection does not work yet: a step failed."))
      .toBeVisible();
    const steps = form().getByRole("list", { name: "Test connection steps" });
    await expect.element(steps.getByRole("listitem")).toHaveLength(4);
    await expect.element(steps.getByText("Worked")).toHaveLength(3);
    await expect.element(steps.getByText(/may not delete files/)).toBeVisible();
    // The unsaved bucket was tested, without a secret: the saved one is used.
    expect(
      api.bodies.find((body) => body.path === "/api/settings/backups/test-connection")?.body,
    ).toEqual({
      bucket: "other-bucket",
      prefix: "ottertrail-backups",
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      region: "eu-central-1",
      accessKeyId: "AKIAEXAMPLE",
    });
    // Testing changed nothing saved.
    await expect.element(form().getByText("Unsaved changes")).toBeVisible();
  });

  test("leaving with unsaved changes asks first", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_REUSED }) });
    renderApp(BACKUPS_TAB);
    await form().getByLabelText("Days to keep").fill("7");
    await page
      .getByRole("navigation", { name: "Instance" })
      .getByRole("link", { name: "Projects" })
      .click();
    await expect.element(page.getByRole("dialog", { name: "Leave without saving?" })).toBeVisible();
  });
});

describe("turning backups off", () => {
  test("needs the password, and then shows since when and by whom they are off", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_REUSED }) });
    renderApp(BACKUPS_TAB);
    await form().getByRole("switch", { name: "Back up every day" }).click();
    await expect.element(form().getByLabelText("Current password")).toBeVisible();
    await form().getByLabelText("Current password").fill(FAKE_PASSWORD);
    await save().click();
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
    // 04:00 UTC is noon in Singapore.
    await expect
      .element(
        status().getByText(/Backups are off since 20 Nov 2026, 12:00, turned off by Test Owner\./),
      )
      .toBeVisible();
    expect(api.bodies.find((body) => body.path === "/api/settings/backups")?.body).toMatchObject({
      enabled: false,
      currentPassword: FAKE_PASSWORD,
    });
  });
});

describe("Back up now and the key", () => {
  test("Back up now asks the worker, and says so", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_REUSED }) });
    renderApp(BACKUPS_TAB);
    await status().getByRole("button", { name: "Back up now" }).click();
    await expect.element(status().getByText("Backup starts within a minute.")).toBeVisible();
    await expect.element(status().getByRole("button", { name: "Back up now" })).toBeDisabled();
    await expect.element(status().getByRole("button", { name: "Test restore" })).toBeDisabled();
    expect(api.requests).toContain("/api/settings/backups/run");
  });

  test("the key is fetched only on Show, copied, hidden, and downloaded as a file", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_REUSED }) });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp(BACKUPS_TAB);

    await expect.element(keySection().getByText(FAKE_KEY.recipient)).toBeVisible();
    expect(api.requests).not.toContain("/api/settings/backups/key");
    // Both need the current password.
    await expect.element(keySection().getByRole("button", { name: "Show key" })).toBeDisabled();
    await keySection().getByLabelText("Current password").fill("wrong one");
    await keySection().getByRole("button", { name: "Show key" }).click();
    await expect
      .element(keySection().getByText("The current password is incorrect. Enter it again."))
      .toBeVisible();
    await keySection().getByLabelText("Current password").fill(FAKE_PASSWORD);
    await keySection().getByRole("button", { name: "Show key" }).click();
    await expect.element(keySection().getByText(FAKE_KEY.key)).toBeVisible();
    expect(api.requests).toContain("/api/settings/backups/key");
    await keySection().getByRole("button", { name: "Copy the backup key" }).click();
    expect(writeText).toHaveBeenCalledWith(FAKE_KEY.key);
    await keySection().getByRole("button", { name: "Hide key" }).click();
    await expect.element(keySection().getByText(FAKE_KEY.key)).not.toBeInTheDocument();

    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    await keySection().getByLabelText("Current password").fill(FAKE_PASSWORD);
    await keySection().getByRole("button", { name: "Download key file" }).click();
    await expect.poll(() => clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("ottertrail-backup-key-acme-inc.txt");
    expect(clicked[0]?.href).toMatch(/^blob:/);
    expect(api.requests).toContain("/api/settings/backups/key/file");
  });
});

describe("the Backups tab fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} wide: nothing sideways`, async () => {
      await page.viewport(width, height);
      installFakeApi({ backups: fakeBackups({ view: BACKUPS_FAILED }) });
      renderApp(BACKUPS_TAB);
      await expect.element(status().getByText("The last backup failed")).toBeVisible();
      await expect.element(form().getByLabelText("Endpoint")).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const content = document.querySelector("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    });
  }
});
