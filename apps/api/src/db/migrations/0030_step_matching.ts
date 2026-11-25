import { type Kysely, sql } from "kysely";

/**
 * Steps that match more than one exact thing (docs/product-analytics.md,
 * "Steps"):
 *
 * - saved_funnels: 2 to 8 steps, up from 5.
 * - goals.filter_operator: how an event goal's filter compares its value,
 *   'notEquals' or 'contains', or null for equals. Only with a filter.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table saved_funnels
      drop constraint saved_funnels_steps_check,
      add constraint saved_funnels_steps_check check (
        case when jsonb_typeof(steps) = 'array'
          then jsonb_array_length(steps) between 2 and 8
          else false end
      )
  `.execute(db);
  await sql`
    alter table goals
      add column filter_operator text
        constraint goals_filter_operator_check
          check (filter_operator in ('notEquals', 'contains')),
      add constraint goals_filter_operator_filter_check
        check (filter_operator is null or filter_key is not null)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table goals
      drop constraint goals_filter_operator_filter_check,
      drop column filter_operator
  `.execute(db);
  await sql`
    alter table saved_funnels
      drop constraint saved_funnels_steps_check,
      add constraint saved_funnels_steps_check check (
        case when jsonb_typeof(steps) = 'array'
          then jsonb_array_length(steps) between 2 and 5
          else false end
      )
  `.execute(db);
}
