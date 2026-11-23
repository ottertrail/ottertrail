import type { FastifyError, FastifyPluginCallback, FastifyReply } from "fastify";

import type { IngestActivity, IngestOutcome } from "../activity/activity.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "../collection/environment.ts";
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

/** Records per batch: a page sends its clicks and its scroll depth together. */
export const MAX_RECORDS_PER_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;
/** The structural path of a click's element: at most 24 steps and 512 characters. */
export const MAX_ELEMENT_STEPS = 24;
export const MAX_ELEMENT_LENGTH = 512;
/** A site's own name for an element (data-ottertrail-name). */
export const MAX_LABEL_LENGTH = 64;
/** The largest viewport side and page height taken, in CSS pixels. */
export const MAX_VIEWPORT_PX = 16_384;
export const MAX_PAGE_HEIGHT_PX = 1_000_000;
/** A pageview's clicks past the 100 h.js sends, counted on its scroll record. */
export const MAX_DROPPED = 65_535;

/** Requests per client IP address, before the body is read: as for events. */
export const DEFAULT_HEATMAP_IP_LIMIT: RateLimit = { capacity: 120, refillPerSecond: 2 };
/**
 * Records per client address (clientKey): a pageview sends at most 100
 * clicks and one scroll depth, so bursts of 400, then 40 a second.
 */
export const DEFAULT_HEATMAP_IP_RECORD_LIMIT: RateLimit = { capacity: 400, refillPerSecond: 40 };
/**
 * Records per project and per instance, apart from events' budgets, so
 * heatmaps never crowd events out: bursts of 2,000, then 100 a second for
 * a project; three projects' worth for the instance. Provisional, until
 * measured on real sites.
 */
export const DEFAULT_HEATMAP_PROJECT_LIMIT: RateLimit = { capacity: 2_000, refillPerSecond: 100 };
export const DEFAULT_HEATMAP_INSTANCE_LIMIT: RateLimit = { capacity: 6_000, refillPerSecond: 300 };

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const MAX_TIMESTAMP = 8_640_000_000_000_000;

/**
 * One step: a standard tag name (tags.ts), or "x" for any other, and its
 * place among siblings of that tag after the first.
 */
const STEP = `(${["x", ...HEATMAP_TAGS].join("|")})(:[1-9][0-9]{0,3})?`;
/** Steps from the labelled ancestor or body, joined by ">"; "*>" first when cut at 24. */
export const ELEMENT_PATTERN = `^(\\*>)?${STEP}(>${STEP}){0,${MAX_ELEMENT_STEPS - 1}}$`;
/** Letters, digits, spaces, and . _ : / -, starting with a letter or digit. */
export const LABEL_PATTERN = `^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,${MAX_LABEL_LENGTH - 1}}$`;

interface IncomingPage {
  url: string;
  /** The page's referrer, for the referrer spam check only: never stored. */
  referrer?: string;
}

interface IncomingRecord {
  id: string;
  type: "click" | "scroll";
  /** A click's time; a scroll row's, when its pageview started. Sender's clock, to the minute. */
  at: number;
  /** Its page: an index into the batch's pages. */
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
  /** The pages of the batch's records, each once. */
  pages: IncomingPage[];
  records: IncomingRecord[];
}

const fraction = { type: "number", minimum: 0, maximum: 1 } as const;
const pixels = (maximum: number) => ({ type: "integer", minimum: 1, maximum }) as const;

// Unknown fields are removed, as for events: a newer h.js still reaches an older API.
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

