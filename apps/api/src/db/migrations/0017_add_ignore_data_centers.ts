import { type Kysely, sql } from "kysely";

/**
 * projects.ignore_data_centers: whether collection ignores browser events
 * from the address ranges of cloud and hosting providers, where nearly all
 * "visitors" are programs (docs/web-analytics.md, "Data centers"). On for
 * every project, existing ones too; a site whose real users browse from a
 * cloud, such as through a remote desktop, can turn it off.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects add column ignore_data_centers boolean not null default true
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects drop column ignore_data_centers`.execute(db);
}
