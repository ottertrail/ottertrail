import { type Kysely, sql } from "kysely";

/**
 * alert_history gains `kind`: the kind of the rule when the alert fired
 * (docs/uptime-alerts.md, "Alerts"). A rule can change kind and keeps its
 * history, and who may read an alert depends on its kind (docs/access.md,
 * "Alert rules and the areas they watch"): an error rule's messages name
 * errors, so changed into a check rule it must not show them to a user
 * with only uptime and alerts. The history is read by this kind, not the
 * rule's current one. Rows already there take their rule's kind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table alert_history add column kind text`.execute(db);
  await sql`
    update alert_history h set kind = r.kind from alert_rules r where r.id = h.rule_id
  `.execute(db);
  await sql`
    alter table alert_history
      alter column kind set not null,
      add constraint alert_history_kind_check check (char_length(kind) between 1 and 64)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table alert_history drop column kind`.execute(db);
}
