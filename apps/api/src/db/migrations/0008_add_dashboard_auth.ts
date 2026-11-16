import { type Kysely, sql } from "kysely";

/**
 * Step 8 of web analytics: signing in to the dashboard.
 *
 * - dashboard_users, dashboard_sessions, dashboard_accounts, and
 *   dashboard_verifications are the tables Better Auth works with
 *   (src/auth/auth.ts maps its names to these). An account row holds the
 *   scrypt hash of a user's password; a session row holds the token in the
 *   user's cookie.
 * - owner_setup_tokens holds the one-time link that creates the owner
 *   (src/auth/setup.ts): only a SHA-256 hash of each token, never the token.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table dashboard_users (
      id              uuid        primary key default gen_random_uuid(),
      name            text        not null check (char_length(name) between 1 and 200),
      email           text        not null unique check (char_length(email) <= 320),
      email_verified  boolean     not null default false,
      image           text,
      role            text        not null default 'member' check (role in ('owner', 'member')),
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )
  `.execute(db);
  // An instance has at most one owner.
  await sql`
    create unique index dashboard_users_one_owner_idx on dashboard_users (role) where role = 'owner'
  `.execute(db);

  await sql`
    create table dashboard_sessions (
      id          uuid        primary key default gen_random_uuid(),
      user_id     uuid        not null references dashboard_users (id) on delete cascade,
      token       text        not null unique,
      expires_at  timestamptz not null,
      user_agent  text,
      -- Better Auth has a column for the client's IP address. Ottertrail
      -- keeps none, so an insert that tries to store one fails.
      ip_address  text        check (ip_address is null),
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index dashboard_sessions_user_id_idx on dashboard_sessions (user_id)`.execute(
    db,
  );

  await sql`
    create table dashboard_accounts (
      id                        uuid        primary key default gen_random_uuid(),
      user_id                   uuid        not null references dashboard_users (id) on delete cascade,
      account_id                text        not null,
      provider_id               text        not null,
      password                  text,
      access_token              text,
      refresh_token             text,
      id_token                  text,
      access_token_expires_at   timestamptz,
      refresh_token_expires_at  timestamptz,
      scope                     text,
      created_at                timestamptz not null default now(),
      updated_at                timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index dashboard_accounts_user_id_idx on dashboard_accounts (user_id)`.execute(
    db,
  );

  await sql`
    create table dashboard_verifications (
      id          uuid        primary key default gen_random_uuid(),
      identifier  text        not null,
      value       text        not null,
      expires_at  timestamptz not null,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index dashboard_verifications_identifier_idx on dashboard_verifications (identifier)
  `.execute(db);

  await sql`
    create table owner_setup_tokens (
      token_hash  bytea       primary key check (octet_length(token_hash) = 32),
      expires_at  timestamptz not null,
      created_at  timestamptz not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table owner_setup_tokens`.execute(db);
  await sql`drop table dashboard_verifications`.execute(db);
  await sql`drop table dashboard_accounts`.execute(db);
  await sql`drop table dashboard_sessions`.execute(db);
  await sql`drop table dashboard_users`.execute(db);
}
