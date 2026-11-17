/**
 * ClickHouse's tables, in order, as PostgreSQL's are in db/migrations/.
 * Each migration is a list of statements for one database, named by the
 * caller. A migration that has run is recorded in its schema_migrations
 * table and never runs again, so never change one: add the next.
 */
export interface ClickHouseMigration {
  name: string;
  statements: (database: string) => string[];
}

export const CLICKHOUSE_MIGRATIONS: ClickHouseMigration[] = [
  {
    /**
     * Analytics events, as PostgreSQL's events table has them (db/schema.ts).
     * PostgreSQL still receives them first; the worker copies them here.
     *
     * - Ordered by project, then time: one project's range is one
     *   contiguous read, and every query filters by project first.
     * - Partitioned by month: a range's query reads only its months' parts.
     * - ReplacingMergeTree keeps one row per (project_id, occurred_at,
     *   event_id) when parts merge. The worker sends each event once, so this
     *   only matters if a batch is sent twice after a crash, and the insert
     *   deduplication window already drops a repeated batch (tested).
     * - LowCardinality for columns with few distinct values: smaller and faster.
     */
    name: "0001_create_events",
    statements: (database) => [
      `CREATE TABLE IF NOT EXISTS ${database}.events (
        project_id UUID,
        event_id UUID,
        name LowCardinality(String),
        occurred_at DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC'),
        path String,
        referrer Nullable(String),
        utm_source LowCardinality(Nullable(String)),
        utm_medium LowCardinality(Nullable(String)),
        utm_campaign LowCardinality(Nullable(String)),
        utm_term Nullable(String),
        utm_content Nullable(String),
        properties String,
        browser LowCardinality(Nullable(String)),
        browser_version LowCardinality(Nullable(String)),
        os LowCardinality(Nullable(String)),
        device_type LowCardinality(Nullable(String)),
        country LowCardinality(Nullable(String)),
        region LowCardinality(Nullable(String)),
        city LowCardinality(Nullable(String)),
        visitor_id Nullable(Int64)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMM(occurred_at)
      ORDER BY (project_id, occurred_at, event_id)
      SETTINGS non_replicated_deduplication_window = 1000`,
    ],
  },
  {
    /**
     * An insert returns only once its data is on disk (fsync), as
     * PostgreSQL's commit does. The worker marks a batch copied when the
     * insert returns, and PostgreSQL later deletes its own copy
     * (copy-events.ts), so a batch only in the operating system's cache
     * when the power goes would otherwise be lost for good. The worker
     * inserts one batch every few seconds, so the cost is small.
     */
    name: "0002_sync_events_inserts",
    statements: (database) => [
      `ALTER TABLE ${database}.events
       MODIFY SETTING fsync_after_insert = 1, fsync_part_directory = 1`,
    ],
  },
  {
    /**
     * Where the app runs and which version of it, as in PostgreSQL
     * (migration 0014). Rows from before are "production" with no release.
     */
    name: "0003_add_events_environment_and_release",
    statements: (database) => [
      `ALTER TABLE ${database}.events
       ADD COLUMN IF NOT EXISTS environment LowCardinality(String) DEFAULT 'production',
       ADD COLUMN IF NOT EXISTS release Nullable(String)`,
    ],
  },
  {
    /**
     * The signed-in user who caused the event, as in PostgreSQL (migration
     * 0015). A user's page reads one project's events for one user ID: the
     * bloom filter lets ClickHouse skip the parts of the project without it.
     */
    name: "0004_add_events_user_id",
    statements: (database) => [
      `ALTER TABLE ${database}.events ADD COLUMN IF NOT EXISTS user_id Nullable(String)`,
      `ALTER TABLE ${database}.events
       ADD INDEX IF NOT EXISTS user_id_index user_id TYPE bloom_filter GRANULARITY 4`,
    ],
  },
  {
    /**
     * Errors, as in PostgreSQL (migration 0018): empty for every other
     * event. An error's page reads one project's occurrences of one
     * fingerprint: the bloom filter lets ClickHouse skip the parts without
     * it. Stacks are long and repetitive text: ZSTD packs them well.
     */
    name: "0005_add_events_errors",
    statements: (database) => [
      `ALTER TABLE ${database}.events
       ADD COLUMN IF NOT EXISTS error_type LowCardinality(String) DEFAULT '',
       ADD COLUMN IF NOT EXISTS error_message String DEFAULT '',
       ADD COLUMN IF NOT EXISTS error_stack String DEFAULT '' CODEC(ZSTD(3)),
       ADD COLUMN IF NOT EXISTS error_handled Bool DEFAULT false,
       ADD COLUMN IF NOT EXISTS error_fingerprint String DEFAULT ''`,
      `ALTER TABLE ${database}.events
       ADD INDEX IF NOT EXISTS error_fingerprint_index error_fingerprint
         TYPE bloom_filter GRANULARITY 4`,
    ],
  },
  {
    /**
     * On an error event, the session replay that shows it, as in PostgreSQL
     * (migration 0023; docs/session-replay.md). Null for every other event.
     */
    name: "0006_add_events_replay_id",
    statements: (database) => [
      `ALTER TABLE ${database}.events ADD COLUMN IF NOT EXISTS replay_id Nullable(UUID)`,
    ],
  },
];
