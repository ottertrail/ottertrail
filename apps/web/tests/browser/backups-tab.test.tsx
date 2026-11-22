import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { ADMIN_ACCESS, installFakeApi } from "./fake-api.ts";
import {
  BACKUPS_FAILED,
  BACKUPS_INVALID,
  BACKUPS_KEY_UNSAVED,
  BACKUPS_OFF,
  BACKUPS_ON,
  BACKUPS_READY,
  FAKE_KEY,
  FAKE_PASSWORD,
  fakeBackups,
} from "./fake-backups.ts";
import { renderApp } from "./render.tsx";

/*
 * The Backups tab (features/settings/backups-tab.tsx), for the owner: its
 * states (off without a destination, a configuration problem, a reported
 * destination, the key not yet saved, a failed backup), the schedule under
 * the save rule, Test connection asked of the worker, the listing's time,
 * Back up now, and the key's view, copy, and download. The API's side is
 * apps/api/tests/backups.test.ts.
 */

afterEach(async () => {
  await page.viewport(1280, 900);
  vi.restoreAllMocks();
});

const BACKUPS_TAB = "/settings?tab=backups";
const panel = () => page.getByRole("tabpanel", { name: "Backups" });
const status = () => panel().getByRole("region", { name: "Backups" });
const form = () => page.getByRole("form", { name: "Schedule and destination" });
const destination = () => form().getByRole("region", { name: "Destination" });
const keySection = () => panel().getByRole("region", { name: "Backup key" });
const save = () => page.getByRole("button", { name: "Save backup settings" });
const toggle = () => form().getByRole("switch", { name: "Back up every day" });

