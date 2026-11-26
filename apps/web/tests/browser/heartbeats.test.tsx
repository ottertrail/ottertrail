import { describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  fakeChecks,
  FAKE_PING_TOKENS,
  fakeHeartbeat,
  fakePings,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const UPTIME = `/projects/${PROJECT.id}/uptime`;
const CHECKS_PATH = `/api/projects/${PROJECT.id}/checks`;
const HEARTBEAT = fakeHeartbeat();
const HEARTBEAT_PAGE = `${UPTIME}/${HEARTBEAT.id}`;
const PING_URL = `https://ottertrail.example.com/api/heartbeats/${FAKE_PING_TOKENS.shown}`;

const rowsOf = (caption: string) => {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent ?? ""),
  );
};

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

async function choose(combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Stands in for the clipboard, which a headless browser may refuse. */
const fakeClipboard = () => vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

const withHeartbeat = () => ({
  checks: [...fakeChecks(), HEARTBEAT],
  pings: { [HEARTBEAT.id]: fakePings() },
});

describe("heartbeats on the Uptime page", () => {
  test("adds a heartbeat: a name, how often, and a grace that follows the period", async () => {
    const api = installFakeApi({ checks: [] });
    renderApp(UPTIME);
    await page.getByRole("button", { name: "Add heartbeat" }).click();
    const form = dialog("Add a heartbeat");
    await expect.element(form).toBeVisible();
    // A day, and 2 hours of grace, by default.
    await expect
      .poll(() => form.getByRole("combobox", { name: "Expected" }).element().textContent)
      .toContain("Every day");
    await expect
      .poll(() => form.getByRole("combobox", { name: "Grace time" }).element().textContent)
      .toContain("2 hours");

    await form.getByRole("button", { name: "Add heartbeat" }).click();
    await expect.element(form.getByText("Enter a name for the heartbeat.")).toBeVisible();
    expect(api.bodies).toEqual([]);

    await form.getByLabelText("Name").fill("Nightly backup");
    await choose("Expected", "Every hour");
    await expect
      .poll(() => form.getByRole("combobox", { name: "Grace time" }).element().textContent)
      .toContain("10 minutes");
    await form.getByRole("button", { name: "Add heartbeat" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: CHECKS_PATH,
      body: { kind: "heartbeat", name: "Nightly backup", intervalSeconds: 3600, graceSeconds: 600 },
    });
    await expect.element(page.getByRole("table", { name: "Uptime checks" })).toBeVisible();
    const [row] = rowsOf("Uptime checks");
    expect(row?.[0]).toMatch(/^Nightly backupHeartbeat, every hour; no ping yet; next expected /);
    expect(row?.[1]).toBe("New");
  });

  test("a heartbeat's row shows its last ping and the next one expected", async () => {
    installFakeApi(withHeartbeat());
    renderApp(UPTIME);
    await expect.element(page.getByRole("table", { name: "Uptime checks" })).toBeVisible();
    expect(rowsOf("Uptime checks").map((cells) => cells.slice(0, 3))).toContainEqual([
      "Nightly backupHeartbeat, every day; last ping 16 Nov 2026, 03:02; next expected 17 Nov 2026, 03:02",
      "Up",
      "100%",
    ]);
    expect(rowsOf("Uptime of each check")).toContainEqual([
      "Nightly backup",
      "100%",
      // One night in 30 days without a ping: 22 hours down.
      "100%",
      "96.94%",
      "Ping",
      "16 Nov 2026, 03:02",
    ]);
  });

  test("its page shows the ping URL to copy, examples with it, and the latest pings", async () => {
    const api = installFakeApi(withHeartbeat());
    const writeText = fakeClipboard();
    renderApp(HEARTBEAT_PAGE);

    await expect.element(page.getByRole("heading", { name: "Nightly backup" })).toBeVisible();
    await expect.element(page.getByText("Heartbeat, every day, 2 hours of grace")).toBeVisible();
    await expect
      .element(page.getByText("Up. Down if no ping comes by 17 Nov 2026, 05:02."))
      .toBeVisible();
    await expect.element(page.getByText(PING_URL, { exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText(
          `0 3 * * * /path/to/job.sh && curl -fsS -m 10 --retry 3 -o /dev/null ${PING_URL}`,
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText(`${PING_URL}/fail`, { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Copy the ping URL" }).click();
    expect(writeText).toHaveBeenCalledWith(PING_URL);

    await expect.element(page.getByRole("table", { name: /Latest pings/ })).toBeVisible();
    expect(rowsOf("Latest pings, newest first")).toEqual(
      ["16", "15", "14", "13", "12"].map((day) => [`${day} Nov 2026, 03:02`, "Success"]),
    );
    // The period's uptime and the last 7 days agree: the missed night is older.
    await expect
      .poll(() =>
        [...document.querySelectorAll("dl dd")].slice(0, 4).map((item) => item.textContent),
      )
      .toEqual(["100%", "100%", "100%", "96.94%"]);
    // A heartbeat has no response time or failed runs.
    await expect.element(page.getByText("Response time")).not.toBeInTheDocument();
    await expect.element(page.getByText("Latest failures")).not.toBeInTheDocument();
    expect(api.requests).toContain(`${CHECKS_PATH}/${HEARTBEAT.id}/ping-url`);
  });

  test("a new URL replaces the old one after a confirmation", async () => {
    const api = installFakeApi(withHeartbeat());
    const before = api.requests.length;
    renderApp(HEARTBEAT_PAGE);
    await expect.element(page.getByText(PING_URL, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New URL" }).click();
    const confirm = dialog("Make a new ping URL?");
    await expect.element(confirm.getByText(/The current URL stops working at once/)).toBeVisible();
    await confirm.getByRole("button", { name: "Make new URL" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    expect(api.requests.slice(before)).toContain(`${CHECKS_PATH}/${HEARTBEAT.id}/ping-url`);
    const next = `https://ottertrail.example.com/api/heartbeats/${FAKE_PING_TOKENS.replaced}`;
    await expect.element(page.getByText(next, { exact: true })).toBeVisible();
    await expect.element(page.getByText(PING_URL, { exact: true })).not.toBeInTheDocument();
  });

  test("editing a heartbeat opens its own form", async () => {
    const api = installFakeApi(withHeartbeat());
    renderApp(HEARTBEAT_PAGE);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const form = dialog("Edit “Nightly backup”");
    await expect.element(form.getByLabelText("Name")).toHaveValue("Nightly backup");
    await expect.element(form.getByLabelText("URL")).not.toBeInTheDocument();
    await choose("Grace time", "6 hours");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `${CHECKS_PATH}/${HEARTBEAT.id}`,
      body: { name: "Nightly backup", intervalSeconds: 86_400, graceSeconds: 21_600 },
    });
  });

  test("a member who only views sees the heartbeat, not its URL", async () => {
    const api = installFakeApi({
      ...withHeartbeat(),
      access: memberAccess({ uptime_alerts: "view" }),
    });
    renderApp(HEARTBEAT_PAGE);
    await expect
      .element(page.getByText("Only people who manage uptime checks can see the URL."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "New URL" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("table", { name: /Latest pings/ })).toBeVisible();
    expect(api.requests).not.toContain(`${CHECKS_PATH}/${HEARTBEAT.id}/ping-url`);
  });
});
