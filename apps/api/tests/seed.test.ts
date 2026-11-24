import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { DEMO_PROJECT_NAME, removeDemo, seedDemo, type SeedResult } from "../scripts/seed-data.ts";
import { seededRandom } from "../scripts/seed-random.ts";
import { refusalOf } from "../scripts/seed-safety.ts";
import { buildSite, DAY_MS } from "../scripts/seed-site.ts";
import { INCIDENT_DAYS_AGO } from "../scripts/seed-telemetry.ts";
import {
  DEVELOPMENT_PUBLIC_URL,
  LOCAL_CLICKHOUSE,
  LOCAL_DATABASE_URL,
  LOCAL_OBJECT_STORE,
} from "../src/config.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";

/**
 * Guard seed replacement and refusal outside development (scripts/seed-data.ts, `vp run seed`).
 * Use isolated databases and development Garage.
 */

const GIB = 1024 ** 3;

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
// The development Garage from compose.yaml, as the replay and source map tests use.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let result: SeedResult;
let seconds = 0;

/**
 * Fix the clock so repeated seeds match at each window's edges.
 */
const SEED_NOW = new Date();

const seed = () =>
  seedDemo({
    now: SEED_NOW,
    db: dashboard.db,
    clickhouse: dashboard.reader.client,
    store,
    publicUrl: PUBLIC_URL,
    telemetryRetentionDays: 30,
    sourceMapLimitBytes: GIB,
    replayLimitBytes: GIB,
  });

beforeAll(async () => {
  dashboard = await signedInDashboard({
    objectStore: store,
    sourceMaps: { limitBytes: GIB },
    replays: { limitBytes: GIB },
  });
  const started = performance.now();
  result = await seed();
  seconds = (performance.now() - started) / 1000;
}, 300_000);

afterAll(async () => {
  // The test's databases go with it; the project's files in Garage would not.
  await removeDemo(dashboard.db, dashboard.reader.client, store);
  await dashboard.close();
  store.close();
}, 120_000);