describe("the Backups tab's states", () => {
  test("no destination: the switch is off and disabled, and one line says what to set", async () => {
    installFakeApi();
    renderApp(BACKUPS_TAB);

    await expect.element(page.getByRole("tab", { name: "Backups", selected: true })).toBeVisible();
    await expect.element(status().getByText(/^Backups are off\.$/)).toBeVisible();
    await expect.element(toggle()).not.toBeChecked();
    await expect.element(toggle()).toBeDisabled();
    await expect
      .element(
        destination().getByText(
          "Set the BACKUP_S3_* variables in the server's .env and restart the worker.",
          { exact: false },
        ),
      )
      .toBeVisible();
    const docs = destination().getByRole("link", { name: /^Backups docs/ });
    await expect
      .element(docs)
      .toHaveAttribute(
        "href",
        "https://docs.ottertrail.app/self-hosting/backups/#set-up-scheduled-backups",
      );
    await expect.element(docs).toHaveAttribute("target", "_blank");
    // Nothing to test yet, and no destination fields to type in.
    await expect
      .element(destination().getByRole("button", { name: "Test connection" }))
      .not.toBeInTheDocument();
    await expect.element(form().getByRole("textbox", { name: "Bucket" })).not.toBeInTheDocument();
    await expect.element(form().getByLabelText("Time of day")).toHaveValue("03:00");
    await expect.element(form().getByText("Asia/Singapore", { exact: true })).toBeVisible();
    await expect.element(status().getByRole("button", { name: "Back up now" })).toBeDisabled();
    await expect
      .element(keySection().getByText(/^Turn on backups to create a key\./))
      .toBeVisible();
  });

  test("a configuration problem: the worker's words, and the switch disabled", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_INVALID }) });
    renderApp(BACKUPS_TAB);

    await expect.element(destination().getByText("Backup destination invalid")).toBeVisible();
    await expect
      .element(
        destination().getByText(
          "Set BACKUP_S3_REGION too: backups need the endpoint, region, bucket, access key ID, and secret access key. Then restart the worker.",
        ),
      )
      .toBeVisible();
    await expect.element(toggle()).toBeDisabled();
  });

  test("on, but the worker lost its variables: an alert, not a hint", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: { ...BACKUPS_ON, destination: { ...BACKUPS_OFF.destination } },
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect.element(destination().getByText("Backups have no destination")).toBeVisible();
    await expect
      .element(
        destination().getByText(
          "Backups are on, but the worker has no BACKUP_S3_* variables, so the next backup fails.",
          { exact: false },
        ),
      )
      .toBeVisible();
    // Still on: it can be turned off.
    await expect.element(toggle()).toBeChecked();
    await expect.element(toggle()).toBeEnabled();
  });

  test("on, with a problem: the alert says backups fail until it is fixed", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: { ...BACKUPS_ON, destination: BACKUPS_INVALID.destination },
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect
      .element(destination().getByText(/Then restart the worker\. Until then, backups fail\.$/))
      .toBeVisible();
  });

  test("a report over two hours old says when the worker last reported, and what to check", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: { ...BACKUPS_ON, destination: { ...BACKUPS_ON.destination, stale: true } },
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect.element(destination().getByText("Worker report out of date")).toBeVisible();
    await expect
      .element(
        destination().getByText(
          "The worker last reported at 20 Nov 2026, 11:30. Check that the worker is running (docker compose ps).",
        ),
      )
      .toBeVisible();
  });

  test("a reported destination: its parts as text, when the worker reported, and the switch on offer", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_READY }) });
    renderApp(BACKUPS_TAB);

    for (const [label, value] of [
      ["Endpoint", "https://s3.eu-central-1.amazonaws.com"],
      ["Bucket", "acme-backups"],
      ["Folder", "ottertrail-backups"],
      ["Region", "eu-central-1"],
      ["Access key ID", "AKIAEXAMPLE"],
      // 03:30 UTC is 11:30 in Singapore.
      ["Reported", "20 Nov 2026, 11:30"],
    ]) {
      await expect.element(destination().getByText(label, { exact: true })).toBeVisible();
      await expect.element(destination().getByText(value, { exact: true })).toBeVisible();
    }
    // Read only: no field holds them.
    await expect.element(destination().getByRole("textbox")).not.toBeInTheDocument();
    await expect.element(toggle()).toBeEnabled();
    await toggle().click();
    // Turning on needs no password.
    await expect.element(form().getByLabelText("Current password")).not.toBeInTheDocument();
    await save().click();
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
    expect(api.bodies.find((body) => body.path === "/api/settings/backups")?.body).toEqual({
      enabled: true,
      timeOfDay: "03:00",
      keepDays: 14,
    });
    // Turning on made the key: the reminder shows.
    await expect.element(keySection().getByText("Save the key off this server")).toBeVisible();
  });

  test("on: the last backup, the next, and the backups in the bucket as of the worker's listing", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON }) });
    renderApp(BACKUPS_TAB);

    // 19:00 UTC is 03:00 in Singapore.
    await expect.element(status().getByText("Succeeded")).toBeVisible();
    await expect.element(status().getByText("20 Nov 2026, 03:04")).toBeVisible();
    await expect.element(status().getByText("1.5 GB, took 4 min")).toBeVisible();
    await expect.element(status().getByText("21 Nov 2026, 03:00")).toBeVisible();
    const table = status().getByRole("table", { name: "Backups in the bucket" });
    await expect.element(table.getByRole("row")).toHaveLength(3);
    await expect.element(table.getByText("20 Nov 2026, 03:00")).toBeVisible();
    await expect
      .element(
        status().getByText(
          "In acme-backups/ottertrail-backups, as of 20 Nov 2026, 03:04. Incomplete backups can't be restored.",
        ),
      )
      .toBeVisible();
    // The key was saved: no reminder.
    await expect.element(keySection().getByText("Confirmed")).toBeVisible();
    await expect
      .element(keySection().getByText(/^Save the key off this server/))
      .not.toBeInTheDocument();
  });

  test("a listing that failed says why, and when; one not made yet says so", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: BACKUPS_ON,
        list: {
          listedAt: "2026-11-19T19:04:13.000Z",
          ok: false,
          bucket: "acme-backups",
          prefix: "ottertrail-backups",
          error:
            "Couldn't list backups: Bucket not found (NoSuchBucket). Check the name or create it.",
        },
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect
      .element(status().getByText("Couldn't list backups", { exact: true }))
      .toBeVisible();
    await expect
      .element(status().getByText(/Check the name or create it\. As of 20 Nov 2026, 03:04\.$/))
      .toBeVisible();
  });

  test("a folder not listed yet says so", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON, list: { listedAt: null } }) });
    renderApp(BACKUPS_TAB);
    await expect.element(status().getByText("Not listed yet.")).toBeVisible();
  });

  test("the key not yet saved: a reminder that stays until the owner confirms", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_KEY_UNSAVED }) });
    renderApp(BACKUPS_TAB);

    const reminder = keySection().getByText("Save the key off this server");
    await expect.element(reminder).toBeVisible();
    await expect
      .element(keySection().getByText("Backups can't be restored if the server and key are lost."))
      .toBeVisible();
    await expect
      .element(
        keySection().getByText(
          "A restore needs the key file, the bucket's access key, and the server's AUTH_SECRET.",
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
    await expect.element(status().getByText("Last backup failed")).toBeVisible();
    await expect
      .element(status().getByText(/^Uploading PostgreSQL's dump failed: Access denied/))
      .toBeVisible();
    await expect.element(status().getByText(/Retries once at 21 Nov 2026, 04:00\.$/)).toBeVisible();
    await expect.element(status().getByText("Last good backup")).toBeVisible();
  });

  test("a failed load says so, with Retry; admins don't see the tab", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: new Response(JSON.stringify({ message: "The database is down." }), { status: 500 }),
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect.element(panel().getByText("Couldn't load backups")).toBeVisible();
    await expect.element(panel().getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("an admin has no Backups tab, and its address falls back to Storage", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(BACKUPS_TAB);
    await expect.element(page.getByRole("tab", { name: "Storage", selected: true })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Backups" })).not.toBeInTheDocument();
  });
});

describe("the schedule", () => {
  test("Save waits for a change, and sends only the schedule", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON }) });
    renderApp(BACKUPS_TAB);

    await expect.element(save()).toBeVisible();
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    await form().getByLabelText("Days to keep").fill("30");
    await expect.element(form().getByText("Unsaved changes")).toBeVisible();
    await expect
      .element(page.getByRole("tab", { name: /^Backups\s*, unsaved changes$/ }))
      .toBeVisible();
    // Undone: Save waits again.
    await form().getByLabelText("Days to keep").fill("14");
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();

    await form().getByLabelText("Days to keep").fill("30");
    await form().getByLabelText("Time of day").fill("02:30");
    await save().click();
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
    expect(api.bodies.find((body) => body.path === "/api/settings/backups")?.body).toEqual({
      enabled: true,
      timeOfDay: "02:30",
      keepDays: 30,
    });
  });

  test("leaving with unsaved changes asks first", async () => {
    installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON }) });
    renderApp(BACKUPS_TAB);
    await form().getByLabelText("Days to keep").fill("7");
    await page
      .getByRole("navigation", { name: "Instance" })
      .getByRole("link", { name: "Projects" })
      .click();
    await expect.element(page.getByRole("dialog", { name: "Leave without saving?" })).toBeVisible();
  });
});

