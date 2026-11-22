import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

/**
 * Development demo data (`vp run seed`, scripts/seed.ts): a project named
 * "Demo shop" whose every dashboard page has something to show. It is
 * replaced on each run: the project from a previous run is deleted through
 * the project deletion every project goes through, then made again.
 *
 * Rows are built by the API's own code, with past times: events as the
 * collection endpoint builds them (seed-site.ts), traces, logs, and
 * metrics through the OTLP normalizers (seed-telemetry.ts), checks and
 * alerts through the worker's steps (seed-monitoring.ts), session replays
 * through the replay pipeline's functions, source maps through the
 * upload's. HTTP ingestion is not used: it refuses events more than a day
 * old, as it should.
 *
 * Touches nothing but its own project, apart from one notification
 * channel of the instance's, which it adds once and reuses: an email
 * channel to an address that cannot receive mail.
 */
import { aiCallsOf } from "../src/ai/calls.ts";
import type { ClickHouseClient } from "../src/clickhouse/clickhouse.ts";
import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { insertRows } from "../src/clickhouse/insert.ts";
import type { Reader } from "../src/clickhouse/query.ts";
import { type NewEvent, toClickHouse, toRow } from "../src/collection/event-store.ts";
import { LastEventRecorder } from "../src/collection/last-event.ts";
import type { Database } from "../src/db/schema.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { createSavedFunnel } from "../src/funnels/saved-funnels.ts";
import { createGoal } from "../src/goals/goals.ts";
import { storeHeatmapRecords } from "../src/heatmaps/store.ts";
import { channelValuesOf, createChannel, listChannels } from "../src/notifications/channels.ts";
import { funnelStepsOf } from "../src/product/funnel.ts";
import { createProject, deleteProject, updateProject } from "../src/projects/projects.ts";
import { linkReplays } from "../src/replays/link.ts";
import { joinReplays, storeChunk } from "../src/replays/replays.ts";
import { readInstanceSettings } from "../src/settings/settings.ts";
import { checkSourceMap, storeSourceMap } from "../src/source-maps/source-maps.ts";
import type { ObjectStore } from "../src/storage/object-store.ts";
import { normalizeLogs, normalizeMetrics, normalizeTraces } from "../src/telemetry/normalize.ts";
import { insertTelemetry } from "../src/telemetry/store.ts";
import { buildHeatmaps } from "./seed-heatmaps.ts";
import { seedMonitoring, type MonitoringCounts } from "./seed-monitoring.ts";
import { seededRandom } from "./seed-random.ts";
import {
  type Arrived,
  BUNDLES,
  buildSite,
  ERRORS,
  DAY_MS,
  MINIFIED,
  RELEASE_DAYS_AGO,
  RELEASES,
  SITE_HOST,
  STAGING_HOST,
} from "./seed-site.ts";
import { buildTelemetry } from "./seed-telemetry.ts";

export const DEMO_PROJECT_NAME = "Demo shop";
export const DEMO_CHANNEL_NAME = "Demo shop alerts (sends nothing)";
/** The `.example` domain is reserved: no mail is ever delivered to it. */
const DEMO_CHANNEL_ADDRESS = "alerts@demo-shop.example";
/** The randomness's seed: the same data on every run. */
const SEED = 20_261_119;
/** The heatmaps' own seed, so adding them left the rest of the data as it was. */
const HEATMAP_SEED = 20_261_120;
/** Rows per ClickHouse insert. */
const BATCH = 10_000;
/** Checkout errors that recorded a session replay: the latest. */
const REPLAYS = 6;

export interface SeedOptions {
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  /** The object store for source maps and replays; without one, both are left out. */
  store: ObjectStore | null;
  /** The instance's address, for the links in alert notifications. */
  publicUrl: string;
  telemetryRetentionDays: number;
  sourceMapLimitBytes: number;
  replayLimitBytes: number;
  now?: Date;
  log?: (message: string) => void;
}

