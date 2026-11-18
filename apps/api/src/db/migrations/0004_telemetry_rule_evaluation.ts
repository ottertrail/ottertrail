import { type Kysely, sql } from "kysely";

/**
 * Telemetry alert rules' evaluation (docs/uptime-alerts.md, step 4).
 *
 * next_evaluation_at: when the rule is due next. The worker takes due
 * telemetry rules with FOR UPDATE SKIP LOCKED and moves this a minute on
 * in the same statement, as uptime checks are taken, so each rule is
 * evaluated by one worker a minute however many run. null: due now (a
 * rule just added, changed, or turned on).
 *
 * evaluation_error and evaluation_failing_since: why the rule's last
 * evaluation failed (a query past its limits, ClickHouse down, the
 * project's time budget spent), and since when its evaluations have been
 * failing; both null after one that worked. The Alerts page shows them,
 * so a rule that cannot be evaluated does not look quiet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table alert_rules
      add column next_evaluation_at timestamptz,
      add column evaluation_error text
        constraint alert_rules_evaluation_error_check check (char_length(evaluation_error) <= 500),
      add column evaluation_failing_since timestamptz
  `.execute(db);
  await sql`
    create index alert_rules_next_evaluation_index
      on alert_rules (next_evaluation_at nulls first)
      where enabled
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index alert_rules_next_evaluation_index`.execute(db);
  await sql`
    alter table alert_rules
      drop column evaluation_failing_since,
      drop column evaluation_error,
      drop column next_evaluation_at
  `.execute(db);
}
