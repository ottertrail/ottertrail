import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { AI_CALLS_TABLE } from "../clickhouse/migrations.ts";
import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { MAX_AI_LABEL_CHARS } from "./calls.ts";
import {
  type CustomPriceRow,
  MAX_CUSTOM_ROWS,
  MAX_PRICE_USD,
  MAX_ROWS_PER_MODEL,
  type PriceProblem,
  PRICE_DECIMALS,
  readCustomPrices,
  resetModel,
  setModelPrice,
  setPriceAs,
} from "./custom-prices.ts";
import { priceAt, priceBookOf, priceOf, type Rates } from "./prices.ts";
import { MAX_LISTED_MODELS } from "./report.ts";

/** Price changes per user, across the three change routes: 30, then one every 10 seconds. */
export const DEFAULT_AI_MODEL_CHANGE_LIMIT: RateLimit = { capacity: 30, refillPerSecond: 1 / 10 };

export const CALLS_DAYS = 30;
const DAY_MS = 86_400_000;

const problem = (error: string, message: string) => ({ error, message });

/** A provider or a model ID: what ai_calls can hold (ai/calls.ts), no control characters. */
const NAME = {
  type: "string",
  pattern: `^[^\\u0000-\\u001F\\u007F]{1,${MAX_AI_LABEL_CHARS}}$`,
};
const PRICE = { type: "number", minimum: 0, maximum: MAX_PRICE_USD };
const CACHE_PRICE = { type: ["number", "null"], minimum: 0, maximum: MAX_PRICE_USD };
/** A day, "YYYY-MM-DD", from 2000 on. */
const DAY = { type: "string", pattern: "^(2[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$" };

