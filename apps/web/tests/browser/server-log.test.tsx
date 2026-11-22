import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { SERVER_LOG_TIMING } from "../../src/features/settings/server-log-stream.ts";
import { ADMIN_ACCESS, installFakeApi } from "./fake-api.ts";
import { FakeEventSource, latestSource } from "./fake-event-source.ts";
import { renderApp } from "./render.tsx";

/*
 * The Server log tab (features/settings/server-log-tab.tsx), for the
 * owner: warnings and errors grouped, Show all with its filters, Pause,
 * following the newest line and Jump to latest, Download, the connection's
 * states, and the fit at 390 and 1440, against a fake EventSource
 * (fake-event-source.ts). The API's side is apps/api/tests/server-log.test.ts.
 */

const TAB = "/settings?tab=server-log";
/** 22 Nov 2026, 12:30:05.123 UTC: 20:30:05.123 in the fake instance's Asia/Singapore. */
const AT = 1_795_350_605_123;
const panel = () => page.getByRole("tabpanel", { name: "Server log" });
const problems = () => panel().getByRole("list", { name: "Warnings and errors, newest first" });
const box = () => panel().getByRole("log", { name: "Server log lines, newest at the bottom" });
const connection = () => panel().getByRole("status", { name: "Connection" });
const showAll = () =>
  panel()
    .getByRole("group", { name: "Which lines to show" })
    .getByRole("button", { name: "Show all" });
const lineTexts = () =>
  [...document.querySelectorAll<HTMLElement>("[role=log] li[data-line] > button")].map(
    (button) => button.textContent,
  );

const realTiming = { ...SERVER_LOG_TIMING, retryMs: { ...SERVER_LOG_TIMING.retryMs } };

beforeEach(() => {
  SERVER_LOG_TIMING.flushMs = 0;
  SERVER_LOG_TIMING.retryMs = { first: 50, max: 200 };
});

afterEach(async () => {
  Object.assign(SERVER_LOG_TIMING, realTiming);
  await page.viewport(1280, 900);
  vi.restoreAllMocks();
});

/** Opens the tab and plays the stream's start: hello, the lines kept, ready. */
async function openWith(
  lines: { process: "api" | "worker"; line: Record<string, unknown> }[],
  apiLevel = "info",
) {
  installFakeApi();
  renderApp(TAB);
  await expect.element(page.getByRole("tab", { name: "Server log", selected: true })).toBeVisible();
  await expect.poll(() => FakeEventSource.opened.length).toBe(1);
  const source = latestSource();
  source.hello(apiLevel);
  for (const item of lines) source.line(item.process, item.line);
  source.ready();
  return source;
}

const warn = (msg: string, time = AT) => ({ level: 40, time, pid: 1, msg });