export interface SeedResult {
  projectId: string;
  /** Projects named "Demo shop" deleted first. */
  replaced: number;
  counts: {
    events: number;
    knownUsers: number;
    spans: number;
    logs: number;
    metricPoints: number;
    serverErrors: number;
    replays: number;
    sourceMaps: number;
    heatmapRecords: number;
  } & MonitoringCounts;
}

/**
 * Deletes every project named "Demo shop", as the dashboard deletes a
 * project, and returns how many. Its ClickHouse rows and files are the
 * worker's to delete; they are deleted here too when no other project's
 * deletion is waiting, so a rerun does not leave them for a worker that
 * may not be running.
 */
export async function removeDemo(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  store: ObjectStore | null,
): Promise<number> {
  const old = await db
    .selectFrom("projects")
    .select("id")
    .where("name", "=", DEMO_PROJECT_NAME)
    .execute();
  for (const project of old) await deleteProject(db, project.id);
  if (old.length === 0) return 0;
  const ours = new Set(old.map((project) => project.id));
  const waiting = await db.selectFrom("project_deletions").select("project_id").execute();
  if (waiting.every((deletion) => ours.has(deletion.project_id))) {
    await purgeDeletedProjects(db, clickhouse, store);
  }
  return old.length;
}

/** Events in ClickHouse, each with its own arrival time, as storeEvents writes them. */
async function storeArrived(
  clickhouse: ClickHouseClient,
  projectId: string,
  events: readonly Arrived[],
) {
  for (let start = 0; start < events.length; start += BATCH) {
    await insertRows(
      clickhouse,
      "events",
      events
        .slice(start, start + BATCH)
        .map(({ event, receivedAt }) => toClickHouse(toRow(projectId, event, receivedAt))),
    );
  }
}

/** A server's exceptions, arrived two seconds after they happened: servers' clocks are trusted. */
const arrived = (errors: NewEvent[]): Arrived[] =>
  errors.map((event) => ({ event, receivedAt: new Date(event.occurredAt.getTime() + 2000) }));

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A number in a source map's base64 VLQ. */
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let text = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    text += BASE64[digit];
  } while (rest > 0);
  return text;
}

const SUMMARY_SOURCE = `import { formatMoney } from "./money";
import type { Cart } from "./types";

export function orderTotal(cart: Cart): string {
  const shipping = cart.shipping.price;
  return formatMoney(cart.subtotal + shipping);
}

export function renderSummary(cart: Cart): string {
  const total = orderTotal(cart);
  return \`Total: \${total}\`;
}
`;
const PAGE_SOURCE = `import type { Cart } from "./types";
import { renderSummary } from "./summary";

export function onContinue(event: Event, cart: Cart): void {
  event.preventDefault();
  document.querySelector("#summary")!.textContent = renderSummary(cart);
}
`;

/**
 * The source map of the minified checkout bundle (MINIFIED in
 * seed-site.ts): each statement back to its line in src/checkout/, with
 * the original code, as a bundler writes one.
 */