describe("Test connection", () => {
  test("asks the worker, shows it pending, then each step and when it ran", async () => {
    const api = installFakeApi({
      backups: fakeBackups({
        view: BACKUPS_ON,
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
                "Access denied (AccessDenied). Give this key permission to delete objects in the backup folder.",
            },
          ],
        },
      }),
    });
    renderApp(BACKUPS_TAB);
    await destination().getByRole("button", { name: "Test connection" }).click();

    // Pending until the worker takes it.
    await expect
      .element(destination().getByText("Test connection starts within a minute."))
      .toBeVisible();
    await expect.element(destination().getByRole("button", { name: "Testing…" })).toBeDisabled();
    expect(api.requests).toContain("/api/settings/backups/test-connection");
    // The tab reads the status again every 5 seconds while it waits.
    await expect
      .element(destination().getByText("Connection failed."), { timeout: 8000 })
      .toBeVisible();
    const steps = destination().getByRole("list", { name: "Test connection steps" });
    await expect.element(steps.getByRole("listitem")).toHaveLength(4);
    await expect.element(steps.getByText("Worked")).toHaveLength(3);
    await expect.element(steps.getByText(/permission to delete objects/)).toBeVisible();
    // 04:00 UTC is noon in Singapore.
    await expect.element(destination().getByText("Tested 20 Nov 2026, 12:00.")).toBeVisible();
    await expect
      .element(destination().getByRole("button", { name: "Test connection" }))
      .toBeEnabled();
    // Testing changed nothing saved.
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
  }, 15_000);

  test("one no worker took in a few minutes says so, and may be asked again", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: { ...BACKUPS_ON, connectionTest: { ...BACKUPS_ON.connectionTest, untaken: true } },
      }),
    });
    renderApp(BACKUPS_TAB);
    await expect
      .element(
        destination().getByText(
          "The worker hasn't taken the test. Check that it is running (docker compose ps), then test again.",
        ),
      )
      .toBeVisible();
    await destination().getByRole("button", { name: "Test connection" }).click();
    await expect
      .element(destination().getByText("Test connection starts within a minute."))
      .toBeVisible();
  });

  test("a refusal from the API says why", async () => {
    installFakeApi({
      backups: fakeBackups({
        view: BACKUPS_ON,
        connection: new Response(
          JSON.stringify({
            error: "rate_limited",
            message: "Test connection limit reached. Retry in 60 seconds.",
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      }),
    });
    renderApp(BACKUPS_TAB);
    await destination().getByRole("button", { name: "Test connection" }).click();
    await expect
      .element(destination().getByText("Test connection limit reached. Retry in 60 seconds."))
      .toBeVisible();
  });
});

describe("turning backups off", () => {
  test("needs the password, and then shows since when and by whom they are off", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON }) });
    renderApp(BACKUPS_TAB);
    await toggle().click();
    await expect.element(form().getByLabelText("Current password")).toBeVisible();
    await form().getByLabelText("Current password").fill(FAKE_PASSWORD);
    await save().click();
    await expect.element(form().getByText("No unsaved changes")).toBeVisible();
    // 04:00 UTC is noon in Singapore.
    await expect
      .element(status().getByText(/Off since 20 Nov 2026, 12:00, by Test Owner\./))
      .toBeVisible();
    expect(api.bodies.find((body) => body.path === "/api/settings/backups")?.body).toMatchObject({
      enabled: false,
      currentPassword: FAKE_PASSWORD,
    });
    // The password field goes once saved.
    await expect.element(form().getByLabelText("Current password")).not.toBeInTheDocument();
  });
});

