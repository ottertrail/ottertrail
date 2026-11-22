import type { Kysely } from "kysely";

import { aiHours, aiWindow, type AiWindow } from "../ai/report.ts";
import type { Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import type { AiCostSettings } from "./kinds.ts";

/**
 * An AI cost rule's window without rereading it every minute
 * (docs/ai-usage.md, "Alerts"): the cost of each closed hour of the window
 * is kept in PostgreSQL (ai_cost_hours, migration 0018), and each
 * evaluation reads from ClickHouse only what is not closed: the part of
 * the hour the window starts in, the hours closed since the last
 * evaluation (once), and the hour still open. An hour is closed once it
 * has ended before the window's end, which is already the arrival lag
 * before the evaluation (TELEMETRY_LAG_MS).
 *
 * A call that arrives late, for an hour already closed, is not in the kept
 * total: the hours are added up again from scratch once a day, at the
 * first evaluation after the instance's midnight, when the rule's
 * settings change, and when the window no longer follows on from the
 * hours kept (the clock went back, or the rule was not evaluated for its
 * whole window). Likewise a call retention deletes from a closed hour
 * stays counted until then.
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

/** What the kept hours were added up for: a change starts them again. */
const keyOf = (settings: AiCostSettings) =>
  JSON.stringify([settings.environment, settings.feature, settings.model, settings.costWindow]);

const add = (a: AiWindow, b: AiWindow): AiWindow => ({
  calls: a.calls + b.calls,
  failed: a.failed + b.failed,
  costUsd: a.costUsd + b.costUsd,
  noPriceCalls: a.noPriceCalls + b.noPriceCalls,
});

/**
 * The calls of an AI cost rule's window, `from` to `to`: the closed hours
 * from what is kept (adding the hours closed since), the rest from
 * ClickHouse. `dayStart` is the instance's midnight of the evaluation's
 * day: kept hours added up before it are added up again. `failed` is not
 * kept (a cost rule does not read it): 0 for the closed hours.
 */
export async function costOverWindow(
  db: Kysely<Database>,
  reader: Reader,
  rule: { id: string; projectId: string },
  settings: AiCostSettings,
  window: { from: Date; to: Date },
  { at, dayStart }: { at: Date; dayStart: Date },
): Promise<AiWindow> {
  const base = { projectId: rule.projectId, environment: settings.environment, ...window };
  const filters = filtersOf(settings);
  const closedFrom = ceilHour(window.from);
  const closedTo = floorHour(window.to);
  if (closedTo.getTime() - closedFrom.getTime() < MIN_CLOSED_HOURS * HOUR_MS) {
    return aiWindow(reader, base, filters);
  }
  const key = keyOf(settings);
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