interface PriceBody {
  provider: string;
  model: string;
  /** The first day, in the instance's timezone, the price applies from; null: all calls. */
  effectiveFrom: string | null;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

interface PriceAsBody {
  provider: string;
  model: string;
  priceAs: { provider: string; model: string };
}

const keyOf = (name: string) => name.trim().toLowerCase();

const exactEnough = (value: number) => Number(value.toFixed(PRICE_DECIMALS)) === value;

const INVALID_PRICE = problem(
  "invalid_price",
  `Prices are US dollars per million tokens, from 0 to ${MAX_PRICE_USD.toLocaleString("en")}, with at most ${PRICE_DECIMALS} decimals.`,
);
const INVALID_NAME = problem("invalid_name", "Enter a provider and a model ID.");
const INVALID_DAY = problem("invalid_day", "Enter a date that exists, such as 2026-12-01.");

/** Reject impossible dates the pattern accepts, such as 2026-02-31. */
function realDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

interface ModelRow {
  model: string;
  provider: string;
  /** The bundled entry's name for it, if it has one. */
  label: string | null;
  /** Calls in the last CALLS_DAYS days, across the instance's projects; null when they could not be counted. */
  calls: number | null;
  /** What a call now costs, and where that price comes from; null: no price. */
  price: Rates | null;
  source: "built_in" | "custom" | "price_as" | null;
  /** With a custom source: the row that prices a call now, on this model or another ID of its entry. */
  current: {
    model: string;
    effectiveFrom: string | null;
    updatedAt: string;
    updatedBy: string | null;
  } | null;
  /**
   * The bundled entry whose IDs a price on this model covers: a price on
   * any of them covers every call of the entry, prefixes included; null:
   * a price covers only this model.
   */
  covers: { ids: string[]; prefixes: string[] } | null;
  /**
   * The bundled table's price, with the page it was read from, the day it
   * was checked there, and what it leaves out (a longer prompt's price).
   */
  builtIn: {
    label: string;
    checked: string;
    source: string;
    notes: string | null;
    rates: Rates;
  } | null;
  prices: {
    effectiveFrom: string | null;
    rates: Rates;
    updatedAt: string;
    updatedBy: string | null;
  }[];
  priceAs: { provider: string; model: string; updatedAt: string; updatedBy: string | null } | null;
}

const ratesOf = (rates: Rates): Rates => ({
  input: rates.input,
  output: rates.output,
  cacheRead: rates.cacheRead,
  cacheWrite: rates.cacheWrite,
});

/** Each model's calls over the period, across `projectIds`: at most MAX_LISTED_MODELS models. */
async function callsByModel(
  reader: Reader,
  projectIds: readonly string[],
  from: Date,
): Promise<Map<string, { provider: string; calls: number }>> {
  if (projectIds.length === 0) return new Map();
  const params = new QueryParams();
  const rows = await queryRows<{ model: string; provider: string; calls: string }>(
    reader,
    `SELECT lowerUTF8(model) AS model, lowerUTF8(topK(1)(provider)[1]) AS provider, count() AS calls
     FROM ${AI_CALLS_TABLE}
     WHERE project_id IN ${params.add(projectIds, "Array(UUID)")}
       AND timestamp >= ${params.time(from)} AND model != ''
     GROUP BY model
     ORDER BY calls DESC, model
     LIMIT ${MAX_LISTED_MODELS}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return new Map(
    rows.map((row) => [row.model, { provider: row.provider, calls: Number(row.calls) }]),
  );
}

const by = (row: CustomPriceRow) => row.updatedBy?.name ?? null;

function modelRows(
  custom: readonly CustomPriceRow[],
  /** null: the calls could not be counted (ClickHouse is down). */
  calls: ReadonlyMap<string, { provider: string; calls: number }> | null,
  now: Date,
): ModelRow[] {
  const book = priceBookOf(custom);
  const models = new Set<string>(calls?.keys());
  for (const entry of book.bundled) {
    const [first] = entry.ids;
    if (first !== undefined) models.add(first);
  }
  for (const row of custom) models.add(row.model);
  const rows = [...models].map((model): ModelRow => {
    const own = custom.filter((row) => row.model === model);
    const entry = priceOf(model, book.bundled);
    const current = priceAt(book, model, now);
    const asRow = own.find((row) => row.priceAs !== null);
    const currentRow = custom.find((row) => row === current?.row);
    const coveredBy = book.bundled.find((item) => item.ids.includes(model));
    return {
      model,
      provider: own[0]?.provider ?? calls?.get(model)?.provider ?? entry?.provider ?? "",
      label: entry?.label ?? null,
      calls: calls === null ? null : (calls.get(model)?.calls ?? 0),
      price: current === null ? null : ratesOf(current.rates),
      source: current?.source ?? null,
      current:
        currentRow === undefined
          ? null
          : {
              model: currentRow.model,
              effectiveFrom: currentRow.effectiveFrom?.toISOString() ?? null,
              updatedAt: currentRow.updatedAt.toISOString(),
              updatedBy: by(currentRow),
            },
      covers:
        coveredBy === undefined
          ? null
          : { ids: [...coveredBy.ids], prefixes: [...(coveredBy.prefixes ?? [])] },
      builtIn:
        entry === null
          ? null
          : {
              label: entry.label,
              checked: entry.checked,
              source: entry.source,
              notes: entry.notes ?? null,
              rates: ratesOf(entry),
            },
      prices: own.flatMap((row) =>
        row.rates === null
          ? []
          : [
              {
                effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
                rates: ratesOf(row.rates),
                updatedAt: row.updatedAt.toISOString(),
                updatedBy: by(row),
              },
            ],
      ),
      priceAs:
        asRow?.priceAs === null || asRow?.priceAs === undefined
          ? null
          : {
              ...asRow.priceAs,
              updatedAt: asRow.updatedAt.toISOString(),
              updatedBy: by(asRow),
            },
    };
  });
  return rows.toSorted((a, b) => (b.calls ?? 0) - (a.calls ?? 0) || a.model.localeCompare(b.model));
}

function refusalOf(refusal: PriceProblem): [number, object] {
  if (refusal.problem === "others_priced_as_this") {
    return [
      409,
      {
        ...problem(
          "others_priced_as_this",
          `Priced as this model: ${refusal.models.join(", ")}. Reset those first.`,
        ),
        models: refusal.models,
      },
    ];
  }
  switch (refusal.problem) {
    case "too_many_prices":
      return [
        409,
        problem(
          "too_many_prices",
          `The instance has its limit of ${MAX_CUSTOM_ROWS} custom prices. Reset models it no longer needs.`,
        ),
      ];
    case "too_many_model_prices":
      return [
        409,
        problem(
          "too_many_model_prices",
          `A model has at most ${MAX_ROWS_PER_MODEL} prices. Set one for all calls to replace them.`,
        ),
      ];
    case "target_has_no_price":
      return [
        400,
        problem(
          "target_has_no_price",
          "That model has no price. Choose a model with one, or set a price.",
        ),
      ];
    default:
      return [
        409,
        problem(
          "target_is_priced_as",
          "That model is priced as another itself. Choose a model with its own price.",
        ),
      ];
  }
}

function refuse(reply: FastifyReply, refusal: PriceProblem) {
  const [status, body] = refusalOf(refusal);
  return reply.code(status).send(body);
}

/**
 * AI price settings for the owner and admins (docs/ai-usage.md, "Prices"; docs/access.md).
 * Changes require the dashboard's Origin, share a per-user limit, and invalidate cached AI cost
 * hours. Prices use US dollars.
 */
export const aiModelRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  trustedOrigins: readonly string[];
  now?: () => Date;
  limiter?: DashboardQueryLimiter;
  changeLimit?: RateLimit;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    trustedOrigins,
    now = () => new Date(),
    limiter = new DashboardQueryLimiter(),
    changeLimit,
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const canManage = requirePermission(db, "projects");
  const changes = new TokenBucketLimiter(changeLimit ?? DEFAULT_AI_MODEL_CHANGE_LIMIT);
  app.setErrorHandler(clickHouseErrorHandler);

  function allowed(request: FastifyRequest, reply: FastifyReply): boolean {
    const taken = changes.take(signedInUser(request).id);
    if (taken.allowed) return true;
    void reply
      .code(429)
      .header("retry-after", String(taken.retryAfterSeconds))
      .send(
        problem(
          "rate_limited",
          `Too many price changes. Try again in ${taken.retryAfterSeconds} seconds.`,
        ),
      );
    return false;
  }

  app.get("/settings/ai-models", { preHandler: [signedIn, canManage] }, async (request, reply) => {
    const moment = now();
    const [projects, custom] = await Promise.all([
      db.selectFrom("projects").select("id").execute(),
      readCustomPrices(db),
    ]);
    // Keep prices editable when ClickHouse cannot supply call counts.
    let calls: Map<string, { provider: string; calls: number }> | null = null;
    try {
      calls = await callsByModel(
        dashboardReader(clickhouse, limiter, reply),
        projects.map((project) => project.id),
        new Date(moment.getTime() - CALLS_DAYS * DAY_MS),
      );
    } catch (error) {
      request.log.warn({ err: error }, "the AI models' calls could not be counted");
    }
    return {
      now: moment.toISOString(),
      callsDays: CALLS_DAYS,
      callsCounted: calls !== null,
      limits: { maxPrice: MAX_PRICE_USD, decimals: PRICE_DECIMALS },
      models: modelRows(custom, calls, moment),
    };
  });

  app.put<{ Body: PriceBody }>(
    "/settings/ai-models/price",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "provider",
            "model",
            "effectiveFrom",
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
          ],
          properties: {
            provider: NAME,
            model: NAME,
            effectiveFrom: { anyOf: [DAY, { type: "null" }] },
            input: PRICE,
            output: PRICE,
            cacheRead: CACHE_PRICE,
            cacheWrite: CACHE_PRICE,
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const provider = keyOf(body.provider);
      const model = keyOf(body.model);
      if (provider === "" || model === "") return reply.code(400).send(INVALID_NAME);
      const prices = [body.input, body.output, body.cacheRead, body.cacheWrite];
      if (prices.some((price) => price !== null && !exactEnough(price))) {
        return reply.code(400).send(INVALID_PRICE);
      }
      if (body.effectiveFrom !== null && !realDay(body.effectiveFrom)) {
        return reply.code(400).send(INVALID_DAY);
      }
      if (!allowed(request, reply)) return reply;
      const { timeZone } = await readInstanceSettings(db);
      const effectiveFrom =
        body.effectiveFrom === null
          ? null
          : (await localDays(db, body.effectiveFrom, body.effectiveFrom, timeZone)).from;
      const refused = await setModelPrice(db, {
        provider,
        model,
        effectiveFrom,
        rates: {
          input: body.input,
          output: body.output,
          cacheRead: body.cacheRead,
          cacheWrite: body.cacheWrite,
        },
        userId: signedInUser(request).id,
      });
      return refused === null ? { model } : refuse(reply, refused);
    },
  );

  app.put<{ Body: PriceAsBody }>(
    "/settings/ai-models/price-as",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "model", "priceAs"],
          properties: {
            provider: NAME,
            model: NAME,
            priceAs: {
              type: "object",
              additionalProperties: false,
              required: ["provider", "model"],
              properties: { provider: NAME, model: NAME },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const provider = keyOf(request.body.provider);
      const model = keyOf(request.body.model);
      const target = {
        provider: keyOf(request.body.priceAs.provider),
        model: keyOf(request.body.priceAs.model),
      };
      if (provider === "" || model === "" || target.provider === "" || target.model === "") {
        return reply.code(400).send(INVALID_NAME);
      }
      if (target.model === model) {
        return reply
          .code(400)
          .send(problem("price_as_itself", "Choose another model to price this one as."));
      }
      if (priceOf(model) !== null) {
        return reply
          .code(400)
          .send(
            problem(
              "has_built_in_price",
              "This model has a built-in price. Edit its price instead.",
            ),
          );
      }
      if (!allowed(request, reply)) return reply;
      const refused = await setPriceAs(db, {
        provider,
        model,
        target,
        userId: signedInUser(request).id,
      });
      if (refused !== null) return refuse(reply, refused);
      return { model };
    },
  );

  app.post<{ Body: { model: string } }>(
    "/settings/ai-models/reset",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["model"],
          properties: { model: NAME },
        },
      },
    },
    async (request, reply) => {
      const model = keyOf(request.body.model);
      if (model === "") return reply.code(400).send(INVALID_NAME);
      if (!allowed(request, reply)) return reply;
      const refused = await resetModel(db, model);
      return refused === null ? { model } : refuse(reply, refused);
    },
  );

  done();
};
