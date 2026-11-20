import { type Kysely, sql } from "kysely";

/**
 * Account email (docs/access.md, "Account email"), sent only when the
 * instance has SMTP set up.
 *
 * - dashboard_password_resets gains `emailed`: a reset link someone asked
 *   for on the sign-in page ("Forgot password?"), which works for an hour.
 *   A user has at most one emailed link and one made by a person or the
 *   server's command, so asking for an email never voids a link an owner
 *   or admin made, and the other way round.
 * - account_emails: the worker's queue of account emails (password reset,
 *   password changed, invitation, reset link, email changed), apart from
 *   alert deliveries. A row is deleted once its email is sent or given up,
 *   and any row a day old; a link in it is sealed with a key from
 *   AUTH_SECRET (notifications/link-sealer.ts). One reset request waits
 *   per address at most.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table dashboard_password_resets
      add column emailed boolean not null default false,
      drop constraint dashboard_password_resets_check,
      drop constraint dashboard_password_resets_pkey,
      add constraint dashboard_password_resets_pkey primary key (user_id, emailed),
      add constraint dashboard_password_resets_maker_check check (
        case when emailed then created_by is null and not made_by_command
        else (created_by is null) = made_by_command end
      )
  `.execute(db);

  await sql`
    create table account_emails (
      id              uuid        primary key default gen_random_uuid(),
      kind            text        not null
        constraint account_emails_kind_check check (
          kind in ('password_reset', 'reset_link', 'password_changed', 'invitation', 'email_changed')
        ),
      to_address      text        not null
        constraint account_emails_address_check check (char_length(to_address) between 3 and 320),
      params          jsonb       not null default '{}',
      attempts        integer     not null default 0,
      next_attempt_at timestamptz not null default now(),
      created_at      timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index account_emails_due on account_emails (next_attempt_at)`.execute(db);
  // The daily clean-up's delete.
  await sql`create index account_emails_created_at on account_emails (created_at)`.execute(db);
  // One reset request waits per address at most: more add nothing (on conflict do nothing).
  await sql`
    create unique index account_emails_one_reset_request on account_emails (to_address)
    where kind = 'password_reset'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table account_emails`.execute(db);
  // Emailed links have no place in the older table: one link per user.
  await sql`delete from dashboard_password_resets where emailed`.execute(db);
  await sql`
    alter table dashboard_password_resets
      drop constraint dashboard_password_resets_maker_check,
      drop constraint dashboard_password_resets_pkey,
      drop column emailed,
      add constraint dashboard_password_resets_pkey primary key (user_id),
      add constraint dashboard_password_resets_check check ((created_by is null) = made_by_command)
  `.execute(db);
}
