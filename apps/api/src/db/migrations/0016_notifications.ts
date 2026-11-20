import { type Kysely, sql } from "kysely";

/**
 * The notifications inbox and error assignment (docs/dashboard.md,
 * "Notifications"; docs/errors.md, "Assignment"), decided with the user on
 * 20 November 2026.
 *
 * - notifications: one row per thing that happened, written where it
 *   happens (an alert firing or resolving, a storage or backup warning, a
 *   backup notice, an error assigned or regressed). Who sees a row is
 *   decided when it is read, from the reader's access as it is then
 *   (notifications/inbox.ts): its project, the areas it needs at view,
 *   the instance permission it needs, and, for a personal item, its one
 *   user. `source_id` is the channel notification it mirrors, so one
 *   source makes one row. Rows are deleted after 90 days.
 * - notification_reads: which rows each user has read. No row: unread.
 * - error_assignments: who is on an error group, at most one person. It
 *   goes with the group's project and with its assignee; losing access
 *   to the project's errors clears it (access/grants.ts).
 * - account_emails takes `error_assigned`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table notifications (
      id          uuid        primary key default gen_random_uuid(),
      kind        text        not null
        constraint notifications_kind_check check (char_length(kind) between 1 and 64),
      project_id  uuid        references projects (id) on delete cascade,
      permission  text
        constraint notifications_permission_check check (permission in ('projects', 'settings')),
      areas       text[]      not null default '{}'
        constraint notifications_areas_check check (areas <@ array['web_analytics',
          'product_analytics', 'errors', 'replays', 'users', 'monitoring', 'uptime_alerts']),
      user_id     uuid        references dashboard_users (id) on delete cascade,
      title       text        not null
        constraint notifications_title_check check (char_length(title) between 1 and 300),
      link        text        not null
        constraint notifications_link_check check (link like '/%' and char_length(link) <= 2048),
      source_id   uuid        unique,
      created_at  timestamptz not null default now(),
      -- An item about the instance names who may see it.
      constraint notifications_scope_check check (project_id is not null or permission is not null)
    )
  `.execute(db);
  // The inbox's order, its pages, and the 90-day clean-up.
  await sql`create index notifications_created on notifications (created_at desc, id desc)`.execute(
    db,
  );
  // Personal items, and deleting a user's.
  await sql`create index notifications_user on notifications (user_id) where user_id is not null`.execute(
    db,
  );
  await sql`create index notifications_project on notifications (project_id)`.execute(db);

  await sql`
    create table notification_reads (
      user_id         uuid        not null references dashboard_users (id) on delete cascade,
      notification_id uuid        not null references notifications (id) on delete cascade,
      read_at         timestamptz not null default now(),
      primary key (user_id, notification_id)
    )
  `.execute(db);
  // Deleting a notification deletes its reads.
  await sql`create index notification_reads_notification on notification_reads (notification_id)`.execute(
    db,
  );

  await sql`
    create table error_assignments (
      project_id   uuid        not null references projects (id) on delete cascade,
      fingerprint  text        not null
        constraint error_assignments_fingerprint_check
        check (fingerprint ~ '^[0-9]{1,3}-[0-9a-f]{20}$'),
      assignee_id  uuid        not null references dashboard_users (id) on delete cascade,
      assigned_by  uuid        references dashboard_users (id) on delete set null,
      assigned_at  timestamptz not null default now(),
      -- The resolution whose regression the assignee was told of.
      regression_told_for timestamptz,
      primary key (project_id, fingerprint)
    )
  `.execute(db);
  // "Assigned to me", and clearing a user's assignments.
  await sql`create index error_assignments_assignee on error_assignments (assignee_id)`.execute(db);

  await sql`
    alter table account_emails
      drop constraint account_emails_kind_check,
      add constraint account_emails_kind_check check (kind in ('password_reset', 'reset_link',
        'password_changed', 'invitation', 'email_changed', 'backup_changed', 'error_assigned'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from account_emails where kind = 'error_assigned'`.execute(db);
  await sql`
    alter table account_emails
      drop constraint account_emails_kind_check,
      add constraint account_emails_kind_check check (kind in ('password_reset', 'reset_link',
        'password_changed', 'invitation', 'email_changed', 'backup_changed'))
  `.execute(db);
  await sql`drop table error_assignments`.execute(db);
  await sql`drop table notification_reads`.execute(db);
  await sql`drop table notifications`.execute(db);
}
