import { type Kysely, sql } from "kysely";

/**
 * Avatars (docs/dashboard.md): the instance's icon, each dashboard user's
 * avatar, and each project's icon, uploaded as PNGs, and each project's
 * site's favicon, fetched by the worker. The images are in the object
 * store under `avatars/` (avatars/avatars.ts); the rows hold the current
 * key only, so a replaced image gets a new URL.
 *
 * - instance_settings.avatar_key, dashboard_users.avatar_key,
 *   projects.avatar_key: the uploaded image, or null.
 * - projects.favicon_key: the site's favicon, or null; favicon_hostname,
 *   the allowed site it was last fetched for (a new first site fetches
 *   again); favicon_checked_at, when the worker last tried (weekly).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table instance_settings
      add column avatar_key text
        constraint instance_settings_avatar_key_check
        check (avatar_key ~ '^avatars/instance/[0-9a-f-]{36}\\.png$')
  `.execute(db);
  await sql`
    alter table dashboard_users
      add column avatar_key text
        constraint dashboard_users_avatar_key_check
        check (avatar_key ~ '^avatars/users/[0-9a-f-]{36}/[0-9a-f-]{36}\\.png$')
  `.execute(db);
  await sql`
    alter table projects
      add column avatar_key text
        constraint projects_avatar_key_check
        check (avatar_key ~ '^avatars/projects/[0-9a-f-]{36}/[0-9a-f-]{36}\\.png$'),
      add column favicon_key text
        constraint projects_favicon_key_check
        check (favicon_key ~ '^avatars/projects/[0-9a-f-]{36}/favicon-[0-9a-f-]{36}\\.(png|ico|jpg|webp|gif)$'),
      add column favicon_hostname text,
      add column favicon_checked_at timestamptz
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      drop column avatar_key,
      drop column favicon_key,
      drop column favicon_hostname,
      drop column favicon_checked_at
  `.execute(db);
  await sql`alter table dashboard_users drop column avatar_key`.execute(db);
  await sql`alter table instance_settings drop column avatar_key`.execute(db);
}
