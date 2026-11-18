import { type Kysely, sql } from "kysely";

/**
 * Where alerts go (docs/uptime-alerts.md, "Where alerts go"; step 2).
 *
 * notification_channels: the instance's channels, at most 20 (the API
 * counts them). An email channel holds 1 to 20 addresses; a webhook its
 * URL and the secret its requests are signed with, which the server
 * makes (32 random bytes, base64url) and dashboard users see. The checks
 * keep the two kinds' columns apart.
 *
 * notification_deliveries: one row per channel for each notification,
 * written before anything is sent (notifications/deliveries.ts, notify).
 * The worker takes pending rows whose next attempt is due, moving the
 * next attempt on first, and records each outcome: sent, failed after its
 * last retry, or failed at once (the channel's hourly cap, email not set
 * up). Past a channel's hourly cap, one failed row stands for every
 * notification refused that hour, counted in `refused`. The payload is the webhook's body, version 1, kept as typed (json,
 * not jsonb, so its keys stay in order). last_error is a short sentence
 * the dashboard shows. Rows older than 30 days are pruned; deleting a
 * channel deletes its deliveries.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table notification_channels (
      id uuid primary key default gen_random_uuid(),
      name text not null
        constraint notification_channels_name_check check (char_length(name) between 1 and 100),
      kind text not null
        constraint notification_channels_kind_check check (kind in ('email', 'webhook')),
      email_addresses text[],
      webhook_url text
        constraint notification_channels_url_check check (char_length(webhook_url) between 1 and 2048),
      webhook_secret text
        constraint notification_channels_secret_check check (char_length(webhook_secret) between 32 and 100),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint notification_channels_fields_check check (
        (kind = 'email'
          and cardinality(email_addresses) between 1 and 20
          and webhook_url is null and webhook_secret is null)
        or (kind = 'webhook'
          and email_addresses is null
          and webhook_url is not null and webhook_secret is not null)
      )
    )
  `.execute(db);
  await sql`
    create index notification_channels_created_idx on notification_channels (created_at)
  `.execute(db);

  await sql`
    create table notification_deliveries (
      id uuid primary key default gen_random_uuid(),
      notification_id uuid not null,
      channel_id uuid not null references notification_channels (id) on delete cascade,
      event_type text not null
        constraint notification_deliveries_type_check check (char_length(event_type) between 1 and 64),
      payload json not null,
      status text not null default 'pending'
        constraint notification_deliveries_status_check check (status in ('pending', 'sent', 'failed')),
      attempts integer not null default 0,
      next_attempt_at timestamptz,
      last_error text
        constraint notification_deliveries_error_check check (char_length(last_error) <= 500),
      refused integer not null default 0
        constraint notification_deliveries_refused_check check (refused >= 0),
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      constraint notification_deliveries_pending_check
        check ((status = 'pending') = (next_attempt_at is not null))
    )
  `.execute(db);
  await sql`
    create index notification_deliveries_due_idx on notification_deliveries (next_attempt_at)
    where status = 'pending'
  `.execute(db);
  await sql`
    create index notification_deliveries_channel_idx
    on notification_deliveries (channel_id, created_at desc, id desc)
  `.execute(db);
  await sql`
    create index notification_deliveries_created_idx on notification_deliveries (created_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table notification_deliveries`.execute(db);
  await sql`drop table notification_channels`.execute(db);
}
