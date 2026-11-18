/**
 * ClickHouse's tables, as PostgreSQL's are in db/migrations/. Each
 * migration is a list of statements for one database, named by the
 * caller. A migration that has run is recorded in its schema_migrations
 * table and never runs again, so never change one: add the next.
 */
export interface ClickHouseMigration {
  name: string;
  statements: (database: string) => string[];
}

/** The tables of traces, logs, and metrics (docs/telemetry.md). */
export const TELEMETRY_TABLES = ["spans", "logs", "metric_points", "metric_histograms"] as const;

/** How old every part of a telemetry table's day must be before it is merged into one (0002). */
export const FORCE_MERGE_SECONDS = 3600;

export const CLICKHOUSE_MIGRATIONS: ClickHouseMigration[] = [
  {
    name: "0001_create_tables",
    statements: (database) => [
      /**
       * Analytics events: pageviews, custom and product events, errors, and
       * Web Vitals, from browsers and servers (collection/event-store.ts).
       *
       * - Ordered by project, then day, then event ID: one project's range
       *   is one contiguous read of whole days, and every query filters by
       *   project first.
       * - ReplacingMergeTree keeps one row per sorting key when parts merge,
       *   and reports read with FINAL: a retried event is the same row, so it
       *   counts once (docs/clickhouse.md). The key holds the day, not the
       *   exact time: a browser's time is corrected for a wrong clock from
       *   when its request arrives, so a retry, which spends another time on
       *   the way, comes out some milliseconds or seconds apart. A retry is
       *   the same row unless its two times fall either side of midnight
       *   UTC.
       * - Partitioned by month: a range's query reads only its months' parts.
       * - An insert returns only once its data is on disk (fsync), as
       *   PostgreSQL's commit does: the API confirms events when the insert
       *   returns, so events only in the operating system's cache when the
       *   power goes would otherwise be lost after the sender heard they
       *   were stored. Asynchronous inserts gather many requests into one
       *   part, so the cost stays small.
       * - LowCardinality for columns with few distinct values: smaller and faster.
       * - environment and release: where the app runs and which version of it.
       * - user_id: the signed-in user who caused the event. A user's page
       *   reads one project's events for one user ID: the bloom filter lets
       *   ClickHouse skip the parts of the project without it.
       * - error_*: empty for every event but an error. An error's page reads
       *   one project's occurrences of one fingerprint: the bloom filter
       *   lets ClickHouse skip the parts without it. Stacks are long and
       *   repetitive text: ZSTD packs them well.
       * - replay_id: on an error event, the session replay that shows it
       *   (docs/session-replay.md).
       * - service, trace_id, span_id: a server's exception received over
       *   OTLP is an error event too (docs/telemetry.md, "Exceptions join the
       *   error list"): its service, and the trace and span it happened in,
       *   in hex as the spans table has them. Empty for every other event.
       */
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
        visitor_id Nullable(Int64),
        environment LowCardinality(String) DEFAULT 'production',
        release Nullable(String),
        user_id Nullable(String),
        error_type LowCardinality(String) DEFAULT '',
        error_message String DEFAULT '',
        error_stack String DEFAULT '' CODEC(ZSTD(3)),
        error_handled Bool DEFAULT false,
        error_fingerprint String DEFAULT '',
        replay_id Nullable(UUID),
        trace_id String DEFAULT '',
        span_id String DEFAULT '',
        service LowCardinality(String) DEFAULT '',
        INDEX user_id_index user_id TYPE bloom_filter GRANULARITY 4,
        INDEX error_fingerprint_index error_fingerprint TYPE bloom_filter GRANULARITY 4
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMM(occurred_at)
      ORDER BY (project_id, toDate(occurred_at), event_id)
      SETTINGS non_replicated_deduplication_window = 1000,
        fsync_after_insert = 1, fsync_part_directory = 1`,
      /**
       * Traces, logs, and metrics received over OTLP (docs/telemetry.md),
       * stored straight here, never in PostgreSQL.
       *
       * - Spans and logs are ordered by project, then time, then the
       *   record's ID; metrics by project, then name, then time, then ID: a
       *   chart reads one metric, and an export holds all of a process's
       *   metrics at one time, so ordered by time alone a chart would read
       *   every metric's rows of the range (docs/telemetry.md, "How metrics
       *   are charted").
       * - Partitioned by day: ClickHouse drops a whole day once it is past
       *   the retention (TTL with ttl_only_drop_parts), which costs nothing.
       *   30 days here; `vp run migrate` then sets TELEMETRY_RETENTION_DAYS
       *   (applyTelemetryRetention in clickhouse/migrate.ts).
       * - ReplacingMergeTree keeps one row per ID: a span's is its trace and
       *   span IDs, a log record's or data point's a hash of its content, so
       *   a request retried after a lost answer is stored once. Queries that
       *   count read with FINAL.
       * - Attributes as text in maps; events and links of a span as JSON.
       * - A bloom filter finds a trace's spans and logs; a text index finds
       *   logs by the words in their body.
       * - Each metric row carries its series: a hash of what tells one
       *   series of a metric from another (service, scope, attributes,
       *   resource attributes, temporality; a histogram's bounds), worked
       *   out once when the row is written, so a chart does not hash the
       *   attribute maps of every row it reads.
       */
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
        scope_version LowCardinality(String),
        series UInt64 MATERIALIZED
          cityHash64(service, scope_name, scope_version, attributes, resource_attributes, temporality)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, name, timestamp, id)
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
        scope_version LowCardinality(String),
        series UInt64 MATERIALIZED
          cityHash64(service, scope_name, scope_version, attributes, resource_attributes, temporality, bounds)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, name, timestamp, id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS ttl_only_drop_parts = 1`,
      /**
       * The result of each uptime check's request (docs/uptime-alerts.md),
       * written by the worker; the checks themselves and their incidents are
       * in PostgreSQL.
       *
       * - Ordered by project, then check, then time: every query reads one
       *   check's results, as metrics are ordered by name.
       * - Partitioned by day and kept 90 days: ClickHouse drops a whole day
       *   past it (ttl_only_drop_parts).
       * - A plain MergeTree: only the worker writes a result, once.
       * - status_code 0 when nothing answered; cause empty when it was up.
       */
      `CREATE TABLE IF NOT EXISTS ${database}.check_results (
        project_id UUID,
        check_id UUID,
        timestamp DateTime64(3, 'UTC'),
        up Bool,
        status_code UInt16,
        response_ms UInt32,
        cause LowCardinality(String),
        detail String
      )
      ENGINE = MergeTree
      PARTITION BY toDate(timestamp)
      ORDER BY (project_id, check_id, timestamp)
      TTL toDateTime(timestamp) + INTERVAL 90 DAY
      SETTINGS ttl_only_drop_parts = 1`,
    ],
  },
  {
    name: "0002_force_telemetry_merges",
    /**
     * A retried record stays a second row until ClickHouse merges the parts
     * that hold it, and ClickHouse merges when it decides: a day that gets
     * no more inserts can keep its copies for its whole retention. The
     * pages and alert rules that add up large windows of telemetry read
     * without FINAL (telemetry/services.ts), and the lists without it drop
     * only adjacent copies, so each telemetry table merges a day's parts
     * into one once every part of the day is an hour old
     * (FORCE_MERGE_SECONDS): a copy counts twice for at most about an hour
     * after its day's last insert, plus the merge's own time. A day still
     * written to keeps merging as usual; ttl_only_drop_parts still drops
     * whole days.
     */
    statements: (database) =>
      TELEMETRY_TABLES.map(
        (table) =>
          `ALTER TABLE ${database}.${table} MODIFY SETTING
             min_age_to_force_merge_seconds = ${FORCE_MERGE_SECONDS},
             min_age_to_force_merge_on_partition_only = 1`,
      ),
  },
];