const storedResponseSchema = {
  type: "object",
  required: ["stored", "tooOld", "bots", "blocked", "spam"],
  additionalProperties: false,
  properties: {
    // Records written; a retry counts again here, and once in reports.
    stored: { type: "integer" },
    tooOld: { type: "integer" },
    bots: { type: "integer" },
    blocked: { type: "integer" },
    spam: { type: "integer" },
  },
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

/** What is wrong with one record beyond its schema, or null. */
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
 * POST /api/heatmaps: a page's clicks and scroll depth (docs/web-analytics.md,
 * "Heatmaps"), as the tracker's h.js sends them, as text/plain JSON.
 *
 * Checked as events are, cheapest first (collection/routes.ts):
 *
 * 1. Requests per client IP, before the body is read.
 * 2. Body size, content type, and the JSON schema, which caps every field.
 * 3. Records per client address.
 * 4. The public key (cached).
 * 5. The Origin header against the project's allowed hostnames.
 * 6. The project's heatmaps setting: off answers 403 `heatmaps_off`, and
 *    h.js stops for the rest of the page load.
 * 7. Accepted and not stored (202, counted): the project's blocked
 *    addresses, bots and data centers, referrer spam. Before the budget.
 * 8. Heatmaps' own budget per project and instance, apart from events'.
 * 9. Each record's rules, page hostname, and clock correction.
 * 10. One insert into ClickHouse; 202 only once it has written the rows,
 *     503 while it cannot (the budget given back).
 *
 * Nothing about the visitor is stored: no visitor ID, no address, no user
 * agent, no referrer.
 */
export const heatmapCollectionRoutes: FastifyPluginCallback<{
  clickhouse: ClickHouseClient;
  projects: ProjectKeyCache;
  /** Counts for the Activity tab (activity/activity.ts). */
  activity: IngestActivity;
  ipLimit?: RateLimit;
  ipRecordLimit?: RateLimit;
  projectLimit?: RateLimit;
  instanceLimit?: RateLimit;
  isDataCenter?: IsDataCenter;
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
  if (budget.capacity < MAX_RECORDS_PER_BATCH) {
    done(new Error(`The heatmap budgets must allow a full batch of ${MAX_RECORDS_PER_BATCH}`));
    return;
  }

  parseTextPlainAsJson(app, MAX_BODY_BYTES);

  // As for events: the page may read every answer, so h.js knows whether
  // sending again can help (collection/routes.ts).
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
      schema: { body: batchSchema, response: { 202: storedResponseSchema } },
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(request.ip);
        return result.allowed ? undefined : tooManyRequests(reply, result.retryAfterSeconds);
      },
    },
    async (request, reply) => {
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
      // Known from here: what becomes of the batch is counted.
      const projectId = project.id;
      const count = (outcome: IngestOutcome, items = 0) => {
        activity.add(projectId, "heatmaps", outcome, items);
      };
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

      const none = { stored: 0, tooOld: 0, bots: 0, blocked: 0, spam: 0 };
      if (isBlockedAddress(project.blocked, request.ip)) {
        count("filtered_spam", records.length);
        return reply.code(202).send({ ...none, blocked: records.length });
      }
      const userAgent = request.headers["user-agent"];
      if (isBot(userAgent) || (project.ignoreDataCenters && isDataCenter(request.ip))) {
        count("filtered_bot", records.length);
        return reply.code(202).send({ ...none, bots: records.length });
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
        return reply.code(202).send({ ...none, spam: records.length });
      }

      const spent = budget.take(project.id, records.length);
      if (!spent.allowed) {
        count(spent.limit === "instance" ? "refused_volume" : "refused_rate_limited");
        return tooManyRequests(reply, spent.retryAfterSeconds);
      }

      const environment = environmentOf(request.body.environment);
      // Each page once: its path, on an allowed hostname.
      const paths: string[] = [];
      for (const [index, incoming] of pages.entries()) {
        const page = parsePageUrl(incoming.url);
        if (page === null || !isAllowedHostname(page.hostname, project.allowedHostnames)) {
          budget.refund(project.id, records.length);
          count(page === null ? "refused_invalid" : "refused_origin");
          return page === null
            ? reply
                .code(400)
                .send(problem("invalid_request", `pages[${index}].url is not a valid http(s) URL.`))
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
          });
        }
      } catch (error) {
        // Not the sender's doing: the budget back, so its retry is not refused for it.
        budget.refund(project.id, accepted.length);
        request.log.error({ err: error }, "could not store heatmap data");
        count("refused_unavailable");
        return storageUnavailable(reply);
      }
      // Per record: those stored, and those too old to store.
      if (accepted.length > 0) count("accepted", accepted.length);
      if (tooOld > 0) count("filtered_too_old", tooOld);
      return reply.code(202).send({ ...none, stored: accepted.length, tooOld });
    },
  );

  done();
};