describe("the Server log tab", () => {
  test("opens its stream only while it is the tab shown, and closes it on leaving", async () => {
    installFakeApi();
    renderApp("/settings");
    await expect.element(page.getByRole("tab", { name: "General", selected: true })).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(FakeEventSource.opened).toEqual([]);

    await page.getByRole("tab", { name: "Server log" }).click();
    await expect.poll(() => FakeEventSource.opened.length).toBe(1);
    expect(latestSource().url).toBe("/api/settings/server-log");
    await expect.element(panel().getByRole("heading", { name: "Server log" })).toBeVisible();
    await expect
      .element(
        panel().getByText("The API's and the worker's log lines since they last started", {
          exact: false,
        }),
      )
      .toBeVisible();

    await page.getByRole("tab", { name: "General" }).click();
    await expect.poll(() => latestSource().closed).toBe(true);
  });

  test("an admin never sees it, even by its address", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(TAB);
    await expect.element(page.getByRole("tab", { name: "Storage", selected: true })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Server log" })).not.toBeInTheDocument();
    expect(FakeEventSource.opened).toEqual([]);
  });

  test("by default, warnings and errors, repeats grouped with a count and the latest time, newest first", async () => {
    await openWith([
      { process: "api", line: { level: 30, time: AT, msg: "incoming request" } },
      {
        process: "worker",
        line: { level: "warn", time: AT - 60_000, name: "worker", msg: "storage is low" },
      },
      { process: "api", line: warn("a report took too long", AT - 5000) },
      { process: "api", line: warn("a report took too long", AT - 3000) },
      {
        process: "api",
        line: {
          level: 50,
          time: AT - 2000,
          msg: "could not store events",
          err: { message: "ClickHouse is down" },
        },
      },
      { process: "api", line: warn("a report took too long", AT) },
    ]);
    await expect.element(connection()).toHaveTextContent("Live");
    await expect.element(problems()).toBeVisible();
    const rows = problems().getByRole("listitem");
    await expect.poll(() => rows.elements().length).toBe(3);
    const texts = rows.elements().map((row) => row.textContent);
    expect(texts[0]).toMatch(
      /^Warning\s*API\s*a report took too long\s*3 times.*22 Nov, 20:30:05$/,
    );
    expect(texts[1]).toMatch(/^Error\s*API\s*could not store events\s*Once.*22 Nov, 20:30:03$/);
    expect(texts[2]).toMatch(/^Warning\s*Worker\s*storage is low\s*Once/);
    // Info lines are not among them.
    expect(texts.join(" ")).not.toContain("incoming request");

    // A row opens to its newest line's whole object.
    await rows.nth(1).getByRole("button").click();
    await expect.element(rows.nth(1).getByRole("button")).toHaveAttribute("aria-expanded", "true");
    const json = rows.nth(1).element().querySelector("pre")?.textContent ?? "";
    expect(JSON.parse(json)).toEqual({
      process: "api",
      level: 50,
      time: AT - 2000,
      msg: "could not store events",
      err: { message: "ClickHouse is down" },
    });
  });

  test("with no warnings or errors, it says so and offers Show all", async () => {
    await openWith([{ process: "api", line: { level: 30, time: AT, msg: "server listening" } }]);
    await expect
      .element(panel().getByText("No warnings or errors since the API and the worker started"))
      .toBeVisible();
    // The empty state's own Show all, after the toggle's.
    await panel().getByRole("button", { name: "Show all" }).last().click();
    await expect.element(box()).toBeVisible();
    await expect.element(showAll()).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(lineTexts)
      .toEqual([expect.stringMatching(/^20:30:05\.123\s*API\s*Info\s*server listening$/)]);
  });

  test("LOG_LEVEL above warn says the API writes no warnings", async () => {
    await openWith([], "error");
    await expect
      .element(
        panel().getByText("LOG_LEVEL is error on this server, so the API writes no warning lines."),
      )
      .toBeVisible();
  });
});

