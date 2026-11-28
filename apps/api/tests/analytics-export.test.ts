import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { attachment, csvFileName, csvLines, csvText } from "../src/reports/csv.ts";
import { MAX_EXPORT_ROWS } from "../src/reports/reports.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * The Web analytics page's CSV exports (docs/web-analytics.md, "CSV
 * export"): each list in full, the summary, and the chart, with the page's
 * checks and access, and cells that a spreadsheet cannot run.
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProject = "";
let bigProject = "";

function event(
  name: string,
  visitorId: string,
  minutes: number,
  path: string,
  more: Partial<NewEvent> = {},
): NewEvent {
  return {
    eventId: randomUUID(),
    name,
    occurredAt: minutesAgo(minutes),
    path,
    hostname: "shop.example",
    visitorId,
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
    ...more,
  };
}

const pageview = (visitorId: string, minutes: number, path: string, more?: Partial<NewEvent>) =>
  event("pageview", visitorId, minutes, path, more);

const get = (path: string, { project = projectId, cookie = dashboard.cookie } = {}) =>
  dashboard.app.inject({ url: `/api/projects/${project}${path}`, headers: { cookie } });

/** A CSV body's lines, without the last line end. */
const lines = (body: string) => body.split("\r\n").slice(0, -1);

/** A tiny RFC 4180 reader: quoted fields, doubled quotes, CRLF between records. */
function parse(body: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < body.length; at += 1) {
    const character = body[at];
    if (quoted) {
      if (character === '"' && body[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\r" && body[at + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      at += 1;
    } else field += character;
  }
  return records;
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, { name: "Démo shop", allowed_hostnames: ["shop.example"] })
  ).id;
  await dashboard.store(projectId, [
    // 1 comes from a campaign whose name a spreadsheet would run, and signs up.
    pageview("1", 200, "/", {
      utm: { source: "newsletter", campaign: '=HYPERLINK("https://evil.example","x")' },
    }),
    pageview("1", 199, "/pricing"),
    event("signed_up", "1", 198, "/pricing"),
    // 2 sends an event whose name holds a quote, a comma, and a line break.
    pageview("2", 180, "/pricing", { referrer: "https://www.google.com/" }),
    event('+SUM(1,2) "quoted",\r\nnext', "2", 179, "/pricing"),
    event("@cmd", "2", 178, "/pricing"),
    // 3 bounces on the home page from a phone in another environment.
    pageview("3", 120, "/", { environment: "staging" }),
    // 4 leaves on the home page.
    pageview("4", 60, "/pricing"),
    pageview("4", 59, "/"),
  ]);

  otherProject = (await insertProject(dashboard.db, { name: "Other" })).id;
  await dashboard.store(otherProject, [pageview("9", 100, "/other-project-only")]);

  bigProject = (await insertProject(dashboard.db, { name: "Big" })).id;
  await dashboard.store(
    bigProject,
    Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, index) =>
      pageview(String(1000 + index), 300, `/page-${String(index).padStart(5, "0")}`),
    ),
  );
}, 120_000);

afterAll(async () => {
  await dashboard?.close();
});

describe("the CSV rules", () => {
  test("a cell that would start a formula gets a leading quote", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"]) {
      expect(csvText(`${start}1+2`)).toBe(`"'${start}1+2"`);
    }
    expect(csvText("/pricing")).toBe('"/pricing"');
    expect(csvText("a=b")).toBe('"a=b"');
  });

  test("text is quoted, quotes doubled, as RFC 4180 has it", () => {
    expect(csvText('=1+2";=1+2')).toBe('"\'=1+2"";=1+2"');
    expect(
      csvLines(
        ["A", "B"],
        [
          ["x,y", 3],
          [null, true],
        ],
      ),
    ).toBe('"A","B"\r\n"x,y",3\r\n,true\r\n');
  });

  test("the file's name keeps letters and digits, and has an ASCII copy", () => {
    const name = csvFileName("Démo shop!", "entry-page", {
      firstDay: "2026-11-01",
      lastDay: "2026-11-17",
    });
    expect(name).toBe("démo-shop-entry-page-2026-11-01-to-2026-11-17.csv");
    expect(attachment(name)).toBe(
      "attachment; filename=\"dmo-shop-entry-page-2026-11-01-to-2026-11-17.csv\"; filename*=UTF-8''d%C3%A9mo-shop-entry-page-2026-11-01-to-2026-11-17.csv",
    );
    expect(csvFileName("!!!", "summary", { firstDay: "2026-11-17", lastDay: "2026-11-17" })).toBe(
      "project-summary-2026-11-17.csv",
    );
  });
});

