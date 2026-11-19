import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { fakeChecks, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const UPTIME = `/projects/${PROJECT.id}/uptime`;
const CHECKS_PATH = `/api/projects/${PROJECT.id}/checks`;
const [SHOP, API] = fakeChecks();

const sidebarLink = (name: string) =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", { name });

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

describe("the uptime page", () => {
  test("opens from the sidebar with each check's state in words, uptime, latest run, and last check", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/hosts`);
    await sidebarLink("Uptime").click();

    await expect.poll(() => router.state.location.pathname).toBe(UPTIME);
    await expect.element(page.getByRole("table", { name: "Uptime checks" })).toBeVisible();
    await expect.element(sidebarLink("Uptime")).toHaveAttribute("data-active");
    expect(api.requests).toContain(CHECKS_PATH);
    const rows = rowsOf("Uptime checks").map((cells) => cells.slice(0, 7));
    expect(rows).toEqual([
      [
        "Shop homeGET https://shop.example/, every minute",
        "Up",
        "100%",
        // Cut, not rounded: 99.951% reads 99.95%.
        "99.95%",
        "98.75%",
        "123 ms",
        "16 Nov 2026, 16:59",
      ],
      [
        "API healthGET https://api.shop.example/health, every 5 minutes",
        "Down",
        "70.00%",
        "95.00%",
        // The check did not exist for the whole 30 days.
        "–",
        "Status code (503)",
        "16 Nov 2026, 17:00",
      ],
    ]);
    // State is a word with its icon, never color alone.
    const badges = document.querySelectorAll("table [data-slot=status-badge]");
    expect([...badges].map((badge) => badge.getAttribute("data-tone"))).toEqual([
      "good",
      "critical",
    ]);
  });

  test("explains checks and offers to add one while the project has none", async () => {
    installFakeApi({ checks: [] });
    renderApp(UPTIME);
    await expect.element(page.getByText("No uptime checks yet")).toBeVisible();
    await expect
      .element(page.getByText(/This instance requests your site or API URL on a schedule/))
      .toBeVisible();
    expect(page.getByRole("table").elements()).toEqual([]);
    await page.getByRole("button", { name: "Add check" }).click();
    await expect.element(dialog("Add a check")).toBeVisible();
  });

  test("adds a check: the form checks its fields, and shows the API's refusal beside the URL", async () => {
    const api = installFakeApi({ checks: [] });
    renderApp(UPTIME);
    await page.getByRole("button", { name: "Add check" }).click();
    const form = dialog("Add a check");
    await expect.element(form).toBeVisible();

    // Nothing filled in: the URL is required; the defaults stand for the rest.
    await form.getByRole("button", { name: "Add check" }).click();
    await expect.element(form.getByText("Enter the URL to check.")).toBeVisible();
    await expect
      .element(form.getByText("The check is incomplete. Correct the marked fields above."))
      .toBeVisible();
    await expect.element(form.getByLabelText("URL")).toHaveAttribute("aria-invalid", "true");

    await form.getByLabelText("URL").fill("ftp://files.example/");
    await expect
      .element(form.getByText(/Enter a full URL that starts with http:\/\/ or https:\/\//))
      .toBeVisible();
    await form.getByLabelText("URL").fill("https://db.internal/health");
    await form.getByLabelText("Status codes that count as up").fill("2xx");
    await expect.element(form.getByText(/Enter codes from 100 to 599 and ranges/)).toBeVisible();
    await form.getByLabelText("Status codes that count as up").fill("200-299, 418");
    await form.getByLabelText("Timeout (seconds)").fill("45");
    await expect
      .element(form.getByText("Enter a whole number of seconds from 1 to 30."))
      .toBeVisible();
    await form.getByLabelText("Timeout (seconds)").fill("5");
    await form.getByLabelText("Word (optional)").fill("healthy");
    await choose("Method", "HEAD");
    await expect
      .element(
        form.getByText("A HEAD request has no response body to search for the word. Use GET."),
      )
      .toBeVisible();
    await choose("Method", "GET");
    expect(api.bodies).toEqual([]);

    // The API refuses the address: its message shows under the URL.
    await form.getByRole("button", { name: "Add check" }).click();
    await expect
      .element(form.getByText("db.internal resolves to an address checks may not reach."))
      .toBeVisible();
    await expect.element(form.getByLabelText("URL")).toHaveAttribute("aria-invalid", "true");

    await form.getByLabelText("URL").fill("https://status.shop.example/health");
    await form.getByLabelText("Name").fill("Status page");
    await choose("How often", "Every 2 minutes");
    await choose("Down after", "3 failures in a row");
    await choose("The word", "must not be in the body");
    await form.getByRole("button", { name: "Add check" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: CHECKS_PATH,
      body: {
        name: "Status page",
        url: "https://status.shop.example/health",
        method: "GET",
        intervalSeconds: 120,
        timeoutSeconds: 5,
        expectedStatuses: "200-299, 418",
        word: "healthy",
        wordMode: "absent",
        failuresBeforeDown: 3,
      },
    });
    await expect.element(page.getByRole("link", { name: "Status page" })).toBeVisible();
    expect(rowsOf("Uptime checks")[0]?.slice(1, 7)).toEqual([
      "Pending",
      "–",
      "–",
      "–",
      "Not run yet",
      // The dash for the eye, the words for a screen reader.
      "–Not checked yet",
    ]);
  });

  test("edits, pauses, and deletes a check from its row", async () => {
    const api = installFakeApi();
    renderApp(UPTIME);
    await page.getByRole("button", { name: "Edit API health" }).click();
    const form = dialog("Edit “API health”");
    await expect.element(form.getByLabelText("URL")).toHaveValue(API?.url ?? "");
    await expect.element(form.getByLabelText("Word (optional)")).toHaveValue("healthy");
    await form.getByLabelText("Name").fill("API");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toMatchObject({
      method: "PATCH",
      path: `${CHECKS_PATH}/${API?.id}`,
      body: { name: "API", url: API?.url, intervalSeconds: 300 },
    });
    await expect.element(page.getByRole("link", { name: "API", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Pause Shop home" }).click();
    await expect.element(page.getByRole("button", { name: "Resume Shop home" })).toBeVisible();
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `${CHECKS_PATH}/${SHOP?.id}`,
      body: { paused: true },
    });
    expect(rowsOf("Uptime checks")[0]?.[1]).toBe("Paused");

    await page.getByRole("button", { name: "Delete Shop home" }).click();
    const confirm = dialog("Delete the check “Shop home”?");
    await confirm.getByRole("button", { name: "Delete check" }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "Shop home" })).not.toBeInTheDocument();
    expect(api.requests.filter((path) => path === `${CHECKS_PATH}/${SHOP?.id}`)).toEqual([
      `${CHECKS_PATH}/${SHOP?.id}`,
      `${CHECKS_PATH}/${SHOP?.id}`,
    ]);
  });
});

describe("a check's page", () => {
  test("opens from the list with its state, uptime, response time, incidents, and failures", async () => {
    const api = installFakeApi();
    const router = renderApp(UPTIME);
    await page.getByRole("link", { name: "API health" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(`${UPTIME}/${API?.id}`);
    await expect.element(page.getByRole("heading", { name: "API health" })).toBeVisible();
    await expect.element(sidebarLink("Uptime")).toHaveAttribute("data-active");
    await expect
      .element(page.getByText("Down since 16 Nov 2026, 09:40: Status code."))
      .toBeVisible();
    expect(api.requests).toContain(`${CHECKS_PATH}/${API?.id}/results?period=7d`);

    const stats = [...document.querySelectorAll("dl > div")].map((item) => item.textContent);
    expect(stats).toEqual([
      "Uptime in this period98.76%288 runs, 3 failed",
      "Last 24 hours70.00%",
      "Last 7 days95.00%",
      "Last 30 days–",
      "Certificate expires–Seen on HTTPS answers",
    ]);

    await expect.element(page.getByRole("heading", { name: "Response time" })).toBeVisible();
    // The keyboard reads the latest bucket: 23:00 in Singapore, 100 + 23 × 10 ms.
    await expect
      .element(page.getByRole("slider", { name: "Response time, API health, per hour" }))
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 23:00 to Tue 17 Nov 2026, 00:00: Response time 330 ms",
      );

    await expect
      .element(page.getByRole("table", { name: "Incidents, newest first" }))
      .toBeVisible();
    expect(
      rowsOf("Incidents, newest first").map((cells) => [cells[0], cells[1], cells[3]]),
    ).toEqual([
      ["16 Nov 2026, 09:40", "Ongoing", "Status codeIt answered 503, which does not count as up."],
      ["16 Nov 2026, 03:05", "16 Nov 2026, 03:30", "TimeoutNo complete answer within 10 seconds."],
    ]);
    expect(rowsOf("Incidents, newest first")[1]?.[2]).toBe("25 min");
    expect(rowsOf("Latest failures, newest first")).toEqual([
      [
        "16 Nov 2026, 09:45",
        "Status code",
        "503",
        "48 ms",
        "It answered 503, which does not count as up.",
      ],
      [
        "16 Nov 2026, 03:10",
        "Timeout",
        "–No answer",
        "10 s",
        "No complete answer within 10 seconds.",
      ],
    ]);
  });

  test("keeps the period in the address and asks for it", async () => {
    const api = installFakeApi();
    renderApp(`${UPTIME}/${SHOP?.id}?period=30d`);
    await expect.element(page.getByRole("heading", { name: "Shop home" })).toBeVisible();
    await expect
      .poll(() => api.requests)
      .toContain(`${CHECKS_PATH}/${SHOP?.id}/results?period=30d`);
    expect(api.requests).toContain(`${CHECKS_PATH}/${SHOP?.id}/incidents?period=30d`);
    // An HTTPS check shows when its certificate expires.
    await expect.element(page.getByText("31 Jan 2027")).toBeVisible();
    // No environment picker: checks have none.
    await expect
      .element(page.getByRole("combobox", { name: "Environment" }))
      .not.toBeInTheDocument();
  });

  test("says when no run got an answer, and when nothing failed", async () => {
    installFakeApi({
      checkResults: () => ({
        timeZone: "Asia/Singapore",
        firstDay: "2026-11-16",
        lastDay: "2026-11-16",
        retentionDays: 90,
        uptime: null,
        start: "2026-11-15T16:00:00.000Z",
        stepSeconds: 3600,
        buckets: 24,
        responseMs: Array.from({ length: 24 }, () => null),
        runs: 0,
        failures: 0,
        latestFailures: [],
      }),
      incidents: () => ({
        timeZone: "Asia/Singapore",
        firstDay: "2026-11-16",
        lastDay: "2026-11-16",
        incidents: [],
        truncated: false,
      }),
    });
    renderApp(`${UPTIME}/${SHOP?.id}`);
    await expect.element(page.getByText("The check did not run in this period.")).toBeVisible();
    await expect.element(page.getByText("No run failed in this period.")).toBeVisible();
    await expect.element(page.getByText("No incidents in this period.")).toBeVisible();
  });

  test("pauses from its page, and goes back to the list once deleted", async () => {
    const api = installFakeApi();
    const router = renderApp(`${UPTIME}/${SHOP?.id}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect
      .element(page.getByText("Paused: it does not run until it is resumed."))
      .toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await dialog("Delete the check “Shop home”?")
      .getByRole("button", { name: "Delete check" })
      .click();
    await expect.poll(() => router.state.location.pathname).toBe(UPTIME);
    expect(api.checks.map((check) => check.name)).toEqual(["API health"]);
  });

  test("says when the check does not exist", async () => {
    installFakeApi();
    renderApp(`${UPTIME}/cccccccc-cccc-4ccc-8ccc-999999999999`);
    await expect.element(page.getByText("No such check")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "All checks" })).toBeVisible();
  });

  test("says when the results fail to load, with a retry", async () => {
    let fail = true;
    installFakeApi({
      checkResults: () =>
        fail
          ? new Response(JSON.stringify({ error: "reports_busy", message: "Busy." }), {
              status: 503,
            })
          : {
              timeZone: "Asia/Singapore",
              firstDay: "2026-11-16",
              lastDay: "2026-11-16",
              retentionDays: 90,
              uptime: 1,
              start: "2026-11-15T16:00:00.000Z",
              stepSeconds: 3600,
              buckets: 1,
              responseMs: [120],
              runs: 1,
              failures: 0,
              latestFailures: [],
            },
    });
    renderApp(`${UPTIME}/${SHOP?.id}`);
    await expect.element(page.getByText("The results could not load")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Response time" })).toBeVisible();
  });
});
