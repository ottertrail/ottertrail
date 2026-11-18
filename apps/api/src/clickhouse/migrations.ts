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

/** The tables of traces, logs, and metrics (migration 0007; docs/telemetry.md). */
export const TELEMETRY_TABLES = ["spans", "logs", "metric_points", "metric_histograms"] as const;

export const CLICKHOUSE_MIGRATIONS: ClickHouseMigration[] = [
  {
    /**
     * Analytics events, with the columns PostgreSQL's events table had.
     * Until PostgreSQL migration 0024 they arrived there first and the
     * worker copied them here; now the API inserts them here directly
     * (collection/event-store.ts).
     *
     * - Ordered by project, then time: one project's range is one
     *   contiguous read, and every query filters by project first.
     *   (Migration 0008 orders it by project, day, and event ID.)
     * - Partitioned by month: a range's query reads only its months' parts.
     * - ReplacingMergeTree keeps one row per sorting key when parts merge,
     *   and reports read with FINAL: a retried event is the same row, so it
     *   counts once (docs/clickhouse.md).
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
     * PostgreSQL's commit does: the API confirms events when the insert
     * returns, so events only in the operating system's cache when the
     * power goes would otherwise be lost after the sender heard they were
     * stored. Asynchronous inserts gather many requests into one part, so
     * the cost stays small.
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
  {
    /**
     * Traces, logs, and metrics received over OTLP (docs/telemetry.md),
     * stored straight here, never in PostgreSQL.
     *
     * - Ordered by project, then time, then the record's ID, and
     *   partitioned by day: ClickHouse drops a whole day once it is past
     *   the retention (TTL with ttl_only_drop_parts), which costs nothing.
     *   30 days here; `vp run migrate` sets TELEMETRY_RETENTION_DAYS
     *   (applyTelemetryRetention in clickhouse/migrate.ts).
     * - ReplacingMergeTree keeps one row per ID: a span's is its trace and
     *   span IDs, a log record's or data point's a hash of its content, so
     *   a request retried after a lost answer is stored once. Queries that
     *   count read with FINAL.
     * - Attributes as text in maps; events and links of a span as JSON.
     * - A bloom filter finds a trace's spans and logs; a text index finds
     *   logs by the words in their body.
     */
    name: "0007_create_telemetry",
    statements: (database) => [
      `CREATE TABLE IF NOT EXISTS ${database}.spans (
        project_id UUID,
        timestamp DateTime64(9, 'UTC'),
        id String,
        trace_id String,
        span_id String,
        parent_span_id String,
        name LowCardinality(String),
        kind Enum8('unspecified' = 0, 'internal' = 1, 'server' = 2, 'client' = 3, 'producer' = 4, 'consumer' = 5),
        duration_ns UInt64,
        status_code Enum8('unset' = 0, 'ok' = 1, 'error' = 2),
        status_message String,
        service LowCardinality(String),
        release LowCardinality(String),
        environment LowCardinality(String),
        resource_attributes Map(LowCardinality(String), String),
        attributes Map(LowCardinality(String), String),
        dropped_attributes_count UInt32,
        events String CODEC(ZSTD(3)),
        dropped_events_count UInt32,
        links String,
        dropped_links_count UInt32,
        scope_name LowCardinality(String),
        scope_version LowCardinality(String),
        INDEX trace_id_index trace_id TYPE bloom_filter GRANULARITY 4
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, timestamp, id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS ttl_only_drop_parts = 1`,
      `CREATE TABLE IF NOT EXISTS ${database}.logs (
        project_id UUID,
        timestamp DateTime64(9, 'UTC'),
        id String,
        observed_timestamp DateTime64(9, 'UTC'),
        severity_number UInt8,
        severity_text LowCardinality(String),
        body String CODEC(ZSTD(3)),
        trace_id String,
        span_id String,
        event_name LowCardinality(String),
        service LowCardinality(String),
        release LowCardinality(String),
        environment LowCardinality(String),
        resource_attributes Map(LowCardinality(String), String),
        attributes Map(LowCardinality(String), String),
        dropped_attributes_count UInt32,
        scope_name LowCardinality(String),
        scope_version LowCardinality(String),
        INDEX trace_id_index trace_id TYPE bloom_filter GRANULARITY 4,
        INDEX body_text body TYPE text(tokenizer = 'splitByNonAlpha')
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, timestamp, id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS ttl_only_drop_parts = 1`,
      `CREATE TABLE IF NOT EXISTS ${database}.metric_points (
        project_id UUID,
        timestamp DateTime64(9, 'UTC'),
        id String,
        start_timestamp DateTime64(9, 'UTC'),
        name LowCardinality(String),
        unit LowCardinality(String),
        kind Enum8('gauge' = 1, 'sum' = 2),
        temporality Enum8('unspecified' = 0, 'delta' = 1, 'cumulative' = 2),
        monotonic Bool,
        value Float64,
        service LowCardinality(String),
        release LowCardinality(String),
        environment LowCardinality(String),
        resource_attributes Map(LowCardinality(String), String),
        attributes Map(LowCardinality(String), String),
        dropped_attributes_count UInt32,
        scope_name LowCardinality(String),
        scope_version LowCardinality(String)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, timestamp, id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS ttl_only_drop_parts = 1`,
      `CREATE TABLE IF NOT EXISTS ${database}.metric_histograms (
        project_id UUID,
        timestamp DateTime64(9, 'UTC'),
        id String,
        start_timestamp DateTime64(9, 'UTC'),
        name LowCardinality(String),
        unit LowCardinality(String),
        temporality Enum8('unspecified' = 0, 'delta' = 1, 'cumulative' = 2),
        count UInt64,
        sum Nullable(Float64),
        min Nullable(Float64),
        max Nullable(Float64),
        bounds Array(Float64),
        bucket_counts Array(UInt64),
        service LowCardinality(String),
        release LowCardinality(String),
        environment LowCardinality(String),
        resource_attributes Map(LowCardinality(String), String),
        attributes Map(LowCardinality(String), String),
        dropped_attributes_count UInt32,
        scope_name LowCardinality(String),
        scope_version LowCardinality(String)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, timestamp, id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS ttl_only_drop_parts = 1`,
    ],
  },
  {
    /**
     * Events matched by project, day, and event ID, not by their exact time.
     * A browser's time is corrected for a wrong clock from when its request
     * arrives, so a retry, which spends another time on the way, comes out
     * some milliseconds or seconds apart; with the exact time in the key it
     * was a second row. ReplacingMergeTree keeps one row per sorting key,
     * so the key now holds the day: a retry is the same row unless its two
     * times fall either side of midnight UTC (docs/clickhouse.md). Within a day,
     * rows are in event ID order, so a query reads whole days of a project.
     *
     * A sorting key cannot change in place: the table is made again beside
     * the old one, filled, and swapped. Each step starts over cleanly if a
     * run fails halfway.
     */
    name: "0008_order_events_by_day",
    statements: (database) => [
      `DROP TABLE IF EXISTS ${database}.events_by_day`,
      `CREATE TABLE ${database}.events_by_day AS ${database}.events
       ENGINE = ReplacingMergeTree
       PARTITION BY toYYYYMM(occurred_at)
       ORDER BY (project_id, toDate(occurred_at), event_id)
       SETTINGS non_replicated_deduplication_window = 1000,
         fsync_after_insert = 1, fsync_part_directory = 1`,
      `ALTER TABLE ${database}.events_by_day
       ADD INDEX IF NOT EXISTS user_id_index user_id TYPE bloom_filter GRANULARITY 4`,
      `ALTER TABLE ${database}.events_by_day
       ADD INDEX IF NOT EXISTS error_fingerprint_index error_fingerprint
         TYPE bloom_filter GRANULARITY 4`,
      `INSERT INTO ${database}.events_by_day SELECT * FROM ${database}.events`,
      `EXCHANGE TABLES ${database}.events AND ${database}.events_by_day`,
      `DROP TABLE ${database}.events_by_day`,
    ],
  },
];
