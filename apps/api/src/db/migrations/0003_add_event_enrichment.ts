import { type Kysely, sql } from "kysely";

/**
 * Step 4 of web analytics: what the server works out about the visitor
 * from the request itself, at the moment the event arrives.
 *
 * - browser, browser_version (major only), os, device_type: from the
 *   User-Agent header.
 * - country (ISO 3166-1 code), region and city (English names): from the
 *   client's IP address, looked up in a geolocation database. The IP
 *   address itself is never stored.
 *
 * Events stored before this migration have NULL in every new column.
 * Locations cannot be filled in later: the IP addresses are gone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      add column browser          text check (char_length(browser) <= 50),
      add column browser_version  text check (browser_version ~ '^[0-9]{1,6}$'),
      add column os               text check (char_length(os) <= 50),
      add column device_type      text check (device_type in ('desktop', 'mobile', 'tablet', 'tv')),
      add column country          text check (country ~ '^[A-Z]{2}$'),
      add column region           text check (char_length(region) <= 100),
      add column city             text check (char_length(city) <= 100)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      drop column city,
      drop column region,
      drop column country,
      drop column device_type,
      drop column os,
      drop column browser_version,
      drop column browser
  `.execute(db);
}
