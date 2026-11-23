import { type Kysely, sql } from "kysely";

/**
 * Where each project's visitor locations come from (docs/web-analytics.md,
 * "Locations"); it replaces the GEO_SOURCE variable:
 *
 * - location_source: "database" (the DB-IP file, the default), "headers"
 *   (request headers a trusted proxy sets), or "off".
 * - location_country_header, location_region_header, location_city_header:
 *   the header names for "headers", lower case (collection/location-headers.ts).
 *   They stay when another source is chosen; "headers" needs the country one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column location_source text not null default 'database'
        check (location_source in ('database', 'headers', 'off')),
      add column location_country_header text
        check (location_country_header ~ '^[a-z0-9-]{1,64}$'),
      add column location_region_header text
        check (location_region_header ~ '^[a-z0-9-]{1,64}$'),
      add column location_city_header text
        check (location_city_header ~ '^[a-z0-9-]{1,64}$'),
      add constraint projects_location_headers_check
        check (location_source <> 'headers' or location_country_header is not null)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      drop constraint projects_location_headers_check,
      drop column location_source,
      drop column location_country_header,
      drop column location_region_header,
      drop column location_city_header
  `.execute(db);
}
