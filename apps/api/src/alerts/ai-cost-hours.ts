import type { Kysely } from "kysely";

import type { PriceBook } from "../ai/prices.ts";
import { aiHours, aiWindow, type AiWindow } from "../ai/report.ts";
import type { Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import type { AiCostSettings } from "./kinds.ts";

/**
 * Cache closed hours in PostgreSQL (ai_cost_hours, migration 0018) to avoid rereading the full
 * window each minute (docs/ai-usage.md, "Alerts"). ClickHouse supplies partial hours and newly
 * closed hours. Hours close before the window end, which includes TELEMETRY_LAG_MS.
 *
 * Rebuild daily after the instance's midnight, when settings or prices change, or when the
 * window no longer follows the cached hours. Late arrivals and retention changes affect cached
 * totals only after a rebuild.
 */

const HOUR_MS = 3_600_000;
/** A window with fewer closed hours than this is read whole: the last hour's rule always is. */
const MIN_CLOSED_HOURS = 3;

const floorHour = (moment: Date) => new Date(Math.floor(moment.getTime() / HOUR_MS) * HOUR_MS);
const ceilHour = (moment: Date) => new Date(Math.ceil(moment.getTime() / HOUR_MS) * HOUR_MS);

const filtersOf = (settings: AiCostSettings) => ({
  ...(settings.feature === null ? {} : { feature: settings.feature }),
  ...(settings.model === null ? {} : { model: settings.model }),
});

/**
 * Include the price book fingerprint so an evaluation using old prices cannot leave cached
 * hours valid after a price change (ai/custom-prices.ts).
 */
const keyOf = (settings: AiCostSettings, prices: PriceBook) =>
  JSON.stringify([
    settings.environment,
    settings.feature,
    settings.model,
    settings.costWindow,
    prices.fingerprint,
  ]);

const add = (a: AiWindow, b: AiWindow): AiWindow => ({
  calls: a.calls + b.calls,
  failed: a.failed + b.failed,
  costUsd: a.costUsd + b.costUsd,
  noPriceCalls: a.noPriceCalls + b.noPriceCalls,
});

/**
 * Use cached closed hours and read the rest from ClickHouse. Rebuild hours cached before
 * `dayStart` (the instance's midnight). Closed hours report `failed: 0`; cost rules do not use
 * it.
 */
export async function costOverWindow(
  db: Kysely<Database>,
  reader: Reader,
  rule: { id: string; projectId: string },
  settings: AiCostSettings,
  window: { from: Date; to: Date },
  { at, dayStart, prices }: { at: Date; dayStart: Date; prices: PriceBook },
): Promise<AiWindow> {
  const base = {
    projectId: rule.projectId,
    environment: settings.environment,
    prices,
    ...window,
  };
  const filters = filtersOf(settings);
  const closedFrom = ceilHour(window.from);
  const closedTo = floorHour(window.to);
  if (closedTo.getTime() - closedFrom.getTime() < MIN_CLOSED_HOURS * HOUR_MS) {
    return aiWindow(reader, base, filters);
  }
  const key = keyOf(settings, prices);
  const kept = await db
    .selectFrom("ai_cost_windows")
    .selectAll()
    .where("rule_id", "=", rule.id)
    .executeTakeFirst();
  const again =
    kept === undefined ||
    kept.settings_key !== key ||
    kept.recomputed_at < dayStart ||
    kept.filled_from > closedFrom ||
    kept.filled_until < closedFrom ||
    kept.filled_until > closedTo;
  const fillFrom = again ? closedFrom : kept.filled_until;
  const filled =
    fillFrom < closedTo
      ? await aiHours(reader, { ...base, from: fillFrom, to: closedTo }, filters)
      : [];
  await db.transaction().execute(async (trx) => {
    if (again) {
      await trx.deleteFrom("ai_cost_hours").where("rule_id", "=", rule.id).execute();
    } else {
      await trx
        .deleteFrom("ai_cost_hours")
        .where("rule_id", "=", rule.id)
        .where("hour", "<", closedFrom)
        .execute();
    }
    if (filled.length > 0) {
      await trx
        .insertInto("ai_cost_hours")
        .values(
          filled.map((hour) => ({
            rule_id: rule.id,
            hour: hour.hour,
            cost_usd: hour.costUsd,
            calls: hour.calls,
            no_price_calls: hour.noPriceCalls,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["rule_id", "hour"]).doUpdateSet((eb) => ({
            cost_usd: eb.ref("excluded.cost_usd"),
            calls: eb.ref("excluded.calls"),
            no_price_calls: eb.ref("excluded.no_price_calls"),
          })),
        )
        .execute();
    }
    const row = {
      settings_key: key,
      filled_from: closedFrom,
      filled_until: closedTo,
      recomputed_at: again ? at : kept.recomputed_at,
    };
    await trx
      .insertInto("ai_cost_windows")
      .values({ rule_id: rule.id, ...row })
      .onConflict((conflict) => conflict.column("rule_id").doUpdateSet(row))
      .execute();
  });
  const [closed, open] = await Promise.all([
    db
      .selectFrom("ai_cost_hours")
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<number | string>("cost_usd"), eb.lit(0)).as("cost"),
        eb.fn.coalesce(eb.fn.sum<string>("calls"), eb.lit(0)).as("calls"),
        eb.fn.coalesce(eb.fn.sum<string>("no_price_calls"), eb.lit(0)).as("no_price"),
      ])
      .where("rule_id", "=", rule.id)
      .where("hour", ">=", closedFrom)
      .where("hour", "<", closedTo)
      .executeTakeFirstOrThrow(),
    aiWindow(
      reader,
      {
        ...base,
        ranges: [
          { from: window.from, to: closedFrom },
          { from: closedTo, to: window.to },
        ].filter((range) => range.from < range.to),
      },
      filters,
    ),
  ]);
  return add(open, {
    calls: Number(closed.calls),
    failed: 0,
    costUsd: Number(closed.cost),
    noPriceCalls: Number(closed.no_price),
  });
}
