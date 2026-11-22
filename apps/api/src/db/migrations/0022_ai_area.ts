import { type Kysely, sql } from "kysely";

/**
 * The `ai` area (docs/access.md): the AI page, the AI calls, and the
 * overview's AI cost, apart from monitoring, so someone can see AI costs
 * without seeing traces. None or view, as monitoring.
 *
 * - dashboard_member_access and dashboard_invitations gain `ai`. Members
 *   and pending invitations keep what they could see: `ai` takes their
 *   monitoring level.
 * - notifications.areas may name `ai`, and the AI alerts already in the
 *   inbox (kinds `ai.…`) need it instead of monitoring, as new ones do.
 */
const TABLES = ["dashboard_member_access", "dashboard_invitations"] as const;

const areasCheck = (areas: readonly string[]) => sql`
  alter table notifications
    drop constraint notifications_areas_check,
    add constraint notifications_areas_check check (areas <@ array[${sql.join(
      areas.map((area) => sql.lit(area)),
    )}])
`;

const OLD_AREAS = [
  "web_analytics",
  "product_analytics",
  "errors",
  "replays",
  "users",
  "monitoring",
  "uptime_alerts",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`
      alter table ${sql.table(table)}
        add column ai text not null default 'none' check (ai in ('none', 'view'))
    `.execute(db);
    await sql`update ${sql.table(table)} set ai = monitoring`.execute(db);
  }
  await areasCheck([...OLD_AREAS, "ai"]).execute(db);
  await sql`
    update notifications set areas = array_replace(areas, 'monitoring', 'ai')
    where kind like 'ai.%'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update notifications set areas = array_replace(areas, 'ai', 'monitoring')
    where 'ai' = any (areas)
  `.execute(db);
  await areasCheck(OLD_AREAS).execute(db);
  for (const table of TABLES) {
    await sql`alter table ${sql.table(table)} drop column ai`.execute(db);
  }
}