export function checkoutSourceMap(file: string): string {
  const sources = [SUMMARY_SOURCE, PAGE_SOURCE];
  const names = ["orderTotal", "cart", "renderSummary", "onContinue", "event"];
  /** [generated text, source, its text there, name] in the order they appear. */
  const anchors: [string, number, string, string | null][] = [
    ["function a(t)", 0, "export function orderTotal", "orderTotal"],
    ["t.shipping.price", 0, "cart.shipping.price", "cart"],
    ["return r(", 0, "return formatMoney(", null],
    ["function o(t)", 0, "export function renderSummary", "renderSummary"],
    ["a(t);", 0, "orderTotal(cart);", "orderTotal"],
    ['return"Total', 0, "return `Total", null],
    ["function s(t,n)", 1, "export function onContinue", "onContinue"],
    ["t.preventDefault()", 1, "event.preventDefault()", "event"],
    ['document.querySelector("#summary")', 1, 'document.querySelector("#summary")', null],
    ["o(n)}", 1, "renderSummary(cart);", "renderSummary"],
  ];
  const previous = { column: 0, source: 0, line: 0, sourceColumn: 0, name: 0 };
  const segments = anchors.map(([generated, source, original, name]) => {
    const column = MINIFIED.indexOf(generated);
    const text = sources[source] ?? "";
    const offset = text.indexOf(original);
    if (column === -1 || offset === -1)
      throw new Error(`The source map's anchor is missing: ${generated}`);
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    const sourceColumn = offset - (before.lastIndexOf("\n") + 1);
    let segment =
      vlq(column - previous.column) +
      vlq(source - previous.source) +
      vlq(line - previous.line) +
      vlq(sourceColumn - previous.sourceColumn);
    if (name !== null) {
      const index = names.indexOf(name);
      segment += vlq(index - previous.name);
      previous.name = index;
    }
    Object.assign(previous, { column, source, line, sourceColumn });
    return segment;
  });
  return JSON.stringify({
    version: 3,
    file: file.slice(file.lastIndexOf("/") + 1),
    sources: [
      "webpack://demo-shop/./src/checkout/summary.ts",
      "webpack://demo-shop/./src/checkout/page.ts",
    ],
    sourcesContent: sources,
    names,
    mappings: segments.join(","),
  });
}

/** The replay recording every replay here reuses: a real capture through the tracker's privacy filter. */
function readRecording(): { v: 1; events: { type: number; timestamp: number; data?: unknown }[] } {
  return JSON.parse(
    readFileSync(new URL("../tests/fixtures/replay-recording.json", import.meta.url), "utf8"),
  );
}

/**
 * Replaces the "Demo shop" project with a new one full of demo data, and
 * returns what it made.
 */
