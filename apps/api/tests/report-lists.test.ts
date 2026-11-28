import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * The Analytics page's Channels, Hostnames, campaign term and content, and
 * browser version lists, and the exit rate (docs/web-analytics.md,
 * "Breakdowns"), on the dashboard and on a shared link.
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let sourcesProject = "";
let token = "";

function pageview(
  visitorId: string,
  minutes: number,
  path: string,
  more: Partial<NewEvent> = {},
): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: minutesAgo(minutes),
    path,
    hostname: "shop.example",
    visitorId,
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
    ...more,
  };
}

const get = (path: string, project = projectId) =>
  dashboard.app.inject({
    url: `/api/projects/${project}${path}`,
    headers: { cookie: dashboard.cookie },
  });

const share = (path: string) =>
  dashboard.app.inject({ url: `/api/share/${token}${path}`, remoteAddress: "203.0.113.10" });

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, {
      name: "Lists",
      allowed_hostnames: ["shop.example", "docs.shop.example"],
    })
  ).id;

  await dashboard.store(projectId, [
    // 1 comes from a search, and leaves on the pricing page.
    pageview("1", 200, "/", { referrer: "https://www.google.com/" }),
    pageview("1", 199, "/pricing"),
    // 2 comes from a newsletter to the docs site, with a term and content.
    pageview("2", 180, "/guide", {
      hostname: "docs.shop.example",
      utm: {
        source: "newsletter",
        medium: "email",
        campaign: "november",
        term: "analytics",
        content: "header-link",
      },
      client: { browser: "Firefox", browserVersion: "133", os: "Windows", deviceType: "desktop" },
    }),
    // 3 was stored before hostnames were kept, and came from an assistant.
    pageview("3", 120, "/pricing", {
      hostname: undefined,
      referrer: "https://chatgpt.com/",
      client: { browser: "Chrome", browserVersion: "141", os: "Android", deviceType: "mobile" },
    }),
    // 4 types the address, sees the pricing, and leaves on the home page.
    pageview("4", 60, "/pricing"),
    pageview("4", 59, "/"),
  ]);

  sourcesProject = (
    await insertProject(dashboard.db, { name: "Sources", allowed_hostnames: ["shop.example"] })
  ).id;
  await dashboard.store(sourcesProject, [
    // google.com from its referrer only.
    pageview("11", 200, "/", { referrer: "https://www.google.com/" }),
    // newsletter from its tag only.
    pageview("12", 190, "/", {
      utm: { source: "newsletter", medium: "email", campaign: "november" },
    }),
    // news.ycombinator.com from a referrer that keeps its path.
    pageview("13", 180, "/", { referrer: "https://news.ycombinator.com/item" }),
    // chatgpt.com both ways: a referrer, and a tag without one.
    pageview("14", 170, "/", { referrer: "https://chatgpt.com/" }),
    pageview("15", 160, "/", { utm: { source: "chatgpt.com", medium: "referral" } }),
    // Direct / none: no referrer, and the site's own page as referrer.
    pageview("16", 150, "/"),
    pageview("17", 140, "/", { referrer: "https://shop.example/pricing" }),
  ]);

  const created = await dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/share-links`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    payload: { name: "Lists" },
  });
  if (created.statusCode !== 201) throw new Error(`No shared link: ${created.body}`);
  token = new URL(created.json<{ url: string }>().url).pathname.slice("/share/".length);
});

afterAll(async () => {
  await dashboard?.close();
});

const rows = (list: { value: string | null; visitors: number; visits: number }[]) =>
  list.map(({ value, visitors, visits }) => [value, visitors, visits]);

describe("the lists", () => {
  test("Channels group the visits by kind of source", async () => {
    const { breakdowns } = (await get("/analytics?period=today")).json();
    expect(rows(breakdowns.channel)).toEqual([
      ["AI assistants", 1, 1],
      ["Direct", 1, 1],
      ["Email", 1, 1],
      ["Organic search", 1, 1],
    ]);
  });

  test("Hostnames name the site each visit began on, Unknown for old rows last", async () => {
    const { breakdowns } = (await get("/analytics?period=today")).json();
    expect(rows(breakdowns.hostname)).toEqual([
      ["shop.example", 2, 2],
      ["docs.shop.example", 1, 1],
      [null, 1, 1],
    ]);
  });

  test("terms and content are listed as campaigns are, none a value of its own", async () => {
    const { breakdowns } = (await get("/analytics?period=today")).json();
    expect(rows(breakdowns.utmTerm)).toEqual([
      [null, 3, 3],
      ["analytics", 1, 1],
    ]);
    expect(rows(breakdowns.utmContent)).toEqual([
      [null, 3, 3],
      ["header-link", 1, 1],
    ]);
  });

  test("browser versions name their browser", async () => {
    const { breakdowns } = (await get("/analytics?period=today")).json();
    expect(rows(breakdowns.browserVersion)).toEqual([
      ["Chrome 142", 2, 2],
      ["Chrome 141", 1, 1],
      ["Firefox 133", 1, 1],
    ]);
  });

  test.each([
    ["channel", "a", ["AI assistants", "Email", "Organic search"]],
    ["hostname", "docs", ["docs.shop.example"]],
    ["utmTerm", "ANALYTICS", ["analytics"]],
    ["utmContent", "header", ["header-link"]],
    ["browserVersion", "fire", ["Firefox 133"]],
  ])("%s has a full list with search", async (report, search, values) => {
    const list = (
      await get(`/analytics/list?report=${report}&period=today&search=${search}`)
    ).json();
    expect(list.hasMore).toBe(false);
    expect(list.rows.map((row: { value: string }) => row.value)).toEqual(values);
  });
});

describe("a row's filter", () => {
  test.each([
    ["channel", "Email", 1],
    ["channel", "Direct", 1],
    ["hostname", "docs.shop.example", 1],
    ["hostname", "", 1],
    ["utmTerm", "analytics", 1],
    ["utmTerm", "", 3],
    ["utmContent", "header-link", 1],
    ["browserVersion", "Chrome 142", 2],
  ])("%s=%s keeps the visits of its row", async (name, value, visitors) => {
    const body = (await get(`/analytics?period=today&${name}=${encodeURIComponent(value)}`)).json();
    expect(body.summary.visitors).toBe(visitors);
  });

  test("of every channel row adds up to all visits", async () => {
    const all = (await get("/analytics?period=today")).json();
    let sum = 0;
    for (const row of all.breakdowns.channel as { value: string }[]) {
      const body = (
        await get(`/analytics?period=today&channel=${encodeURIComponent(row.value)}`)
      ).json();
      sum += body.summary.visits;
    }
    expect(sum).toBe(all.summary.visits);
  });
});

describe("the exit rate", () => {
  test("is a page's exits divided by its pageviews", async () => {
    const { breakdowns, pages } = (await get("/analytics?period=today")).json();
    expect(
      breakdowns.exitPage.map((row: { value: string; visits: number; exitRate: number }) => [
        row.value,
        row.visits,
        row.exitRate,
      ]),
    ).toEqual([
      // Three views of the pricing page, two of them a visit's last.
      ["/pricing", 2, 2 / 3],
      ["/", 1, 1 / 2],
      ["/guide", 1, 1],
    ]);
    // The pageviews are those of Top pages.
    expect(pages.find((page: { path: string }) => page.path === "/pricing").pageviews).toBe(3);
  });

  test("counts in the filtered visits, and in the full list", async () => {
    const filtered = (await get("/analytics?period=today&channel=Direct")).json();
    expect(filtered.breakdowns.exitPage).toMatchObject([{ value: "/", visits: 1, exitRate: 1 }]);
    const list = (await get("/analytics/list?report=exitPage&period=today&search=pricing")).json();
    expect(list.rows).toMatchObject([{ value: "/pricing", exitRate: 2 / 3 }]);
  });

  test("is only on the exit pages", async () => {
    const { breakdowns } = (await get("/analytics?period=today")).json();
    expect(breakdowns.entryPage[0]).not.toHaveProperty("exitRate");
  });
});

describe("a shared link", () => {
  test("shows the new lists, their full lists, and their filters", async () => {
    const answer = (await share("/analytics?period=today")).json();
    expect(rows(answer.breakdowns.channel)).toHaveLength(4);
    expect(rows(answer.breakdowns.hostname)[0]).toEqual(["shop.example", 2, 2]);
    expect(answer.breakdowns.exitPage[0]).toMatchObject({ value: "/pricing", exitRate: 2 / 3 });

    const list = (await share("/analytics/list?report=browserVersion&period=today")).json();
    expect(list.rows.map((row: { value: string }) => row.value)).toEqual([
      "Chrome 142",
      "Chrome 141",
      "Firefox 133",
    ]);

    const filtered = (await share("/analytics?period=today&hostname=docs.shop.example")).json();
    expect(filtered.summary.visitors).toBe(1);
  });
});

describe("the UTM lists", () => {
  test("list each tag alone, no tag a value of its own", async () => {
    const { breakdowns } = (await get("/analytics?period=today", sourcesProject)).json();
    expect(rows(breakdowns.utmSource)).toEqual([
      [null, 5, 5],
      ["chatgpt.com", 1, 1],
      ["newsletter", 1, 1],
    ]);
    expect(rows(breakdowns.utmMedium)).toEqual([
      [null, 5, 5],
      ["email", 1, 1],
      ["referral", 1, 1],
    ]);
  });

  test.each([
    ["utmSource", "newsletter", 1],
    ["utmSource", "", 5],
    ["utmMedium", "email", 1],
  ])("%s=%s keeps the visits of its row", async (name, value, visitors) => {
    const body = (
      await get(`/analytics?period=today&${name}=${encodeURIComponent(value)}`, sourcesProject)
    ).json();
    expect(body.summary.visitors).toBe(visitors);
  });

  test("have full lists with search", async () => {
    const list = (
      await get("/analytics/list?report=utmMedium&period=today&search=mail", sourcesProject)
    ).json();
    expect(rows(list.rows)).toEqual([["email", 1, 1]]);
  });
});

/** The page's lists, filtered by one source. */
async function detail(source: string) {
  const { breakdowns } = (
    await get(`/analytics?period=today&source=${encodeURIComponent(source)}`, sourcesProject)
  ).json();
  return breakdowns;
}

describe("one source's drill-down", () => {
  test("a source from its referrer only", async () => {
    const breakdowns = await detail("google.com");
    expect(rows(breakdowns.sourceKind)).toEqual([["referrer", 1, 1]]);
    expect(rows(breakdowns.referrer)).toEqual([["https://www.google.com/", 1, 1]]);
  });

  test("a source from its tag only, with the tag's medium and campaign", async () => {
    const breakdowns = await detail("newsletter");
    expect(rows(breakdowns.sourceKind)).toEqual([["tag", 1, 1]]);
    expect(rows(breakdowns.referrer)).toEqual([[null, 1, 1]]);
    expect(rows(breakdowns.utmMedium)).toEqual([["email", 1, 1]]);
    expect(rows(breakdowns.utmCampaign)).toEqual([["november", 1, 1]]);
  });

  test("a source both ways", async () => {
    const breakdowns = await detail("chatgpt.com");
    expect(rows(breakdowns.sourceKind)).toEqual([
      ["referrer", 1, 1],
      ["tag", 1, 1],
    ]);
    expect(rows(breakdowns.referrer)).toEqual([
      ["https://chatgpt.com/", 1, 1],
      [null, 1, 1],
    ]);
  });

  test("Direct / none: no tag and no referrer from another site", async () => {
    const breakdowns = await detail("Direct / none");
    expect(rows(breakdowns.sourceKind)).toEqual([["none", 2, 2]]);
    // The site's own page is a referrer, but not a source.
    expect(rows(breakdowns.referrer)).toEqual([
      ["https://shop.example/pricing", 1, 1],
      [null, 1, 1],
    ]);
  });

  test("a referrer keeps its path, and each row filters", async () => {
    const breakdowns = await detail("news.ycombinator.com");
    expect(rows(breakdowns.referrer)).toEqual([["https://news.ycombinator.com/item", 1, 1]]);
    const byReferrer = (
      await get(
        `/analytics?period=today&referrer=${encodeURIComponent("https://www.google.com/")}`,
        sourcesProject,
      )
    ).json();
    expect(byReferrer.summary.visitors).toBe(1);
    const tagged = (await get("/analytics?period=today&sourceKind=tag", sourcesProject)).json();
    expect(tagged.summary.visitors).toBe(2);
  });
});

describe("the new filters' operators", () => {
  test.each([
    // Text: every operator.
    ["hostname.contains=docs", 1],
    ["hostname.not=docs.shop.example", 3],
    ["hostname.notContains=docs", 3],
    ["utmTerm.contains=ANALY", 1],
    ["utmContent.notContains=header", 3],
    ["browserVersion.contains=chrome", 3],
    ["browserVersion=Chrome+142&browserVersion=Firefox+133", 3],
    // Fixed: is and is not, several values.
    ["channel=Email&channel=Direct", 2],
    ["channel.not=Email", 3],
  ])("%s", async (query, visitors) => {
    const body = (await get(`/analytics?period=today&${query}`)).json();
    expect(body.summary.visitors).toBe(visitors);
  });

  test.each([
    ["utmSource.contains=news", 1],
    ["utmMedium.not=email", 6],
    ["referrer.contains=ycombinator", 1],
    ["sourceKind.not=none", 5],
  ])("%s, on the sources project", async (query, visitors) => {
    const body = (await get(`/analytics?period=today&${query}`, sourcesProject)).json();
    expect(body.summary.visitors).toBe(visitors);
  });

  test.each(["channel.contains=mail", "sourceKind.notContains=tag"])(
    "a fixed value refuses %s",
    async (query) => {
      expect((await get(`/analytics?period=today&${query}`)).statusCode).toBe(400);
    },
  );

  test("work on a shared link", async () => {
    const body = (await share("/analytics?period=today&hostname.contains=docs")).json();
    expect(body.summary.visitors).toBe(1);
    const fixed = await share("/analytics?period=today&channel.not=Email");
    expect(fixed.json().summary.visitors).toBe(3);
  });
});