describe("Back up now and the key", () => {
  test("Back up now asks the worker, and says so", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON }) });
    renderApp(BACKUPS_TAB);
    await status().getByRole("button", { name: "Back up now" }).click();
    await expect.element(status().getByText("Backup starts within a minute.")).toBeVisible();
    await expect.element(status().getByRole("button", { name: "Back up now" })).toBeDisabled();
    await expect.element(status().getByRole("button", { name: "Test restore" })).toBeDisabled();
    expect(api.requests).toContain("/api/settings/backups/run");
  });

  test("the key is fetched only on Show, copied, hidden, and downloaded as a file", async () => {
    const api = installFakeApi({ backups: fakeBackups({ view: BACKUPS_ON }) });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp(BACKUPS_TAB);

    await expect.element(keySection().getByText(FAKE_KEY.recipient)).toBeVisible();
    expect(api.requests).not.toContain("/api/settings/backups/key");
    // Both need the current password.
    await expect.element(keySection().getByRole("button", { name: "Show key" })).toBeDisabled();
    await keySection().getByLabelText("Current password").fill("wrong one");
    await keySection().getByRole("button", { name: "Show key" }).click();
    await expect.element(keySection().getByText("Incorrect password. Try again.")).toBeVisible();
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
      await expect.element(status().getByText("Last backup failed")).toBeVisible();
      await expect
        .element(destination().getByText("https://s3.eu-central-1.amazonaws.com"))
        .toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const content = document.querySelector("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    });
  }
});