describe("Show all", () => {
  test("every line, newest at the bottom, with a request's method, URL, status, and duration", async () => {
    const source = await openWith([
      {
        process: "api",
        line: {
          level: 30,
          time: AT,
          reqId: "req-1",
          req: { method: "GET", url: "/api/projects?x=1" },
          msg: "incoming request",
        },
      },
      {
        process: "api",
        line: {
          level: 30,
          time: AT + 12,
          reqId: "req-1",
          res: { statusCode: 200, method: "GET", url: "/api/projects?x=1" },
          responseTime: 11.6,
          msg: "request completed",
        },
      },
      {
        process: "worker",
        line: { level: "error", time: AT + 20, name: "worker", msg: "retention failed" },
      },
    ]);
    await showAll().click();
    await expect
      .poll(lineTexts)
      .toEqual([
        expect.stringMatching(
          /^20:30:05\.123\s*API\s*Info\s*incoming request\s*GET \/api\/projects\?x=1$/,
        ),
        expect.stringMatching(
          /^20:30:05\.135\s*API\s*Info\s*request completed\s*GET \/api\/projects\?x=1 200 \(12 ms\)$/,
        ),
        expect.stringMatching(/^20:30:05\.143\s*Worker\s*Error\s*retention failed$/),
      ]);
    source.line("worker", { level: "info", time: AT + 30, name: "worker", msg: "a new one" });
    await expect.poll(() => lineTexts().at(-1)).toMatch(/a new one$/);
  });

  test("filters by process, by level at or above, and by text; and says what LOG_LEVEL leaves out", async () => {
    await openWith([
      { process: "api", line: { level: 20, time: AT, msg: "a debug line" } },
      { process: "api", line: { level: 30, time: AT, msg: "api info" } },
      { process: "worker", line: { level: "info", time: AT, msg: "worker info" } },
      {
        process: "worker",
        line: { level: "warn", time: AT, msg: "worker warning", job: "favicons" },
      },
      { process: "api", line: { level: 50, time: AT, msg: "api error" } },
    ]);
    await showAll().click();
    // Info and above, by default.
    await expect.poll(() => lineTexts().length).toBe(4);

    await panel().getByRole("combobox", { name: "Process" }).click();
    await page.getByRole("option", { name: "Worker" }).click();
    await expect
      .poll(lineTexts)
      .toEqual([expect.stringMatching(/worker info$/), expect.stringMatching(/worker warning$/)]);

    await panel().getByRole("combobox", { name: "Level, at or above" }).click();
    await page.getByRole("option", { name: "Warning and above" }).click();
    await expect.poll(lineTexts).toEqual([expect.stringMatching(/worker warning$/)]);

    await panel().getByRole("combobox", { name: "Process" }).click();
    await page.getByRole("option", { name: "All processes" }).click();
    await expect.poll(() => lineTexts().length).toBe(2);

    // The text filter reads the whole line, its fields too.
    await panel().getByRole("searchbox", { name: "Filter lines" }).fill("FAVICONS");
    await expect.poll(lineTexts).toEqual([expect.stringMatching(/worker warning$/)]);
    await panel().getByRole("searchbox", { name: "Filter lines" }).fill("nothing like it");
    await expect.element(panel().getByText("No lines match these filters.")).toBeVisible();
    await panel().getByRole("searchbox", { name: "Filter lines" }).fill("");

    await panel().getByRole("combobox", { name: "Level, at or above" }).click();
    await page.getByRole("option", { name: "Debug and above" }).click();
    await expect.poll(() => lineTexts().length).toBe(5);
    await expect
      .element(
        panel().getByText("LOG_LEVEL is info on this server, so the API writes no debug lines."),
      )
      .toBeVisible();
  });

  test("Pause holds the lines shown, counts the new ones, and Resume shows them", async () => {
    const source = await openWith([
      { process: "api", line: { level: 30, time: AT, msg: "first" } },
    ]);
    await showAll().click();
    await expect.poll(() => lineTexts().length).toBe(1);

    await panel().getByRole("button", { name: "Pause" }).click();
    source.line("api", { level: 30, time: AT, msg: "second" });
    source.line("worker", { level: "info", time: AT, msg: "third" });
    const resume = panel().getByRole("button", { name: "Resume (2 new)" });
    await expect.element(resume).toBeVisible();
    await expect.element(resume).toHaveAttribute("aria-pressed", "true");
    expect(lineTexts()).toHaveLength(1);

    await resume.click();
    await expect.poll(() => lineTexts().length).toBe(3);
    await expect.element(panel().getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("follows the newest line at the bottom; scrolling up stops it, and Jump to latest goes back", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      process: "api" as const,
      line: { level: 30, time: AT + index, msg: `line ${index + 1}` },
    }));
    const source = await openWith(many);
    await showAll().click();
    await expect.poll(() => lineTexts().length).toBe(120);
    const element = box().element();
    const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    await expect.poll(atBottom).toBe(true);

    source.line("api", { level: 30, time: AT + 500, msg: "line 121" });
    await expect.poll(() => lineTexts().length).toBe(121);
    await expect.poll(atBottom).toBe(true);
    await expect
      .element(panel().getByRole("button", { name: "Jump to latest" }))
      .not.toBeInTheDocument();

    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
    const jump = panel().getByRole("button", { name: "Jump to latest" });
    await expect.element(jump).toBeVisible();
    source.line("api", { level: 30, time: AT + 600, msg: "line 122" });
    await expect.poll(() => lineTexts().length).toBe(122);
    expect(element.scrollTop).toBe(0);

    await jump.click();
    await expect.poll(atBottom).toBe(true);
    await expect.element(jump).not.toBeInTheDocument();
    source.line("api", { level: 30, time: AT + 700, msg: "line 123" });
    await expect.poll(() => lineTexts().length).toBe(123);
    await expect.poll(atBottom).toBe(true);
  });

  test("a line opens to its whole object", async () => {
    await openWith([
      {
        process: "worker",
        line: { level: "warn", time: AT, name: "worker", msg: "slow", ms: 9000 },
      },
    ]);
    await showAll().click();
    const row = box().getByRole("button", { name: /slow/ });
    await row.click();
    await expect.element(row).toHaveAttribute("aria-expanded", "true");
    const json = document.querySelector("[role=log] pre")?.textContent ?? "";
    expect(JSON.parse(json)).toEqual({
      process: "worker",
      level: "warn",
      time: AT,
      name: "worker",
      msg: "slow",
      ms: 9000,
    });
  });
});

