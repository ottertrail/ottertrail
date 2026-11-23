import { type Kysely, sql, type Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import { type CustomPrice, type PriceBook, priceBookOf, priceOf, type Rates } from "./prices.ts";

/**
 * Custom AI prices (ai_model_prices, migration 0019; docs/ai-usage.md, "Prices"). Read a price
 * book for each report and alert evaluation. Changes invalidate cached AI cost hours
 * (alerts/ai-cost-hours.ts).
 */

export const MAX_PRICE_USD = 10_000;
export const PRICE_DECIMALS = 6;

export interface CustomPriceRow extends CustomPrice {
  updatedAt: Date;
  /** Who last changed it; null once that user is deleted. */
  updatedBy: { id: string; name: string } | null;
}

const rateOf = (value: string | null) => (value === null ? null : Number(value));

/** Every custom row, with who changed it, by model then start (all calls first). */
export async function readCustomPrices(db: Kysely<Database>): Promise<CustomPriceRow[]> {
  const rows = await db
    .selectFrom("ai_model_prices")
    .leftJoin("dashboard_users", "dashboard_users.id", "ai_model_prices.updated_by")
    .select([
      "ai_model_prices.provider",
      "ai_model_prices.model",
      "ai_model_prices.effective_from",
      "ai_model_prices.input",
      "ai_model_prices.output",
      "ai_model_prices.cache_read",
      "ai_model_prices.cache_write",
      "ai_model_prices.price_as_provider",
      "ai_model_prices.price_as_model",
      "ai_model_prices.updated_at",
      "ai_model_prices.updated_by",
      "dashboard_users.name as updated_by_name",
    ])
    .orderBy("ai_model_prices.model")
    .orderBy("ai_model_prices.effective_from", (order) => order.asc().nullsFirst())
    .execute();
  return rows.map((row) => {
    const input = rateOf(row.input);
    const output = rateOf(row.output);
    return {
      provider: row.provider,
      model: row.model,
      effectiveFrom: row.effective_from,
      rates:
        input === null || output === null
          ? null
          : {
              input,
              output,
              cacheRead: rateOf(row.cache_read),
              cacheWrite: rateOf(row.cache_write),
            },
      priceAs:
        row.price_as_model === null || row.price_as_provider === null
          ? null
          : { provider: row.price_as_provider, model: row.price_as_model },
      updatedAt: row.updated_at,
      updatedBy:
        row.updated_by === null ? null : { id: row.updated_by, name: row.updated_by_name ?? "" },
    };
  });
}

export async function readPriceBook(db: Kysely<Database>): Promise<PriceBook> {
  return priceBookOf(await readCustomPrices(db));
}

/** Custom rows the instance keeps at most, and rows per model. */
export const MAX_CUSTOM_ROWS = 1000;
export const MAX_ROWS_PER_MODEL = 100;

export type PriceProblem =
  | { problem: "too_many_prices" }
  | { problem: "too_many_model_prices" }
  | { problem: "target_has_no_price" }
  | { problem: "target_is_priced_as" }
  | { problem: "others_priced_as_this"; models: string[] };

/** Thrown inside a change's transaction to roll it back with a refusal. */
class Refused extends Error {
  readonly refusal: PriceProblem;
  constructor(refusal: PriceProblem) {
    super(refusal.problem);
    this.refusal = refusal;
  }
}

/**
 * Lock the table while changing prices and checking caps to prevent concurrent chains or cap
 * overruns. Invalidate cached hours in the same transaction; roll back on refusal.
 */
async function change(
  db: Kysely<Database>,
  model: string,
  work: (trx: Transaction<Database>) => Promise<void>,
): Promise<PriceProblem | null> {
  try {
    await db.transaction().execute(async (trx) => {
      await sql`lock table ai_model_prices in share row exclusive mode`.execute(trx);
      await work(trx);
      const counts = await trx
        .selectFrom("ai_model_prices")
        .select((eb) => [
          eb.fn.countAll<string>().as("total"),
          eb.fn.count<string>("id").filterWhere("model", "=", model).as("model"),
        ])
        .executeTakeFirstOrThrow();
      if (Number(counts.total) > MAX_CUSTOM_ROWS) throw new Refused({ problem: "too_many_prices" });
      if (Number(counts.model) > MAX_ROWS_PER_MODEL) {
        throw new Refused({ problem: "too_many_model_prices" });
      }
      await staleKeptHours(trx);
    });
    return null;
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

/**
 * Mark cached hours stale without deleting them, so an evaluation using old prices can still
 * read its hours. The price fingerprint forces a rebuild even if that evaluation writes after
 * invalidation (ai-cost-hours.ts).
 */
async function staleKeptHours(trx: Transaction<Database>): Promise<void> {
  await trx.updateTable("ai_cost_windows").set({ settings_key: "" }).execute();
}

const ratesColumns = (rates: Rates) => ({
  input: rates.input,
  output: rates.output,
  cache_read: rates.cacheRead,
  cache_write: rates.cacheWrite,
});

/**
 * A dated price replaces the row at `effectiveFrom` and preserves earlier prices. Null replaces
 * all rows, including dated prices and `price as`.
 */
export async function setModelPrice(
  db: Kysely<Database>,
  price: {
    provider: string;
    model: string;
    effectiveFrom: Date | null;
    rates: Rates;
    userId: string;
  },
): Promise<PriceProblem | null> {
  const row = {
    provider: price.provider,
    model: price.model,
    effective_from: price.effectiveFrom,
    ...ratesColumns(price.rates),
    price_as_provider: null,
    price_as_model: null,
    created_by: price.userId,
    updated_by: price.userId,
  };
  return change(db, price.model, async (trx) => {
    if (price.effectiveFrom === null) {
      await trx.deleteFrom("ai_model_prices").where("model", "=", price.model).execute();
    }
    await trx
      .insertInto("ai_model_prices")
      .values(row)
      .onConflict((conflict) =>
        conflict.constraint("ai_model_prices_model_from_key").doUpdateSet({
          provider: price.provider,
          ...ratesColumns(price.rates),
          price_as_provider: null,
          price_as_model: null,
          updated_by: price.userId,
          updated_at: new Date(),
        }),
      )
      .execute();
  });
}

async function pricedAs(trx: Transaction<Database>, model: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("ai_model_prices")
    .select("model")
    .where("price_as_model", "=", model)
    .orderBy("model")
    .execute();
  return rows.map((row) => row.model);
}

/**
 * Keep dated prices when setting `price as`; they take precedence from their starts. Require a
 * priced target and reject chains in either direction.
 */
export async function setPriceAs(
  db: Kysely<Database>,
  priceAs: {
    provider: string;
    model: string;
    target: { provider: string; model: string };
    userId: string;
  },
): Promise<PriceProblem | null> {
  return change(db, priceAs.model, async (trx) => {
    const targetRows = await trx
      .selectFrom("ai_model_prices")
      .select(["input", "price_as_model"])
      .where("model", "=", priceAs.target.model)
      .execute();
    if (targetRows.some((row) => row.price_as_model !== null)) {
      throw new Refused({ problem: "target_is_priced_as" });
    }
    if (priceOf(priceAs.target.model) === null && !targetRows.some((row) => row.input !== null)) {
      throw new Refused({ problem: "target_has_no_price" });
    }
    const pointing = await pricedAs(trx, priceAs.model);
    if (pointing.length > 0)
      throw new Refused({ problem: "others_priced_as_this", models: pointing });
    await trx
      .deleteFrom("ai_model_prices")
      .where("model", "=", priceAs.model)
      .where("effective_from", "is", null)
      .execute();
    await trx
      .insertInto("ai_model_prices")
      .values({
        provider: priceAs.provider,
        model: priceAs.model,
        effective_from: null,
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        price_as_provider: priceAs.target.provider,
        price_as_model: priceAs.target.model,
        created_by: priceAs.userId,
        updated_by: priceAs.userId,
      })
      .execute();
  });
}

/**
 * Reset to the bundled price or none. Refuse while another model uses this one as its price
 * source.
 */
export async function resetModel(
  db: Kysely<Database>,
  model: string,
): Promise<PriceProblem | null> {
  return change(db, model, async (trx) => {
    const pointing = await pricedAs(trx, model);
    if (pointing.length > 0)
      throw new Refused({ problem: "others_priced_as_this", models: pointing });
    await trx.deleteFrom("ai_model_prices").where("model", "=", model).execute();
  });
}
