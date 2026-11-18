import { type Kysely, sql } from "kysely";

/**
 * Dashboard roles and access (docs/access.md).
 *
 * - dashboard_users.role: "owner" (exactly one, the unique index from
 *   0001_create_schema), "admin", or "member". last_sign_in_at: when the
 *   user last signed in, for the Members page.
 * - dashboard_member_access: what a member may reach. One row per member;
 *   the owner and admins have none and reach everything. all_projects
 *   covers projects created later; otherwise dashboard_member_projects
 *   lists the projects. Each area is none, view, or manage; an area with
 *   nothing to change takes only none or view.
 * - dashboard_invitations: a pending invitation, by email, with the role
 *   or access it gives. Only a SHA-256 hash of its token is kept. One per
 *   email, stored lowercase: inviting again replaces it. The projects are an array, not a
 *   foreign key, so accepting drops those deleted since. Deleted with the
 *   user who invited.
 * - dashboard_password_resets: a one-time link that sets a user's
 *   password. One per user, a hash only. created_by is null when the
 *   server's command made it, or once its maker is deleted.
 *
 * error_resolutions.resolved_by, the only other column that names a
 * dashboard user, is already set to null when the user is deleted.
 */
const AREA_COLUMNS = sql`
  web_analytics     text not null default 'none' check (web_analytics in ('none', 'view')),
  product_analytics text not null default 'none' check (product_analytics in ('none', 'view', 'manage')),
  errors            text not null default 'none' check (errors in ('none', 'view', 'manage')),
  replays           text not null default 'none' check (replays in ('none', 'view')),
  users             text not null default 'none' check (users in ('none', 'view')),
  monitoring        text not null default 'none' check (monitoring in ('none', 'view')),
  uptime_alerts     text not null default 'none' check (uptime_alerts in ('none', 'view', 'manage'))
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table dashboard_users
      drop constraint dashboard_users_role_check,
      add constraint dashboard_users_role_check check (role in ('owner', 'admin', 'member')),
      add column last_sign_in_at timestamptz
  `.execute(db);

  await sql`
    create table dashboard_member_access (
      user_id      uuid    primary key references dashboard_users (id) on delete cascade,
      all_projects boolean not null default false,
      ${AREA_COLUMNS}
    )
  `.execute(db);

  await sql`
    create table dashboard_member_projects (
      user_id    uuid not null references dashboard_member_access (user_id) on delete cascade,
      project_id uuid not null references projects (id) on delete cascade,
      primary key (user_id, project_id)
    )
  `.execute(db);
  await sql`
    create index dashboard_member_projects_project_index on dashboard_member_projects (project_id)
  `.execute(db);

  await sql`
    create table dashboard_invitations (
      id           uuid        primary key default gen_random_uuid(),
      token_hash   bytea       not null unique,
      email        text        not null unique
                               check (char_length(email) <= 320 and email = lower(email)),
      role         text        not null check (role in ('admin', 'member')),
      all_projects boolean     not null default false,
      project_ids  uuid[]      not null default '{}' check (cardinality(project_ids) <= 1000),
      ${AREA_COLUMNS},
      invited_by   uuid        not null references dashboard_users (id) on delete cascade,
      expires_at   timestamptz not null,
      created_at   timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index dashboard_invitations_invited_by_index on dashboard_invitations (invited_by)
  `.execute(db);

  await sql`
    create table dashboard_password_resets (
      user_id    uuid        primary key references dashboard_users (id) on delete cascade,
      token_hash bytea       not null unique,
      expires_at timestamptz not null,
      created_by uuid        references dashboard_users (id) on delete set null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "dashboard_password_resets",
    "dashboard_invitations",
    "dashboard_member_projects",
    "dashboard_member_access",
  ]) {
    await sql`drop table ${sql.table(table)}`.execute(db);
  }
  // Before this migration, every signed-in user could do everything. A
  // member or admin left behind would get full access, so rolling back
  // deletes every user but the owner, with their sessions.
  await sql`delete from dashboard_users where role <> 'owner'`.execute(db);
  await sql`
    alter table dashboard_users
      drop column last_sign_in_at,
      drop constraint dashboard_users_role_check,
      add constraint dashboard_users_role_check check (role in ('owner', 'member'))
  `.execute(db);
}
