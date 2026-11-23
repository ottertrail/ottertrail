import type { FastifyError, FastifyPluginCallback, FastifyReply } from "fastify";

import type { IngestActivity, IngestOutcome } from "../activity/activity.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { INSERT_WAIT_SECONDS, projectTooBusy, tooBusy } from "../collection/busy.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "../collection/environment.ts";
import { InFlight } from "../collection/in-flight.ts";
import { parseTextPlainAsJson } from "../collection/json-body.ts";
import {
  correctClock,
  isAllowedHostname,
  isStorableText,
  originHostname,
  parsePageUrl,
} from "../collection/normalize.ts";
import { type ProjectKeyCache, PUBLIC_KEY_PATTERN } from "../collection/project-keys.ts";
import {
  ClientRateLimiter,
  EventBudget,
  type RateLimit,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import { type IsDataCenter, noDataCenters } from "../enrichment/data-centers.ts";
import { isReferrerSpam } from "../enrichment/referrer-spam.ts";
import { isBot } from "../enrichment/user-agent.ts";
import { isBlockedAddress } from "../projects/blocked-addresses.ts";
import {
  DEVICES,
  deviceOf,
  type HeatmapDevice,
  type NewHeatmapRecord,
  storeHeatmapRecords,
} from "./store.ts";
import { HEATMAP_TAGS } from "./tags.ts";

/** Batches combine clicks and scroll depth. */
export const MAX_RECORDS_PER_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;
/** Caps element paths at 24 steps and 512 characters. */
export const MAX_ELEMENT_STEPS = 24;
export const MAX_ELEMENT_LENGTH = 512;
/** data-ottertrail-name label limit. */
export const MAX_LABEL_LENGTH = 64;
/** CSS pixels for viewport sides and page height. */
export const MAX_VIEWPORT_PX = 16_384;
export const MAX_PAGE_HEIGHT_PX = 1_000_000;
/** Scroll records count clicks beyond h.js's 100-click cap. */
export const MAX_DROPPED = 65_535;

export const DEFAULT_HEATMAP_IP_LIMIT: RateLimit = { capacity: 120, refillPerSecond: 2 };
/**
 * Per address (clientKey): burst 400, then 40 records/second. A pageview sends at most 100 clicks
 * and one scroll.
 */
export const DEFAULT_HEATMAP_IP_RECORD_LIMIT: RateLimit = { capacity: 400, refillPerSecond: 40 };
/**
 * Separate budgets protect event ingestion. Project: burst 2,000, then 100/second. Instance: three
 * projects' worth. Provisional pending real-site measurements.
 */
export const DEFAULT_HEATMAP_PROJECT_LIMIT: RateLimit = { capacity: 2_000, refillPerSecond: 100 };
export const DEFAULT_HEATMAP_INSTANCE_LIMIT: RateLimit = { capacity: 6_000, refillPerSecond: 300 };
/** Shares concurrency handling with collection/busy.ts. */
export const DEFAULT_HEATMAP_MAX_IN_FLIGHT = 64;
export const DEFAULT_HEATMAP_MAX_IN_FLIGHT_PER_PROJECT = 16;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const MAX_TIMESTAMP = 8_640_000_000_000_000;

/** Unknown tags become x; repeated sibling tags carry their position. */
const STEP = `(${["x", ...HEATMAP_TAGS].join("|")})(:[1-9][0-9]{0,3})?`;
/** Paths start at the labeled ancestor or body; *> marks truncation at 24 steps. */
export const ELEMENT_PATTERN = `^(\\*>)?${STEP}(>${STEP}){0,${MAX_ELEMENT_STEPS - 1}}$`;
export const LABEL_PATTERN = `^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,${MAX_LABEL_LENGTH - 1}}$`;

interface IncomingPage {
  url: string;
  /** Used only for spam checks; never stored. */
  referrer?: string;
}

interface IncomingRecord {
  id: string;
  type: "click" | "scroll";
  /** Sender-clock minutes: click time or scroll pageview start. */
  at: number;
  /** Index into batch.pages. */
  page: number;
  label?: string;
  element?: string;
  x?: number;
  y?: number;
  rage?: boolean;
  dead?: boolean;
  depth?: number;
  fold?: number;
  dropped?: number;
  vw: number;
  vh: number;
  ph: number;
  device: HeatmapDevice;
}

interface HeatmapBatch {
  v: 1;
  key: string;
  sentAt: number;
  environment?: string;
  release?: string;
  pages: IncomingPage[];
  records: IncomingRecord[];
}

const fraction = { type: "number", minimum: 0, maximum: 1 } as const;
const pixels = (maximum: number) => ({ type: "integer", minimum: 1, maximum }) as const;

// Drop unknown fields so newer h.js versions work with older APIs.
const batchSchema = {
  type: "object",
  required: ["v", "key", "sentAt", "pages", "records"],
  additionalProperties: false,
  properties: {
    v: { const: 1 },
    key: { type: "string", pattern: PUBLIC_KEY_PATTERN },
    sentAt: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
    environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
    release: { type: "string", maxLength: 200, pattern: RELEASE_PATTERN },
    pages: {
      type: "array",
      minItems: 1,
      maxItems: MAX_RECORDS_PER_BATCH,
      items: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", minLength: 1, maxLength: 8192 },
          referrer: { type: "string", maxLength: 8192 },
        },
      },
    },
    records: {
      type: "array",
      minItems: 1,
      maxItems: MAX_RECORDS_PER_BATCH,
      items: {
        type: "object",
        required: ["id", "type", "at", "page", "vw", "vh", "ph", "device"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: UUID_PATTERN },
          type: { type: "string", enum: ["click", "scroll"] },
          at: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
          page: { type: "integer", minimum: 0, maximum: MAX_RECORDS_PER_BATCH - 1 },
          label: { type: "string", maxLength: MAX_LABEL_LENGTH, pattern: LABEL_PATTERN },
          element: { type: "string", maxLength: MAX_ELEMENT_LENGTH, pattern: ELEMENT_PATTERN },
          x: fraction,
          y: fraction,
          rage: { type: "boolean" },
          dead: { type: "boolean" },
          depth: fraction,
          fold: fraction,
          dropped: { type: "integer", minimum: 0, maximum: MAX_DROPPED },
          vw: pixels(MAX_VIEWPORT_PX),
          vh: pixels(MAX_VIEWPORT_PX),
          ph: pixels(MAX_PAGE_HEIGHT_PX),
          device: { type: "string", enum: DEVICES },
        },
      },
    },
  },
} as const;