async function get(path: string) {
  const response = await dashboard.app.inject({
    url: `/api/projects/${result.projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });
  expect({ path, status: response.statusCode }).toEqual({ path, status: 200 });
  return response.json();
}

describe("the demo data", () => {
  test("is made within its size, quickly", () => {
    const { counts } = result;
    console.log(`Seeded in ${seconds.toFixed(1)} s:`, counts);
    expect(counts.events).toBeGreaterThan(20_000);
    expect(counts.events).toBeLessThan(60_000);
    expect(counts.spans + counts.logs).toBeLessThan(100_000);
    expect(counts.replays).toBeGreaterThan(0);
    expect(counts.sourceMaps).toBe(2);
    expect(counts.firing).toBeGreaterThan(0);
    expect(counts.heatmapRecords).toBeGreaterThan(2_000);
    expect(counts.heatmapRecords).toBeLessThan(60_000);
  });
});

type Json = any;

/** An overview widget's answer, for the last 7 days. */
const widget = (name: string): Promise<Json> => get(`/overview/${name}?period=7d`);

describe("every page has something to show", () => {
  test("web analytics: visits, sources, campaigns, places, devices, pages, releases, goals", async () => {
    const answer: Json = await get("/analytics?period=30d");
    expect(answer.summary.visitors).toBeGreaterThan(1000);
    expect(answer.environments).toEqual(expect.arrayContaining(["production", "staging"]));
    expect(answer.pages.length).toBeGreaterThan(5);
    for (const [name, rows] of Object.entries(answer.breakdowns)) {
      expect({ name, rows: (rows as unknown[]).length > 0 }).toEqual({ name, rows: true });
    }
    expect(answer.breakdowns.utmCampaign.map((row: Json) => row.value)).toContain("november-picks");
    expect(answer.breakdowns.release.map((row: Json) => row.value)).toEqual(
      expect.arrayContaining(["2026.11.1", "2026.11.2"]),
    );
    expect(answer.customEvents.length).toBeGreaterThan(0);
    expect(answer.goals.length).toBeGreaterThanOrEqual(2);
    expect(answer.goals.every((goal: Json) => goal.visitors > 0)).toBe(true);
  });

  test("product events, the saved funnel, and retention over six weeks and more", async () => {
    const events: Json = await get("/events?period=30d");
    expect(events.events.map((event: Json) => event.name)).toEqual(
      expect.arrayContaining([
        "signup_started",
        "signed_up",
        "project_created",
        "checkout_completed",
      ]),
    );
    const { funnels }: Json = await get("/funnels");
    const signup = funnels.find((funnel: Json) => funnel.name === "Pricing to first project");
    const steps = encodeURIComponent(JSON.stringify(signup.steps));
    const funnel: Json = await get(`/funnel?period=30d&steps=${steps}&count=visitors&window=86400`);
    expect(funnel.steps).toHaveLength(4);
    expect(funnel.steps.at(-1).reached).toBeGreaterThan(0);
    const retention: Json = await get("/retention?period=90d");
    expect(retention.cohorts.length).toBeGreaterThanOrEqual(6);
  });

  test("known users, with their activity", async () => {
    const { users }: Json = await get("/users?period=30d");
    expect(users.length).toBeGreaterThan(20);
    const activity: Json = await get(`/users/${encodeURIComponent(users[0].userId)}?period=30d`);
    expect(JSON.stringify(activity)).toContain("pageview");
  });

  test("heatmaps: the main pages, clicks on the calls to action and the menu, rage and dead clicks on checkout", async () => {
    const { pages, heatmaps }: Json = await get("/heatmaps/pages?period=30d");
    expect(heatmaps).toBe(true);
    expect(pages.map((page: Json) => page.path)).toEqual(
      expect.arrayContaining(["/", "/pricing", "/cart", "/checkout"]),
    );
    const home: Json = await get("/heatmaps?period=30d&path=%2F&device=desktop");
    expect(home.totals.pageviews).toBeGreaterThan(50);
    expect(home.elements[0]).toMatchObject({ label: "hero-cta", element: "section>a" });
    expect(home.elements.map((element: Json) => element.label)).toContain("main-nav");
    const shares = home.scroll.reach.map((step: Json) => step.share);
    expect(shares).toEqual(shares.toSorted((a: number, b: number) => b - a));
    expect(home.totals.medianDepth).toBeGreaterThan(0.3);
    expect(home.totals.medianDepth).toBeLessThan(0.9);
    const checkout: Json = await get("/heatmaps?period=30d&path=%2Fcheckout");
    expect(checkout.hotspots[0]).toMatchObject({ label: "checkout-continue" });
    expect(checkout.totals.rageClicks).toBeGreaterThan(10);
    expect(checkout.deadHotspots[0]).toMatchObject({ label: "checkout-continue" });
    expect(checkout.totals.deadClicks).toBeGreaterThan(10);
    expect(home.deadHotspots).toEqual([
      expect.objectContaining({ label: null, element: "body>main>section:3>img" }),
    ]);
    const pricing: Json = await get("/heatmaps?period=30d&path=%2Fpricing");
    expect(pricing.totals.rageClicks).toBe(0);
    expect(pricing.totals.deadClicks).toBe(0);
  });

  test("speed: mobile noticeably slower than desktop", async () => {
    const { devices }: Json = await get("/speed?period=30d");
    const lcp = (type: string) => devices.find((device: Json) => device.deviceType === type).lcp;
    expect(lcp("mobile")).toBeGreaterThan(lcp("desktop") * 1.5);
  });

  test("errors: new, regressed, resolved, a source-mapped stack with replays, and the servers'", async () => {
    const { groups }: Json = await get("/errors?period=30d&status=all");
    const statuses = new Set(groups.map((group: Json) => group.status));
    expect([...statuses]).toEqual(expect.arrayContaining(["unresolved", "regressed", "resolved"]));
    const recent: Json = await get("/errors?period=7d");
    const sevenDaysAgo = Date.parse(recent.firstDay);
    expect(recent.groups.some((group: Json) => Date.parse(group.firstSeen) >= sevenDaysAgo)).toBe(
      true,
    );

    const checkout = groups.find((group: Json) => group.message.includes("(reading 'price')"));
    const detail: Json = await get(`/errors/${checkout.fingerprint}?period=7d`);
    expect(detail.sourceMaps.status).toBe("applied");
    expect(detail.frames[0].original.source).toContain("src/checkout/summary.ts");
    expect(
      detail.occurrences.some((occurrence: Json) => occurrence.replay?.status === "ready"),
    ).toBe(true);

    const server = groups.find((group: Json) => group.type.endsWith("PaymentProviderTimeout"));
    const serverDetail: Json = await get(`/errors/${server.fingerprint}?period=30d`);
    const traceId = serverDetail.occurrences[0].traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    const trace: Json = await get(`/traces/${traceId}`);
    expect(trace.spans.length).toBeGreaterThan(2);
  });

  test("session replays, linked to their errors, with timelines", async () => {
    const { replays }: Json = await get("/replays/list?period=30d");
    expect(replays.length).toBeGreaterThan(0);
    expect(replays.every((replay: Json) => replay.error !== null)).toBe(true);
    const timeline: Json = await get(`/replays/${replays[0].id}/timeline`);
    expect(JSON.stringify(timeline)).toContain("/checkout");
  });

  test("traces and logs, joined", async () => {
    const { traces }: Json = await get("/traces?period=7d");
    expect(traces.length).toBeGreaterThan(0);
    const failed: Json = await get("/traces?period=7d&errors=true");
    expect(failed.traces.length).toBeGreaterThan(0);
    const { logs }: Json = await get("/logs?period=7d");
    expect(logs.length).toBeGreaterThan(0);
    // The newest page can hold one severity at a quiet hour; the week holds several.
    const { logs: warnings }: Json = await get("/logs?period=7d&severity=warn");
    expect(warnings.length).toBeGreaterThan(0);
    const severities = new Set([...logs, ...warnings].map((log: Json) => log.severityText));
    expect(severities.size).toBeGreaterThan(1);
    expect(logs.some((log: Json) => log.traceId !== "")).toBe(true);
  });

  test("the Logs and Traces charts: records of several severities and traces spread over the week, and the incident", async () => {
    const now = SEED_NOW;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // The middle of the incident, 14:00 UTC (the test instance's timezone) two days ago.
    const incidentAt = today - INCIDENT_DAYS_AGO * DAY_MS + 14 * 3_600_000;
    const bucketOf = (chart: Json): number =>
      chart.bucketStarts.findLastIndex((start: string) => Date.parse(start) <= incidentAt);

    const volume: Json = await get("/logs/volume?period=7d");
    for (const level of ["debug", "info", "warn", "error"]) {
      expect({ level, any: volume.counts[level].some((count: number) => count > 0) }).toEqual({
        level,
        any: true,
      });
    }
    const perBucket: number[] = volume.counts.info.map(
      (_: number, index: number) =>
        volume.counts.debug[index] + volume.counts.info[index] + volume.counts.warn[index],
    );
    // Spread over the week: records in nearly every bucket.
    expect(perBucket.filter((count) => count > 0).length).toBeGreaterThan(volume.buckets * 0.9);
    const severe: number[] = volume.counts.warn.map(
      (warn: number, index: number) => warn + volume.counts.error[index],
    );
    const incident = bucketOf(volume);
    expect(severe[incident]).toBeGreaterThan(5 * Math.max(1, median(severe)));

    const chart: Json = await get("/traces/chart?period=7d");
    expect(chart.total.failed).toBeGreaterThan(0);
    expect(chart.traces.filter((count: number) => count > 0).length).toBeGreaterThan(
      chart.buckets * 0.9,
    );
    const at = bucketOf(chart);
    expect(chart.failed[at]).toBeGreaterThan(3 * Math.max(1, median(chart.failed)));
    const p95: number[] = chart.p95Us.filter((value: number | null) => value !== null);
    expect(chart.p95Us[at]).toBeGreaterThan(1.5 * median(p95));
  });

  test("metrics, services, databases, and hosts", async () => {
    const { metrics }: Json = await get("/metrics?period=7d");
    expect(new Set(metrics.map((metric: Json) => metric.kind))).toEqual(
      new Set(["gauge", "counter", "updown", "histogram"]),
    );
    const { services }: Json = await get("/services?period=7d");
    expect(services.map((service: Json) => service.service)).toEqual(
      expect.arrayContaining(["web", "billing"]),
    );
    const { databases }: Json = await get("/databases?period=7d");
    expect(databases.length).toBeGreaterThan(1);
    expect(databases[0].shapes.length).toBeGreaterThan(3);
    const { hosts }: Json = await get("/hosts?period=7d");
    expect(hosts.map((host: Json) => host.host).toSorted()).toEqual(["app-1", "app-2", "db-1"]);
    const charts: Json = await get("/hosts/charts?host=app-2&period=7d");
    expect(charts.charts.some((chart: Json) => chart.lines.length > 0)).toBe(true);
  });

  test("AI usage: models with and without a price, features, an agent's calls, users, failures", async () => {
    const report: Json = await get("/ai?period=7d");
    expect(report.totals.calls).toBeGreaterThan(100);
    expect(report.totals.costUsd).toBeGreaterThan(0);
    expect(report.totals.noPriceModels).toEqual(["llama3.3:70b"]);
    expect(report.models.map((row: Json) => row.model).toSorted()).toEqual([
      "claude-sonnet-4-6",
      "gpt-5.4-mini",
      "llama3.3:70b",
      "text-embedding-3-small",
    ]);
    expect(report.features.map((row: Json) => row.feature).toSorted()).toEqual([
      "",
      "product-search",
      "review-summarizer",
      "support-chat",
    ]);
    expect(report.users.length).toBeGreaterThan(0);
    // Rate limits on the assistant, timeouts on search: drawn, so at least one of them.
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.totals.failedShare).toBeLessThan(0.1);
  });

  test("the report charts: several metrics of each kind, a search incident, hosts from low to high", async () => {
    // Every kind has more than one metric, and every listed metric a sparkline with a line.
    const { metrics }: Json = await get("/metrics?period=7d");
    for (const kind of ["gauge", "counter", "updown", "histogram"]) {
      expect({
        kind,
        several: metrics.filter((metric: Json) => metric.kind === kind).length > 1,
      }).toEqual({ kind, several: true });
    }
    for (const metric of metrics) {
      const spark: Json = await get(
        `/metrics/sparkline?period=7d&name=${encodeURIComponent(metric.name)}&kind=${metric.kind}`,
      );
      const drawn = spark.values.filter((value: number | null) => value !== null).length;
      expect({ name: metric.name, drawn: drawn > spark.buckets / 2 }).toEqual({
        name: metric.name,
        drawn: true,
      });
    }
    // Requests every hour, and the incident's hours (two days ago, 13:00 to
    // 15:30) fail far more than the rest of the week.
    const services: Json = await get("/services/trend?period=7d");
    expect(services.stepSeconds).toBe(3600);
    const busyHours = services.counts.requests.filter((count: number) => count > 0).length;
    expect(busyHours).toBeGreaterThan(services.buckets * 0.9);
    // The incident's 14:00 to 15:00, as an hourly bucket (the instance is in UTC),
    // on the clock the seed ran with.
    const today = SEED_NOW;
    const incident =
      (Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - INCIDENT_DAYS_AGO,
        14,
      ) -
        Date.parse(services.start)) /
      3_600_000;
    const share = (index: number) =>
      services.counts.failed[index] / services.counts.requests[index];
    expect(share(incident)).toBeGreaterThan(
      (3 * services.totals.failed) / services.totals.requests,
    );
    // Database calls every hour, with more time spent in the incident.
    const databases: Json = await get("/databases/trend?period=7d");
    expect(databases.counts.calls.filter((count: number) => count > 0).length).toBeGreaterThan(
      databases.buckets * 0.9,
    );
    const hourly = databases.totals.totalUs / databases.buckets;
    expect(databases.counts.totalUs[incident]).toBeGreaterThan(2 * hourly);
    // The hosts' latest values differ, and one filesystem is past 90%.
    const { hosts }: Json = await get("/hosts?period=7d");
    const cpu = hosts.map((host: Json) => host.cpuPercent);
    expect(Math.max(...cpu) - Math.min(...cpu)).toBeGreaterThan(10);
    const memory = hosts.map((host: Json) => host.memoryPercent);
    expect(Math.max(...memory) - Math.min(...memory)).toBeGreaterThan(10);
    expect(Math.max(...hosts.map((host: Json) => host.filesystemPercent))).toBeGreaterThan(90);
  });

  test("uptime: three checks, a past incident, one down now, certificates", async () => {
    const { checks }: Json = await get("/checks");
    expect(checks).toHaveLength(3);
    expect(checks.filter((check: Json) => check.state === "down")).toHaveLength(1);
    expect(checks.every((check: Json) => check.tlsExpiresAt !== null)).toBe(true);
    const storefront = checks.find((check: Json) => check.name === "Storefront");
    const results: Json = await get(`/checks/${storefront.id}/results?period=30d`);
    expect(results.runs ?? results.chart?.runs).toBeGreaterThan(1000);
    const { incidents }: Json = await get(`/checks/${storefront.id}/incidents?period=30d`);
    expect(incidents.length).toBe(1);
  });

  test("alerts: rules of several kinds, one firing now, and history", async () => {
    const { rules }: Json = await get("/alert-rules");
    expect(new Set(rules.map((rule: Json) => rule.kind)).size).toBeGreaterThanOrEqual(5);
    const firing: Json = await get("/alerts/firing");
    expect(firing.alerts.length).toBeGreaterThan(0);
    const { alerts }: Json = await get("/alerts");
    expect(alerts.some((alert: Json) => alert.resolvedAt !== null)).toBe(true);
  });

  test("every overview widget, with the main goal and something that needs attention", async () => {
    const attention = await widget("attention");
    expect(attention.alerts.length + attention.down.length).toBeGreaterThan(0);
    const errors = await widget("errors");
    expect(errors.occurrences).toBeGreaterThan(0);
    expect(errors.newGroups).toBeGreaterThan(0);
    expect(errors.regressedGroups).toBeGreaterThan(0);
    expect((await widget("uptime")).checks).toHaveLength(3);
    expect((await widget("services")).services.length).toBeGreaterThan(0);
    expect((await widget("speed")).devices.length).toBeGreaterThan(1);
    const mainGoal = await widget("main-goal");
    expect(mainGoal.kind).toBe("goal");
    expect(mainGoal.goal.visitors).toBeGreaterThan(0);
    expect((await widget("traffic")).summary.visitors).toBeGreaterThan(0);
    expect((await widget("goals")).goals.length).toBeGreaterThan(1);
    const users = await widget("users");
    expect(users.active).toBeGreaterThan(0);
    expect(users.cohorts.length).toBeGreaterThan(0);
    const sources = await widget("sources");
    expect(sources.sources.length).toBeGreaterThan(0);
    expect(sources.pages.length).toBeGreaterThan(0);
  });
});

describe("a second run", () => {
  test("replaces the project with the same data", async () => {
    const first = result;
    const again = await seed();
    expect(again.replaced).toBe(1);
    expect(again.projectId).not.toBe(first.projectId);
    const named = await dashboard.db
      .selectFrom("projects")
      .select("id")
      .where("name", "=", DEMO_PROJECT_NAME)
      .execute();
    expect(named.map((project) => project.id)).toEqual([again.projectId]);
    // The same data: both runs use the same clock (SEED_NOW). What the API's own
    // clock decides (a few events at the edge of its 24-hour limit) may still differ.
    expect(Math.abs(again.counts.events - first.counts.events)).toBeLessThan(
      first.counts.events * 0.01,
    );
    expect(again.counts.checks).toBe(first.counts.checks);
    result = again;
  }, 300_000);
});

describe("the seed's randomness", () => {
  test("gives the same events on every run", () => {
    const now = new Date();
    const first = buildSite(seededRandom(7), "00000000-0000-4000-8000-000000000000", "UTC", now);
    const second = buildSite(seededRandom(7), "00000000-0000-4000-8000-000000000000", "UTC", now);
    expect(second.events.length).toBe(first.events.length);
    expect(second.events.slice(0, 50)).toEqual(first.events.slice(0, 50));
  });
});

describe("the seed command", () => {
  const local = {
    publicUrl: DEVELOPMENT_PUBLIC_URL,
    databaseUrl: LOCAL_DATABASE_URL,
    clickhouse: { ...LOCAL_CLICKHOUSE },
    objectStore: LOCAL_OBJECT_STORE,
  };

  test("runs against the development stack", () => {
    expect(refusalOf({}, local, { yes: false })).toBeNull();
    expect(refusalOf({ NODE_ENV: "development" }, local, { yes: false })).toBeNull();
  });

  test("never runs in production", () => {
    expect(refusalOf({ NODE_ENV: "production" }, local, { yes: true })).toContain("production");
  });

  test("asks for --yes when a setting points elsewhere", () => {
    const elsewhere = {
      ...local,
      publicUrl: "https://ottertrail.example.com",
      databaseUrl: "postgres://ottertrail@db.internal:5432/ottertrail",
    };
    const refusal = refusalOf({}, elsewhere, { yes: false });
    expect(refusal).toContain("PUBLIC_URL is https://ottertrail.example.com");
    expect(refusal).toContain("DATABASE_URL");
    expect(refusal).toContain("--yes");
    expect(refusalOf({}, elsewhere, { yes: true })).toBeNull();
  });
});
