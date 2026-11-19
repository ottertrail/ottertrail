import { type Kysely, sql } from "kysely";

/**
 * A project's own spam rules (docs/web-analytics.md, "Spam"):
 *
 * - blocked_addresses: the IPv4 and IPv6 addresses and CIDR ranges whose
 *   browser events the project ignores. The only IP addresses Ottertrail
 *   stores, and only those an owner or admin typed in; they go with the
 *   project.
 * - blocked_referrers: domains whose referrals the project ignores, each
 *   with its subdomains, besides the shared referrer spam lists.
 *
 * The API checks and normalises each entry (projects/blocked-addresses.ts,
 * projects/blocked-referrers.ts); the checks here only bound the lists, as
 * a last line of defense.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column blocked_addresses text[] not null default '{}'
        check (cardinality(blocked_addresses) <= 100),
      add column blocked_referrers text[] not null default '{}'
        check (cardinality(blocked_referrers) <= 100)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects drop column blocked_addresses, drop column blocked_referrers`.execute(
    db,
  );
}