/** All outcomes share 202, as with events (collection/routes.ts). */
const receivedResponseSchema = {
  type: "object",
  required: ["received"],
  additionalProperties: false,
  properties: { received: { type: "integer" } },
} as const;

const problem = (error: string, message: string) => ({ error, message });

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(problem("rate_limited", `Too many requests. Retry after ${retryAfterSeconds} seconds.`));
}

function storageUnavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "5")
    .send(problem("storage_unavailable", "The heatmap data was not stored. Retry later."));
}

function recordProblem(record: IncomingRecord): string | null {
  if (record.type === "click") {
    if (record.element === undefined || record.x === undefined || record.y === undefined) {
      return "is a click: it needs element, x, and y.";
    }
    if (record.depth !== undefined || record.fold !== undefined || record.dropped !== undefined) {
      return "is a click: depth, fold, and dropped are only for scroll records.";
    }
  } else {
    if (record.depth === undefined || record.fold === undefined) {
      return "is a scroll record: it needs depth and fold.";
    }
    if (
      record.element !== undefined ||
      record.label !== undefined ||
      record.x !== undefined ||
      record.y !== undefined ||
      record.rage !== undefined ||
      record.dead !== undefined
    ) {
      return "is a scroll record: element, label, x, y, rage, and dead are only for clicks.";
    }
  }
  if (record.device !== deviceOf(record.vw)) {
    return `has device "${record.device}", but a viewport ${record.vw} pixels wide is ${deviceOf(record.vw)}.`;
  }
  return null;
}

/**
 * Collects text/plain clicks and scroll depth from h.js (docs/web-analytics.md, "Heatmaps").
 * Validate cheapest checks first (collection/routes.ts): IP rate, body/schema, address record
 * rate, cached key, allowed Origin, project setting, filters, then budgets and per-record rules.
 * Filtering blocked addresses, bots, data centers, and referrer spam returns counted 202 before
 * spending budgets. heatmaps_off returns 403 and stops h.js for the page load.
 *
 * Return 202 only after ClickHouse writes; refund budgets on retryable 503. Store no visitor IDs,
 * addresses, user agents, or referrers.
 */