describe("a list's export", () => {
  test("is a download that is never stored, named after the project, the list, and the days", async () => {
    const response = await get("/analytics/export/list?report=pages&period=7d");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8; header=present");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toBe(
      "attachment; filename=\"dmo-shop-pages-2026-11-11-to-2026-11-17.csv\"; filename*=UTF-8''d%C3%A9mo-shop-pages-2026-11-11-to-2026-11-17.csv",
    );
    expect(response.headers["x-export-cut"]).toBeUndefined();
    expect(lines(response.body)).toEqual([
      '"Page","Visitors","Pageviews","Time on page (seconds)"',
      '"/pricing",3,3,',
      '"/",2,2,',
    ]);
  });

  test("custom events guard their names and keep quotes, commas, and line breaks in the cell", async () => {
    const response = await get("/analytics/export/list?report=customEvents&period=today");
    expect(parse(response.body)).toEqual([
      ["Event", "Visitors", "Events"],
      ['\'+SUM(1,2) "quoted",\r\nnext', "1", "1"],
      ["'@cmd", "1", "1"],
      ["signed_up", "1", "1"],
    ]);
  });

  test("a campaign that would run as a formula is text", async () => {
    const response = await get("/analytics/export/list?report=utmCampaign&period=today");
    expect(parse(response.body)).toEqual([
      ["UTM campaign", "Visitors", "Visits", "Bounce rate"],
      ["", "2", "2", "0"],
      ['\'=HYPERLINK("https://evil.example","x")', "1", "1", "0"],
    ]);
  });

  test("the exit pages add their exit rate, and a goal its converted visitors and rate", async () => {
    const plain = await get("/analytics/export/list?report=exitPage&period=today");
    expect(lines(plain.body)).toEqual([
      '"Exit page","Visitors","Visits","Bounce rate","Exit rate"',
      '"/pricing",2,2,0,0.6667',
      '"/",1,1,0,0.5',
    ]);
    const goal = await get(
      "/analytics/export/list?report=exitPage&period=today&goalEvent=signed_up",
    );
    expect(lines(goal.body)).toEqual([
      '"Exit page","Visitors","Visits","Bounce rate","Exit rate","Converted","Conversion rate"',
      '"/pricing",2,2,0,0.6667,1,0.5',
      '"/",1,1,0,0.5,0,0',
    ]);
  });

  test("every list follows the filters, the environment, and the search", async () => {
    const filtered = await get(
      "/analytics/export/list?report=pages&period=today&source=google.com",
    );
    expect(lines(filtered.body).slice(1)).toEqual(['"/pricing",1,1,']);
    const staging = await get(
      "/analytics/export/list?report=deviceType&period=today&environment=staging",
    );
    expect(lines(staging.body).slice(1)).toEqual(['"desktop",1,1,1']);
    const searched = await get("/analytics/export/list?report=pages&period=today&search=pri");
    expect(lines(searched.body).slice(1)).toEqual(['"/pricing",3,3,']);
  });

  test("holds every list of the page", async () => {
    for (const report of [
      "source",
      "referrer",
      "channel",
      "country",
      "browserVersion",
      "outboundLinks",
    ]) {
      const response = await get(`/analytics/export/list?report=${report}&period=today`);
      expect(response.statusCode).toBe(200);
    }
  });

  test(`stops at ${MAX_EXPORT_ROWS} rows, and says so in its name and a header`, async () => {
    const response = await get("/analytics/export/list?report=pages&period=today", {
      project: bigProject,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-export-cut"]).toBe(String(MAX_EXPORT_ROWS));
    expect(response.headers["content-disposition"]).toContain(
      `big-pages-2026-11-17-first-${MAX_EXPORT_ROWS}.csv`,
    );
    expect(lines(response.body)).toHaveLength(MAX_EXPORT_ROWS + 1);
  });

  test("takes the list route's checks, without paging", async () => {
    for (const query of [
      "report=pages&period=today&offset=0",
      "report=pages&period=today&limit=10",
      "report=pages&period=today&interval=day",
      "report=nope&period=today",
      "report=pages&period=today&country.contains=D",
    ]) {
      const response = await get(`/analytics/export/list?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/json");
    }
  });
});

describe("the page's export", () => {
  test("the summary has the period and the one compared with, and a goal's counts", async () => {
    const response = await get("/analytics/export/summary?period=today&goalEvent=signed_up");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain(
      'filename="dmo-shop-summary-2026-11-17.csv"',
    );
    expect(parse(response.body)).toEqual([
      [
        "Period",
        "First day",
        "Last day",
        "Visitors",
        "Pageviews",
        "Visits",
        "Views per visit",
        "Bounce rate",
        "Visit duration (seconds)",
        "Time engaged (seconds)",
        "Goal",
        "Converted",
        "Conversion rate",
        "Goal events",
      ],
      [
        "This period",
        "2026-11-17",
        "2026-11-17",
        "3",
        "5",
        "3",
        "1.67",
        "0",
        "100",
        "0",
        "signed_up",
        "1",
        "0.3333",
        "1",
      ],
      [
        "Previous period",
        "2026-11-16",
        "2026-11-16",
        "0",
        "0",
        "0",
        "",
        "",
        "",
        "",
        "signed_up",
        "0",
        "0",
        "0",
      ],
    ]);
  });

  test("without a comparison, the summary has one row", async () => {
    const response = await get("/analytics/export/summary?period=today&compare=off");
    expect(lines(response.body)).toHaveLength(2);
  });

  test("the chart has one row per point at the chosen interval, with the comparison", async () => {
    const response = await get("/analytics/export/chart?period=today&interval=hour&compare=year");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain(
      'filename="dmo-shop-chart-by-hour-2026-11-17.csv"',
    );
    const records = parse(response.body);
    expect(records[0]).toEqual([
      "Start",
      "End",
      "Partial",
      "Visitors",
      "Pageviews",
      "Visits",
      "Compared visitors",
      "Compared pageviews",
      "Compared visits",
    ]);
    // The twelve hours from midnight to noon.
    expect(records).toHaveLength(12 + 1);
    expect(records[9]).toEqual([
      "2026-11-17T08:00",
      "2026-11-17",
      "false",
      "1",
      "2",
      "1",
      "0",
      "0",
      "0",
    ]);
    expect(records.at(-1)?.slice(0, 3)).toEqual(["2026-11-17T11:00", "2026-11-17", "false"]);
    const goal = await get("/analytics/export/chart?period=today&compare=off&goalEvent=signed_up");
    const withGoal = parse(goal.body);
    expect(withGoal[0]).toEqual([
      "Start",
      "End",
      "Partial",
      "Visitors",
      "Pageviews",
      "Visits",
      "Converted",
    ]);
    expect(withGoal[9]).toEqual(["2026-11-17T08:00", "2026-11-17", "false", "1", "2", "1", "1"]);
  });

  test("takes the page's checks, without a list's limit", async () => {
    for (const query of ["period=today&limit=10", "period=week", "period=today&report=pages"]) {
      expect((await get(`/analytics/export/summary?${query}`)).statusCode).toBe(400);
    }
  });
});

describe("access", () => {
  test("needs a signed-in user", async () => {
    const response = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics/export/list?report=pages&period=today`,
    });
    expect(response.statusCode).toBe(401);
  });

  test("needs Web analytics view on the project, as the page does", async () => {
    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: "viewer@example.com",
      grants: { projects: [projectId], areas: { web_analytics: "view" } },
    });
    const product = await signedInUser(dashboard, {
      name: "Product",
      email: "product@example.com",
      grants: { projects: "all", areas: { product_analytics: "manage" } },
    });
    for (const path of [
      "/analytics/export/list?report=pages&period=today",
      "/analytics/export/summary?period=today",
      "/analytics/export/chart?period=today",
    ]) {
      expect((await get(path, { cookie: viewer.cookie })).statusCode).toBe(200);
      expect((await get(path, { cookie: product.cookie })).statusCode).toBe(403);
      expect((await get(path, { cookie: viewer.cookie, project: otherProject })).statusCode).toBe(
        404,
      );
    }
  });

  test("a saved goal needs Product analytics view, as on the page", async () => {
    const viewer = await signedInUser(dashboard, {
      name: "Goal viewer",
      email: "goal-viewer@example.com",
      grants: { projects: "all", areas: { web_analytics: "view" } },
    });
    const response = await get(
      `/analytics/export/list?report=pages&period=today&goal=${randomUUID()}`,
      { cookie: viewer.cookie },
    );
    expect(response.statusCode).toBe(403);
  });

  test("a project's export holds its own events only", async () => {
    const mine = await get("/analytics/export/list?report=pages&period=today");
    expect(mine.body).not.toContain("/other-project-only");
    const other = await get("/analytics/export/list?report=pages&period=today", {
      project: otherProject,
    });
    expect(lines(other.body).slice(1)).toEqual(['"/other-project-only",1,1,']);
  });

  test("shared links have no export", async () => {
    const created = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/share-links`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      payload: { name: "Export" },
    });
    const token = new URL(created.json<{ url: string }>().url).pathname.slice("/share/".length);
    const response = await dashboard.app.inject({
      url: `/api/share/${token}/analytics/export/list?report=pages&period=today`,
      remoteAddress: "203.0.113.10",
    });
    expect(response.statusCode).toBe(404);
  });
});
