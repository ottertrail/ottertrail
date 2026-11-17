import { type Kysely, sql } from "kysely";

import { canonicalTimeZone } from "../../visitors/visitor-ids.ts";

/**
 * Organizations: one deployment serves many customers (CLAUDE.md).
 *
 * - organizations: one customer each, with its own timezone, which used to
 *   be the deployment's TIMEZONE setting. Reports count days in it, and
 *   visitor salts change at its midnight.
 * - memberships: which dashboard users belong to which organization, and as
 *   what ("owner" or "member"). dashboard_users.role stays as it was: the
 *   owner of the whole install, the account the setup link created.
 * - projects.organization_id: every project belongs to one organization.
 * - visitor_salts: one salt per timezone and day, so a visit never splits
 *   inside an organization's local day, whichever timezone it is in.
 *
 * Data from before this migration moves into one organization, holding
 * every project, with every user as a member (the install's owner as its
 * owner). It takes the timezone the deployment had (TIMEZONE, read here
 * once), so no day boundary and no visitor ID changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const timeZone = canonicalTimeZone(process.env.TIMEZONE?.trim() || "UTC") ?? "UTC";

  await sql`
    create table organizations (
      id          uuid        primary key default gen_random_uuid(),
      name        text        not null check (char_length(name) between 1 and 100),
      time_zone   text        not null,
      created_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create table memberships (
      organization_id  uuid        not null references organizations (id) on delete cascade,
      user_id          uuid        not null references dashboard_users (id) on delete cascade,
      role             text        not null check (role in ('owner', 'member')),
      created_at       timestamptz not null default now(),
      primary key (organization_id, user_id)
    )
  `.execute(db);
  await sql`create index memberships_user_id_idx on memberships (user_id)`.execute(db);

  await sql`
    alter table projects
      add column organization_id uuid references organizations (id) on delete cascade
  `.execute(db);
  await sql`
    with existing as (
      select 1 where exists (select 1 from projects) or exists (select 1 from dashboard_users)
    ),
    organization as (
      insert into organizations (name, time_zone)
      select coalesce(
               -- At most 100 characters, as organizations.name allows.
               (select left(name, 85) || '''s organization' from dashboard_users where role = 'owner'),
               'My organization'
             ),
             ${timeZone}
      from existing
      returning id
    ),
    moved as (
      update projects set organization_id = (select id from organization)
    )
    insert into memberships (organization_id, user_id, role)
    select organization.id, dashboard_users.id, dashboard_users.role
    from organization cross join dashboard_users
  `.execute(db);
  await sql`alter table projects alter column organization_id set not null`.execute(db);
  await sql`create index projects_organization_id_idx on projects (organization_id)`.execute(db);

  await sql`alter table visitor_salts add column time_zone text`.execute(db);
  await sql`update visitor_salts set time_zone = ${timeZone}`.execute(db);
  await sql`alter table visitor_salts alter column time_zone set not null`.execute(db);
  await sql`alter table visitor_salts drop constraint visitor_salts_pkey`.execute(db);
  await sql`alter table visitor_salts add primary key (time_zone, day)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // One salt per day again: keep the salts of the deployment's timezone,
  // the one the code before this migration counts days in.
  const timeZone = canonicalTimeZone(process.env.TIMEZONE?.trim() || "UTC") ?? "UTC";
  await sql`delete from visitor_salts where time_zone <> ${timeZone}`.execute(db);
  await sql`alter table visitor_salts drop constraint visitor_salts_pkey`.execute(db);
  await sql`alter table visitor_salts drop column time_zone`.execute(db);
  await sql`alter table visitor_salts add primary key (day)`.execute(db);
  await sql`alter table projects drop column organization_id`.execute(db);
  await sql`drop table memberships`.execute(db);
  await sql`drop table organizations`.execute(db);
}