export const heatmapCollectionRoutes: FastifyPluginCallback<{
  clickhouse: ClickHouseClient;
  projects: ProjectKeyCache;
  /** Activity tab counts (activity/activity.ts). */
  activity: IngestActivity;
  ipLimit?: RateLimit;
  ipRecordLimit?: RateLimit;
  projectLimit?: RateLimit;
  instanceLimit?: RateLimit;
  isDataCenter?: IsDataCenter;
  maxInFlight?: number;
  maxInFlightPerProject?: number;
  now?: () => number;
}> = (app, options, done) => {
  const { clickhouse, projects, activity, isDataCenter = noDataCenters, now = Date.now } = options;
  const ipLimiter = new ClientRateLimiter(options.ipLimit ?? DEFAULT_HEATMAP_IP_LIMIT, { now });
  const ipRecordLimit = options.ipRecordLimit ?? DEFAULT_HEATMAP_IP_RECORD_LIMIT;
  const ipRecordLimiter = new ClientRateLimiter(ipRecordLimit, { now });
  const budget = new EventBudget(
    new TokenBucketLimiter(options.projectLimit ?? DEFAULT_HEATMAP_PROJECT_LIMIT, { now }),
    new TokenBucketLimiter(options.instanceLimit ?? DEFAULT_HEATMAP_INSTANCE_LIMIT, { now }),
  );
  // Acquire slots only after the body arrives.
  const inFlight = new InFlight(
    options.maxInFlight ?? DEFAULT_HEATMAP_MAX_IN_FLIGHT,
    options.maxInFlightPerProject ?? DEFAULT_HEATMAP_MAX_IN_FLIGHT_PER_PROJECT,
  );
  if (budget.capacity < MAX_RECORDS_PER_BATCH) {
    done(new Error(`The heatmap budgets must allow a full batch of ${MAX_RECORDS_PER_BATCH}`));
    return;
  }

  parseTextPlainAsJson(app, MAX_BODY_BYTES);

  // Expose all answers so h.js can decide whether to retry (collection/routes.ts).
  app.addHook("onSend", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      reply
        .header("access-control-allow-origin", origin)
        .header("access-control-expose-headers", "Retry-After")
        .header("vary", "Origin");
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined || error.statusCode === 400) {
      return reply.code(400).send(problem("invalid_request", error.message));
    }
    if (error.statusCode === 413) {
      return reply
        .code(413)
        .send(problem("payload_too_large", `The body is larger than ${MAX_BODY_BYTES} bytes.`));
    }
    if (error.statusCode === 415) {
      return reply
        .code(415)
        .send(
          problem("unsupported_media_type", "Send the batch as text/plain or application/json."),
        );
    }
    request.log.error({ err: error }, "unexpected error while collecting heatmap data");
    return reply.code(500).send(problem("internal_error", "Something went wrong."));
  });

  app.post<{ Body: HeatmapBatch }>(
    "/heatmaps",
    {
      bodyLimit: MAX_BODY_BYTES,
      schema: { body: batchSchema, response: { 202: receivedResponseSchema } },
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(request.ip);
        return result.allowed ? undefined : tooManyRequests(reply, result.retryAfterSeconds);
      },
      preHandler: async (request, reply) =>
        inFlight.take(request, reply) ? undefined : tooBusy(reply),
      onResponse: inFlight.finished,
      onRequestAbort: inFlight.finished,
    },
    async (request, reply) =>
      inFlight.run(request, async () => {
        const receivedAt = now();
        const { key, sentAt, pages, records } = request.body;

        const perClient = ipRecordLimiter.take(
          request.ip,
          Math.min(records.length, ipRecordLimit.capacity),
        );
        if (!perClient.allowed) return tooManyRequests(reply, perClient.retryAfterSeconds);

        let project;
        try {
          project = await projects.find(key);
        } catch (error) {
          request.log.error({ err: error }, "could not look up the project key");
          return storageUnavailable(reply);
        }
        if (project === null) {
          return reply.code(403).send(problem("unknown_key", "No project has this key."));
        }
        const projectId = project.id;
        const count = (outcome: IngestOutcome, items = 0) => {
          activity.add(projectId, "heatmaps", outcome, items);
        };
        if (!inFlight.takeForProject(request, projectId)) {
          count("refused_rate_limited");
          return projectTooBusy(reply);
        }
        const origin = request.headers.origin;
        if (origin !== undefined) {
          const hostname = originHostname(origin);
          if (hostname === null || !isAllowedHostname(hostname, project.allowedHostnames)) {
            count("refused_origin");
            return reply
              .code(403)
              .send(problem("origin_not_allowed", "This site may not send to this project."));
          }
        }
        if (!project.heatmaps) {
          count("refused_disabled");
          return reply
            .code(403)
            .send(problem("heatmaps_off", "The project does not take heatmap data."));
        }
        const { release } = request.body;
        if (release !== undefined && !isStorableText(release)) {
          count("refused_invalid");
          return reply
            .code(400)
            .send(problem("invalid_request", "release contains an unpaired surrogate."));
        }

        const received = { received: records.length };
        if (isBlockedAddress(project.blocked, request.ip)) {
          count("filtered_spam", records.length);
          return reply.code(202).send(received);
        }
        const userAgent = request.headers["user-agent"];
        if (isBot(userAgent) || (project.ignoreDataCenters && isDataCenter(request.ip))) {
          count("filtered_bot", records.length);
          return reply.code(202).send(received);
        }
        if (
          pages.some((page) =>
            isReferrerSpam(
              page.referrer,
              project.blockedReferrers,
              undefined,
              project.allowedHostnames,
            ),
          )
        ) {
          count("filtered_spam", records.length);
          return reply.code(202).send(received);
        }

        const spent = budget.take(project.id, records.length);
        if (!spent.allowed) {
          count(spent.limit === "instance" ? "refused_volume" : "refused_rate_limited");
          return tooManyRequests(reply, spent.retryAfterSeconds);
        }

        const environment = environmentOf(request.body.environment);
        const paths: string[] = [];
        for (const [index, incoming] of pages.entries()) {
          const page = parsePageUrl(incoming.url);
          if (page === null || !isAllowedHostname(page.hostname, project.allowedHostnames)) {
            budget.refund(project.id, records.length);
            count(page === null ? "refused_invalid" : "refused_origin");
            return page === null
              ? reply
                  .code(400)
                  .send(
                    problem("invalid_request", `pages[${index}].url is not a valid http(s) URL.`),
                  )
              : reply
                  .code(403)
                  .send(
                    problem(
                      "hostname_not_allowed",
                      `pages[${index}].url is not on an allowed hostname.`,
                    ),
                  );
          }
          paths.push(page.path);
        }
        const accepted: NewHeatmapRecord[] = [];
        let tooOld = 0;
        for (const [index, record] of records.entries()) {
          const refuse = (status: 400 | 403, code: string, message: string) => {
            budget.refund(project.id, records.length);
            count("refused_invalid");
            return reply.code(status).send(problem(code, `records[${index}] ${message}`));
          };
          const wrong = recordProblem(record);
          if (wrong !== null) return refuse(400, "invalid_request", wrong);
          const path = paths[record.page];
          if (path === undefined) {
            return refuse(400, "invalid_request", "page is not one of the batch's pages.");
          }
          const occurredAt = correctClock(record.at, sentAt, receivedAt);
          if (occurredAt === null) {
            tooOld += 1;
            continue;
          }
          accepted.push({
            recordId: record.id,
            kind: record.type,
            occurredAt,
            environment,
            release,
            path,
            device: record.device,
            label: record.label ?? "",
            element: record.element ?? "",
            x: record.x ?? 0,
            y: record.y ?? 0,
            viewportWidth: record.vw,
            viewportHeight: record.vh,
            pageHeight: record.ph,
            rage: record.rage === true,
            dead: record.dead === true,
            depth: record.depth ?? 0,
            fold: record.fold ?? 0,
            dropped: record.dropped ?? 0,
          });
        }
        if (tooOld > 0) budget.refund(project.id, tooOld);
        try {
          if (accepted.length > 0) {
            await storeHeatmapRecords(clickhouse, project.id, accepted, {
              receivedAt: new Date(receivedAt),
              waitSeconds: INSERT_WAIT_SECONDS,
            });
          }
        } catch (error) {
          // Refund server failures so retries retain their budget.
          budget.refund(project.id, accepted.length);
          request.log.error({ err: error }, "could not store heatmap data");
          count("refused_unavailable");
          return storageUnavailable(reply);
        }
        if (accepted.length > 0) count("accepted", accepted.length);
        if (tooOld > 0) count("filtered_too_old", tooOld);
        return reply.code(202).send(received);
      }),
  );

  done();
};