describe("Download", () => {
  test("saves the lines in this browser as a .jsonl file, each with its process", async () => {
    await openWith([
      { process: "api", line: { level: 30, time: AT, msg: "one" } },
      { process: "worker", line: { level: "warn", time: AT, name: "worker", msg: "two" } },
    ]);
    const blobs: Blob[] = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (blob instanceof Blob) blobs.push(blob);
      return createObjectURL(blob);
    });
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    await panel().getByRole("button", { name: "Download" }).click();
    await expect.poll(() => clicked).toHaveLength(1);
    expect(clicked[0]?.download).toMatch(/^ottertrail-server-log-\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/);
    expect(clicked[0]?.href).toMatch(/^blob:/);
    expect(await blobs[0]?.text()).toBe(
      `${JSON.stringify({ process: "api", level: 30, time: AT, msg: "one" })}\n${JSON.stringify({ process: "worker", level: "warn", time: AT, name: "worker", msg: "two" })}\n`,
    );
  });

  test("is off until a line arrives", async () => {
    await openWith([]);
    await expect.element(panel().getByRole("button", { name: "Download" })).toBeDisabled();
  });
});

describe("the connection", () => {
  test("connecting, live, then reconnecting after a drop, with the lines kept, from after the last line", async () => {
    installFakeApi();
    renderApp(TAB);
    await expect.poll(() => FakeEventSource.opened.length).toBe(1);
    await expect.element(connection()).toMatchTextContent(/^Connecting$/);
    const first = latestSource();
    first.hello();
    first.line("api", warn("kept through the drop"));
    first.line("api", warn("kept through the drop"));
    first.ready();
    await expect.element(connection()).toMatchTextContent(/^Live$/);

    first.fail();
    await expect
      .element(connection())
      .toMatchTextContent(/The connection dropped\. Trying again in 1 second\./);
    await expect.element(connection()).toMatchTextContent(/^Reconnecting /);
    expect(first.closed).toBe(true);
    await expect.element(problems().getByText("2 times")).toBeVisible();

    // The page reconnects by itself, asking for the lines after its last.
    await expect.poll(() => FakeEventSource.opened.length).toBe(2);
    const second = latestSource();
    expect(second.url).toBe("/api/settings/server-log?after=abc123%3A2");
    second.hello();
    second.ready();
    await expect.element(connection()).toMatchTextContent(/^Live$/);
    await expect.element(problems().getByText("2 times")).toBeVisible();
  });

  test("the wait doubles while the API stays away, and Reconnect now tries at once", async () => {
    SERVER_LOG_TIMING.retryMs = { first: 60_000, max: 120_000 };
    installFakeApi();
    renderApp(TAB);
    await expect.poll(() => FakeEventSource.opened.length).toBe(1);
    latestSource().fail();
    await expect.element(connection()).toMatchTextContent(/Trying again in 60 seconds\./);
    await panel().getByRole("button", { name: "Reconnect now" }).click();
    await expect.poll(() => FakeEventSource.opened.length).toBe(2);
    await expect.element(connection()).toMatchTextContent(/^Connecting$/);
  });

  test("closed by the API: too many open, said plainly, with Reconnect", async () => {
    const source = await openWith([{ process: "api", line: warn("still here") }]);
    source.end("busy", { maxStreams: 5 });
    await expect
      .element(connection())
      .toMatchTextContent(
        /5 Server log views are open already, the most the server streams at once\. Close one, then reconnect\./,
      );
    await expect.element(connection()).toMatchTextContent(/^Closed /);
    expect(source.closed).toBe(true);
    await expect.element(problems().getByText("still here")).toBeVisible();
    // No reconnect of its own.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(FakeEventSource.opened).toHaveLength(1);

    await connection().getByRole("button", { name: "Reconnect" }).click();
    await expect.poll(() => FakeEventSource.opened.length).toBe(2);
  });

  test("closed by the API: the session ended", async () => {
    const source = await openWith([]);
    source.end("access");
    await expect
      .element(connection())
      .toMatchTextContent(/Your session ended, or you're no longer the owner\./);
    await expect.element(connection().getByRole("button", { name: "Reconnect" })).toBeVisible();
  });
});

describe("refused and bounded", () => {
  test("a drop the API then refuses for the session shows the session ended, and stops retrying", async () => {
    const api = installFakeApi();
    renderApp(TAB);
    await expect.poll(() => FakeEventSource.opened.length).toBe(1);
    const source = latestSource();
    source.hello();
    source.line("api", warn("kept"));
    source.ready();
    await expect.element(connection()).toMatchTextContent(/^Live$/);

    // The API restarted and the session is gone: the stream's retry would get 401.
    api.signedIn = false;
    source.fail();
    await expect
      .element(connection())
      .toMatchTextContent(/Your session ended, or you're no longer the owner\./);
    await expect.element(connection()).toMatchTextContent(/^Closed /);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(FakeEventSource.opened.length).toBeLessThanOrEqual(2);
    const count = FakeEventSource.opened.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(FakeEventSource.opened).toHaveLength(count);
    await expect.element(problems().getByText("kept")).toBeVisible();
  });

  test("the browser keeps at most maxBytes of lines, the oldest dropped", async () => {
    SERVER_LOG_TIMING.maxBytes = 2000;
    const source = await openWith([]);
    await showAll().click();
    for (let index = 1; index <= 40; index += 1) {
      source.line("api", { level: 30, time: AT, msg: `line ${index} ${"x".repeat(100)}` });
    }
    await expect.poll(() => lineTexts().at(-1)).toMatch(/line 40 /);
    const kept = lineTexts();
    expect(kept.length).toBeLessThan(20);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept[0]).not.toMatch(/line 1 /);
  });
});

describe("the Server log fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} wide, both views: nothing sideways`, async () => {
      await page.viewport(width, height);
      await openWith([
        {
          process: "api",
          line: {
            level: 30,
            time: AT,
            req: {
              method: "GET",
              url: `/api/projects/${"a".repeat(36)}/analytics?period=30d&environment=production`,
            },
            msg: "incoming request",
          },
        },
        {
          process: "worker",
          line: {
            level: "error",
            time: AT,
            name: "worker",
            msg: `retention failed: ${"x".repeat(300)}`,
          },
        },
        {
          process: "api",
          line: warn("a report took too long, and this message goes on for quite a while"),
        },
      ]);
      const fits = () => {
        const content = document.querySelector("[data-slot=app-content]");
        expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        const shown = document.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])");
        expect(shown?.scrollWidth).toBeLessThanOrEqual(shown?.clientWidth ?? 0);
      };
      await expect.poll(() => problems().getByRole("listitem").elements().length).toBe(2);
      fits();
      await showAll().click();
      await expect.poll(() => lineTexts().length).toBe(3);
      fits();
      const log = box().element();
      expect(log.scrollWidth).toBeLessThanOrEqual(log.clientWidth);
      // The controls never wrap their labels.
      for (const name of ["Pause", "Download"]) {
        const button = panel().getByRole("button", { name }).element();
        expect(button.getBoundingClientRect().height).toBeLessThanOrEqual(40);
      }
    });
  }
});
