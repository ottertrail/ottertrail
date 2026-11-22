import { type Kysely, sql } from "kysely";

/**
 * What an AI cost rule has already added up (docs/ai-usage.md, "Alerts";
 * alerts/ai-cost-hours.ts): the cost, calls, and calls without a price of
 * each closed hour of its window, so each minute's evaluation reads only
 * the hours still open from ClickHouse, not the whole month or day.
 *
 * - ai_cost_windows: one row per rule, what its hours were added up for
 *   (`settings_key`: its environment, feature, model, and window), which
 *   hours they cover (`filled_from` to `filled_until`), and when they were
 *   last added up from scratch.
 * - ai_cost_hours: one row per rule and hour with calls; an hour of the
 *   covered range without a row had none.
 *
 * Both go with their rule.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table ai_cost_windows (
      rule_id       uuid        primary key references alert_rules (id) on delete cascade,
      settings_key  text        not null,
      filled_from   timestamptz not null,
      filled_until  timestamptz not null,
      recomputed_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table ai_cost_hours (
      rule_id        uuid             not null references alert_rules (id) on delete cascade,
      hour           timestamptz      not null,
      cost_usd       double precision not null,
      calls          bigint           not null,
      no_price_calls bigint           not null,
      primary key (rule_id, hour)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table ai_cost_hours`.execute(db);
  await sql`drop table ai_cost_windows`.execute(db);
}