export async function seedDemo(options: SeedOptions): Promise<SeedResult> {
  const { db, clickhouse, store } = options;
  const now = options.now ?? new Date();
  const log = options.log ?? (() => undefined);
  const rng = seededRandom(SEED);
  const reader: Reader = { client: clickhouse };

  const replaced = await removeDemo(db, clickhouse, store);
  if (replaced > 0) log(`Deleted the previous "${DEMO_PROJECT_NAME}" project.`);
  const project = await createProject(db, {
    name: DEMO_PROJECT_NAME,
    allowedHostnames: [SITE_HOST, `www.${SITE_HOST}`, STAGING_HOST],
  });
  const projectId = project.id;
  await updateProject(db, projectId, {
    replayMode: store === null ? "off" : "errors",
    heatmaps: true,
  });

  // Goals and saved funnels: the signup flow and the shop's.
  const mainGoal = await createGoal(db, projectId, "Signed up", {
    type: "event",
    name: "signed_up",
  });
  await createGoal(db, projectId, "Completed checkout", {
    type: "event",
    name: "checkout_completed",
  });
  await createGoal(db, projectId, "Viewed pricing", { type: "page", path: "/pricing" });
  await createGoal(db, projectId, "Signed up for Team", {
    type: "event",
    name: "signed_up",
    filter: { key: "plan", value: "team" },
  });
  const steps = funnelStepsOf([
    { type: "page", path: "/pricing" },
    { type: "event", name: "signup_started" },
    { type: "event", name: "signed_up" },
    { type: "event", name: "project_created" },
  ]);
  const cartSteps = funnelStepsOf([
    { type: "event", name: "added_to_cart" },
    { type: "event", name: "checkout_started" },
    { type: "event", name: "checkout_completed" },
  ]);
  if (steps === null || cartSteps === null)
    throw new Error("The demo funnels' steps are not valid");
  await createSavedFunnel(db, projectId, {
    name: "Pricing to first project",
    steps,
    count: "visitors",
    window: 86_400,
  });
  await createSavedFunnel(db, projectId, {
    name: "Cart to purchase",
    steps: cartSteps,
    count: "visitors",
    window: 3600,
  });

  // The browsers' events.
  const { timeZone } = await readInstanceSettings(db);
  const site = buildSite(rng, projectId, timeZone, now);
  const withReplays = store === null ? [] : site.replayErrors.slice(-REPLAYS);
  for (const error of withReplays) {
    if (error.error !== undefined) error.error.replayId = rng.uuid();
  }
  await storeArrived(clickhouse, projectId, site.events);
  log(`Stored ${site.events.length.toLocaleString("en")} browser events.`);

  // Heatmaps of the shop's main pages, from those pageviews (seed-heatmaps.ts).
  const heatmaps = buildHeatmaps(seededRandom(HEATMAP_SEED), site.events, now);
  for (let start = 0; start < heatmaps.length; start += BATCH) {
    await storeHeatmapRecords(clickhouse, projectId, heatmaps.slice(start, start + BATCH), {
      receivedAt: now,
    });
  }
  log(`Stored ${heatmaps.length.toLocaleString("en")} heatmap clicks and scroll depths.`);

  // The servers' traces, logs, and metrics, through the OTLP normalizers.
  const userIds = [...new Set(site.events.flatMap(({ event }) => event.userId ?? []))];
  const telemetry = buildTelemetry(rng, now, userIds);
  const context = {
    projectId,
    receivedAtNs: BigInt(now.getTime()) * 1_000_000n,
    retentionDays: options.telemetryRetentionDays,
  };
  let spans = 0;
  let aiCalls = 0;
  let logs = 0;
  let metricPoints = 0;
  const serverErrors: Arrived[] = [];
  const refused = (message: string) => {
    if (message !== "") log(`Telemetry refused by the normalizer: ${message}`);
  };
  for (const request of telemetry.traces) {
    const outcome = normalizeTraces(request, context);
    refused(outcome.message);
    const ai = aiCallsOf(outcome.rows);
    await insertTelemetry(clickhouse, { spans: outcome.rows, ai_calls: ai });
    spans += outcome.rows.length;
    aiCalls += ai.length;
    serverErrors.push(...arrived(outcome.errors));
  }
  for (const request of telemetry.logs) {
    const outcome = normalizeLogs(request, context);
    refused(outcome.message);
    await insertTelemetry(clickhouse, { logs: outcome.rows });
    logs += outcome.rows.length;
    serverErrors.push(...arrived(outcome.errors));
  }
  for (const request of telemetry.metrics) {
    const outcome = normalizeMetrics(request, context);
    refused(outcome.message);
    await insertTelemetry(clickhouse, {
      metric_points: outcome.points,
      metric_histograms: outcome.histograms,
    });
    metricPoints += outcome.points.length + outcome.histograms.length;
  }
  await storeArrived(clickhouse, projectId, serverErrors);
  log(
    `Stored ${spans.toLocaleString("en")} spans (${aiCalls.toLocaleString("en")} AI calls), ${logs.toLocaleString("en")} log records, ${metricPoints.toLocaleString("en")} metric points, and ${serverErrors.length} server exceptions.`,
  );

  // When the latest event happened, as collection records it.
  const latest = site.events.at(-1);
  if (latest !== undefined) await new LastEventRecorder(db).record(projectId, [latest.event]);

  // The checkout bundles' source maps, as `PUT /api/source-maps` stores them.
  let sourceMaps = 0;
  if (store !== null) {
    for (const [release, path] of Object.entries(BUNDLES)) {
      const map = checkoutSourceMap(path);
      if (checkSourceMap(map) === null)
        throw new Error("The demo source map is not one the API takes");
      const stored = await storeSourceMap(
        { db, store, limitBytes: options.sourceMapLimitBytes },
        { id: projectId },
        release,
        path,
        map,
      );
      if ("refused" in stored) log(`The source map for ${release} was refused: ${stored.refused}.`);
      else sourceMaps += 1;
    }
  }

  // Resolutions: the search error a month ago (resolved for good), the
  // order list's error, which the current release brought back.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const regression = {
    // Fingerprints leave the bundles' content hashes out: one group in both releases.
    fingerprint: fingerprint(ERRORS.orderDate(RELEASES.previous)),
    resolvedAt: new Date(today - 14 * DAY_MS + 16 * 3_600_000),
  };
  const searchFingerprint = fingerprint(ERRORS.searchJson());
  await db
    .insertInto("error_resolutions")
    .values([
      {
        project_id: projectId,
        fingerprint: searchFingerprint,
        resolved_at: new Date(today - 17 * DAY_MS + 11 * 3_600_000),
        resolved_by: null,
      },
      {
        project_id: projectId,
        fingerprint: regression.fingerprint,
        resolved_at: regression.resolvedAt,
        resolved_by: null,
      },
    ])
    .execute();

  // Session replays of the latest checkout errors, through the replay
  // pipeline: a chunk as the browser sends it, joined and linked to its
  // error as the worker does.
  let replays = 0;
  if (store !== null && withReplays.length > 0) {
    const recording = readRecording();
    const marker =
      recording.events.find((item) => item.type === 5)?.timestamp ??
      recording.events.at(-1)?.timestamp ??
      0;
    for (const error of withReplays) {
      const replayId = error.error?.replayId;
      if (replayId === undefined) continue;
      // The recording moved in time, so its error mark is this error.
      const shift = error.occurredAt.getTime() - marker;
      const events = recording.events.map((item) => ({
        ...item,
        timestamp: item.timestamp + shift,
      }));
      const lastAt = Math.max(...events.map((item) => item.timestamp));
      const outcome = await storeChunk(
        db,
        { id: projectId },
        {
          replayId,
          seq: 0,
          last: true,
          cut: false,
          data: gzipSync(JSON.stringify({ v: 1, events })),
          // Recorded 10 seconds more after the error, then sent.
          receivedAt: new Date(lastAt + 10_500),
        },
        options.replayLimitBytes,
      );
      if (outcome !== "stored") log(`A replay was not stored: ${outcome}.`);
    }
    replays = (await joinReplays(db, store, { now, onlyProjectId: projectId })).joined;
    // Now by PostgreSQL's clock, not the seed's start or this machine's: the
    // replays' rows were made since, due at once (next_link_at defaults to
    // the database's now()). A database in a VM whose clock runs a few
    // milliseconds ahead would leave the latest replays not yet due, and so
    // never linked to their errors.
    const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
    await linkReplays(db, reader, {
      now: rows[0]?.now ?? new Date(),
      onlyProjectId: projectId,
    });
  }

  // Checks and alerts, played through the worker's steps.
  const channelId = await demoChannel(db, now);
  const monitoring = await seedMonitoring({
    db,
    clickhouse,
    publicUrl: options.publicUrl,
    projectId,
    channelId,
    rng,
    now,
    regression,
    spikeAt: new Date(today - (RELEASE_DAYS_AGO - 1) * DAY_MS + 14 * 3_600_000),
  });

  // The overview's business figures start with signups.
  if ("goal" in mainGoal) await updateProject(db, projectId, { mainGoalId: mainGoal.goal.id });

  return {
    projectId,
    replaced,
    counts: {
      events: site.events.length + serverErrors.length,
      knownUsers: site.users,
      spans,
      logs,
      metricPoints,
      serverErrors: serverErrors.length,
      replays,
      sourceMaps,
      heatmapRecords: heatmaps.length,
      ...monitoring,
    },
  };
}

/**
 * The instance's channel the demo's rules send to: an email list whose one
 * address cannot receive mail, so nothing reaches anyone, with or without
 * SMTP. Added on the first run, reused after.
 */
async function demoChannel(db: Kysely<Database>, now: Date): Promise<string> {
  const existing = (await listChannels(db)).find((channel) => channel.name === DEMO_CHANNEL_NAME);
  if (existing !== undefined) return existing.id;
  const values = channelValuesOf({
    kind: "email",
    name: DEMO_CHANNEL_NAME,
    addresses: [DEMO_CHANNEL_ADDRESS],
  });
  if ("error" in values) throw new Error(`The demo channel: ${values.message}`);
  const created = await createChannel(db, values, now);
  if (!("channel" in created)) {
    throw new Error(
      "The instance has as many notification channels as it may: delete one to run the seed.",
    );
  }
  return created.channel.id;
}
