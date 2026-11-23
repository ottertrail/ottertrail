/**
 * Applied migrations are recorded in schema_migrations. Add a new migration
 * instead of changing one that has run (PostgreSQL: db/migrations/).
 */
import { DATABASE_CALL_COLUMNS, databaseCallColumns } from "../telemetry/db-shape.ts";
import { ENGAGEMENT, VITALS } from "../visits/visits.ts";

export interface ClickHouseMigration {
  name: string;
  statements: (database: string) => string[];
}

/** The tables of traces, logs, and metrics (docs/telemetry.md). */
export const TELEMETRY_TABLES = ["spans", "logs", "metric_points", "metric_histograms"] as const;

/** The AI calls among the spans (0008; docs/ai-usage.md), kept as long as events. */
export const AI_CALLS_TABLE = "ai_calls";

/** Migration 0012 copies these columns from 0011. */
const AI_CALL_COLUMNS = [
  "project_id",
  "timestamp",
  "received_at",
  "id",
  "trace_id",
  "span_id",
  "service",
  "environment",
  "release",
  "provider",
  "model",
  "operation",
  "feature",
  "user_id",
  "conversation_id",
  "input_tokens",
  "input_includes_cache",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "duration_ns",
  "first_chunk_ns",
  "failed",
  "error_type",
  "finish_reasons",
].join(", ");

/** Each signed-in user's first event per project and environment (0004). */
export const USER_FIRST_SEEN = "user_first_seen";

/**
 * Each user's earliest event in the events of `database` (optionally only
 * `where`, SQL over events), as user_first_seen's rows: the materialized
 * view, the backfill, and a project's rebuild after its old events are
 * deleted (clickhouse/delete-events.ts) all use it.
 */
export function firstSeenSelect(database: string | null, where = "1"): string {
  // Rename user_id inside the subquery to prevent alias substitution in WHERE
  // from admitting events without a user.
  return `SELECT project_id, environment, id AS user_id, minState(occurred_at) AS first_seen
          FROM (
            SELECT project_id, environment, assumeNotNull(user_id) AS id, occurred_at
            FROM ${database === null ? "" : `${database}.`}events
            WHERE user_id IS NOT NULL AND name NOT IN ('${ENGAGEMENT}', '${VITALS}') AND (${where})
          )
          GROUP BY project_id, environment, user_id`;
}

/** How long heatmap rows are kept (0006): a fixed 90 days, whatever the project's event retention. */
export const HEATMAP_RETENTION_DAYS = 90;

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
  {
    name: "0003_database_call_columns",
    /**
     * A database call's system, database, and query shape, worked out by
     * ClickHouse when a span is written (telemetry/db-shape.ts), as a
     * metric row's series is: the Databases pages normalized every
     * statement of a period on each read, and a busy project's week took
     * 7.8 seconds of the 15 a query may take; reading these columns takes
     * a fraction of that (docs/telemetry.md, "Databases"). Rows already
     * stored get them too (MATERIALIZE COLUMN), waited for.
     */
    statements: (database) => [
      `ALTER TABLE ${database}.spans
         ${databaseCallColumns()
           .map((column) => `ADD COLUMN IF NOT EXISTS ${column}`)
           .join(",\n         ")}`,
      `ALTER TABLE ${database}.spans
         ${DATABASE_CALL_COLUMNS.map((column) => `MATERIALIZE COLUMN ${column}`).join(", ")}
       SETTINGS mutations_sync = 1`,
    ],
  },
  {
    name: "0004_user_first_seen",
    /**
     * When each signed-in user was first seen, per project and environment
     * (docs/clickhouse.md, "First-seen times"): the overview's new users and
     * weekly cohorts read it instead of every signed-in event the project
     * keeps. A materialized view keeps it as events are stored: each insert
     * adds the min of its batch, and AggregatingMergeTree merges them. A
     * retried event adds its time again, which a min ignores. Events that
     * are not something the user did (time-on-page reports, Web Vitals)
     * do not count, as on the Users and Retention pages. The events already
     * stored are copied in once; a run that failed halfway can copy them
     * again harmlessly, for the same reason.
     */
    statements: (database) => [
      `CREATE TABLE IF NOT EXISTS ${database}.${USER_FIRST_SEEN} (
        project_id UUID,
        environment LowCardinality(String),
        user_id String,
        first_seen AggregateFunction(min, DateTime64(3, 'UTC'))
      )
      ENGINE = AggregatingMergeTree
      ORDER BY (project_id, environment, user_id)`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.user_first_seen_mv
       TO ${database}.${USER_FIRST_SEEN}
       AS ${firstSeenSelect(database)}`,
      `INSERT INTO ${database}.${USER_FIRST_SEEN} ${firstSeenSelect(database)}`,
    ],
  },
  {
    name: "0005_log_received_at",
    /**
     * When each log record arrived: ClickHouse's clock as it writes the
     * record (DEFAULT now64), which the Logs page's live view reads
     * records by (telemetry/logs.ts, liveLogs), so a record sent late with
     * an old time still shows. A retry is written again with a later
     * time. A minmax index on it skips the granules written before the
     * last few minutes. Records already stored take their observed time,
     * written once (MATERIALIZE COLUMN) before the default becomes now64:
     * a default left to reads would make every old record look new.
     *
     * Safe to run again after a failure part way: the default is set to the
     * observed time again before MATERIALIZE, and becomes now64 only last.
     * On ClickHouse 26.8, MATERIALIZE COLUMN writes the column only into
     * parts that lack it and leaves values already stored as they are, so a
     * rerun changes no arrival already written; without the reset, a rerun
     * after the switch to now64 would write the rerun's time into the parts
     * still without the column.
     */
    statements: (database) => [
      `ALTER TABLE ${database}.logs
         ADD COLUMN IF NOT EXISTS received_at DateTime64(9, 'UTC') DEFAULT observed_timestamp`,
      `ALTER TABLE ${database}.logs MODIFY COLUMN received_at DEFAULT observed_timestamp`,
      `ALTER TABLE ${database}.logs MATERIALIZE COLUMN received_at SETTINGS mutations_sync = 1`,
      `ALTER TABLE ${database}.logs MODIFY COLUMN received_at DEFAULT now64(9)`,
      `ALTER TABLE ${database}.logs
         ADD INDEX IF NOT EXISTS received_at_index received_at TYPE minmax GRANULARITY 1`,
      `ALTER TABLE ${database}.logs
         MATERIALIZE INDEX received_at_index SETTINGS mutations_sync = 1`,
    ],
  },
  {
    name: "0006_heatmaps",
    /**
     * Heatmaps (docs/web-analytics.md, "Heatmaps"; heatmaps/store.ts): one
     * row per click, and one per pageview for how far down the page the
     * visitor scrolled. No visitor ID, no text of the page.
     *
     * - Ordered by project, then day, then page, then device class: a
     *   report reads one page of one project, so a period is one short
     *   range per day.
     * - ReplacingMergeTree keeps one row per key, and reports read with
     *   FINAL: a retried batch is the same rows (project, day, record ID,
     *   as for events), so it counts once. The key holds the day, not the
     *   exact time, which clock correction moves a little on each attempt.
     *   A pageview's scroll row is sent again, with the same ID, when the
     *   visitor scrolls further and hides the page again: `version` is its
     *   depth, then its dropped clicks (depth × 65,536 + dropped; both only
     *   grow), so the latest is the one kept. A click's version is 0.
     * - Partitioned by day and kept 90 days: ClickHouse drops a whole day
     *   past it (ttl_only_drop_parts), as uptime results. Older clicks
     *   describe an old layout; the project's event retention does not apply.
     * - x, y, depth, and fold in thousandths (0 to 1000): x and y are where
     *   the click fell inside its element, depth the deepest share of the
     *   page reached, fold the share visible without scrolling when the page
     *   first showed. dropped: a pageview's clicks past the 100 sent. The
     *   page's height and the viewport go with each row.
     * - A click's time is to the minute: the order of a visitor's taps (on a
     *   keypad, say) is not kept.
     * - label: the site's own `data-ottertrail-name`; element: the click's
     *   element as a structural path of tag names and positions.
     * - An insert returns once its data is on disk, as events' do.
     * - A day's parts are merged into one once all are an hour old, as the
     *   telemetry tables' are (0002): copies of a record go then.
     */
    statements: (database) => [
      `CREATE TABLE IF NOT EXISTS ${database}.heatmaps (
        project_id UUID,
        record_id UUID,
        kind Enum8('click' = 1, 'scroll' = 2),
        occurred_at DateTime64(3, 'UTC'),
        received_at DateTime64(3, 'UTC'),
        environment LowCardinality(String),
        release String,
        path String,
        device Enum8('mobile' = 1, 'tablet' = 2, 'desktop' = 3),
        label String,
        element String,
        x UInt16,
        y UInt16,
        viewport_width UInt16,
        viewport_height UInt16,
        page_height UInt32,
        rage Bool,
        depth UInt16,
        fold UInt16,
        dropped UInt16,
        version UInt32
      )
      ENGINE = ReplacingMergeTree(version)
      PARTITION BY toDate(occurred_at)
      ORDER BY (project_id, toDate(occurred_at), path, device, kind, record_id)
      TTL toDateTime(occurred_at) + INTERVAL ${HEATMAP_RETENTION_DAYS} DAY
      SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 1000,
        fsync_after_insert = 1, fsync_part_directory = 1,
        min_age_to_force_merge_seconds = ${FORCE_MERGE_SECONDS},
        min_age_to_force_merge_on_partition_only = 1`,
    ],
  },
  {
    name: "0007_heatmap_dead_clicks",
    /**
     * Whether a click was a dead click: nothing on the page responded within
     * a second (docs/web-analytics.md, "Heatmaps"). Rows already stored, and
     * scroll rows, are 0.
     */
    statements: (database) => [
      `ALTER TABLE ${database}.heatmaps ADD COLUMN IF NOT EXISTS dead Bool DEFAULT 0 AFTER rage`,
    ],
  },
  {
    name: "0008_ai_calls",
    /**
     * AI calls (docs/ai-usage.md): one row per span that is a call to a
     * model, written beside the span when a traces request is stored
     * (ai/calls.ts). Token counts, not content: prompts and completions
     * are dropped before (telemetry/ai-content.ts).
     *
     * - Ordered by project, then time, then ID, as spans: every query
     *   filters by project first, then a period. Since 0012, by project,
     *   then day, then ID, as events.
     * - ReplacingMergeTree keeps one row per ID, the span's trace and span
     *   IDs, so a request retried after a lost answer is stored once. The
     *   AI page's totals and breakdowns, and the alert rules, read without
     *   FINAL, as the Services page does; its recent calls read with it.
     * - Partitioned by month, with no TTL: kept as long as the project's
     *   events ("Keep events"), which retention deletes with them
     *   (clickhouse/delete-events.ts), not the 30 days of spans. Cost is
     *   asked about by the month and the year, and a row is small.
     * - A partition's parts are merged into one once all are an hour old,
     *   as the telemetry tables' are (0002), and an insert returns once it
     *   is on disk, as events' do.
     * - Cost is not stored: the API works it out from the tokens when it
     *   reads them (ai/prices.ts), so a corrected price applies to past calls.
     * - feature: `ottertrail.feature`, else `gen_ai.agent.name`, else
     *   `ai.telemetry.functionId`, else "".
     *   user_id: as an error event's, "" for none.
     * - first_chunk_ns: the time to the first chunk of a streamed answer;
     *   null when not reported.
     */
    statements: (database) => [
      `CREATE TABLE IF NOT EXISTS ${database}.${AI_CALLS_TABLE} (
        project_id UUID,
        timestamp DateTime64(9, 'UTC'),
        id String,
        trace_id String,
        span_id String,
        service LowCardinality(String),
        environment LowCardinality(String),
        release LowCardinality(String),
        provider LowCardinality(String),
        model LowCardinality(String),
        operation LowCardinality(String),
        feature LowCardinality(String),
        user_id String,
        input_tokens UInt64,
        output_tokens UInt64,
        cache_read_tokens UInt64,
        cache_write_tokens UInt64,
        reasoning_tokens UInt64,
        duration_ns UInt64,
        first_chunk_ns Nullable(UInt64),
        failed Bool,
        error_type LowCardinality(String),
        finish_reasons Array(LowCardinality(String))
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (project_id, timestamp, id)
      SETTINGS non_replicated_deduplication_window = 1000,
        fsync_after_insert = 1, fsync_part_directory = 1,
        min_age_to_force_merge_seconds = ${FORCE_MERGE_SECONDS},
        min_age_to_force_merge_on_partition_only = 1`,
    ],
  },
  {
    name: "0009_ai_calls_conversation",
    /**
     * A call's conversation (docs/ai-usage.md, "Conversations"): the
     * `gen_ai.conversation.id` of a span, or `conversationId` sent over
     * HTTP (ai/calls.ts, ai/ingest-routes.ts). An ID the app chooses, at
     * most 200 characters, no control characters; "" for none. Nothing
     * else of a conversation is stored.
     *
     * A bloom filter finds one conversation's calls in a period, as
     * trace_id's does a trace's spans. Nothing is live, so no backfill:
     * older rows read "".
     */
    statements: (database) => [
      `ALTER TABLE ${database}.${AI_CALLS_TABLE}
         ADD COLUMN IF NOT EXISTS conversation_id String DEFAULT '' AFTER user_id`,
      `ALTER TABLE ${database}.${AI_CALLS_TABLE}
         ADD INDEX IF NOT EXISTS conversation_id_index conversation_id TYPE bloom_filter GRANULARITY 4`,
    ],
  },
  {
    name: "0010_telemetry_fsync",
    /**
     * An insert into spans, logs, or metrics returns only once its data is
     * on disk, as events', heatmaps', and AI calls' do (0001, 0006, 0008):
     * the OTLP routes answer 200 when the insert returns, so telemetry only
     * in the operating system's cache when the power went would otherwise
     * be lost after the exporter heard it was stored. Asynchronous inserts
     * gather many requests into one part, so the cost stays small.
     */
    statements: (database) =>
      TELEMETRY_TABLES.map(
        (table) =>
          `ALTER TABLE ${database}.${table} MODIFY SETTING
             fsync_after_insert = 1, fsync_part_directory = 1`,
      ),
  },
  {
    name: "0011_received_at",
    /**
     * When each span, metric row, and AI call arrived: the time the API
     * received its request (telemetry/store.ts, ai/ingest-routes.ts), as
     * events' received_at, never a DEFAULT, so a row written without one
     * reads 1970. Nothing is live, so no backfill: older rows read 1970
     * too. Logs have theirs since 0005, ClickHouse's clock as it writes
     * the record, which the live view compares with ClickHouse's own clock.
     *
     * An AI call also says whether its input count holds its cached tokens
     * (`input_includes_cache`, ai/calls.ts; docs/ai-usage.md, "Cost"): rows
     * already stored take what the cost used to assume, input at least the
     * cached tokens.
     */
    statements: (database) => [
      ...(["spans", "metric_points", "metric_histograms"] as const).map(
        (table) =>
          `ALTER TABLE ${database}.${table}
             ADD COLUMN IF NOT EXISTS received_at DateTime64(3, 'UTC') AFTER timestamp`,
      ),
      `ALTER TABLE ${database}.${AI_CALLS_TABLE}
         ADD COLUMN IF NOT EXISTS received_at DateTime64(3, 'UTC') AFTER timestamp,
         ADD COLUMN IF NOT EXISTS input_includes_cache Bool
           DEFAULT input_tokens >= cache_read_tokens + cache_write_tokens AFTER input_tokens`,
    ],
  },
  {
    name: "0012_ai_calls_by_day",
    /**
     * ai_calls keyed by project, then day, then ID, as events are (0001):
     * a call sent over HTTP again with a corrected time is the same row
     * unless its two times fall either side of midnight UTC. Ordered by
     * time (0008), such a retry was a second row.
     *
     * ClickHouse cannot change a sorting key's columns, so the table is made
     * again and the rows copied: a new table, the copy, an exchange of the
     * two (one step in an Atomic database), and the old table dropped. Safe
     * to run again after a failure part way: the first statement drops what
     * a failed run left under the new name, which after the exchange is the
     * old table, and the copy then reads the new one. Run it with the API
     * stopped, as every migration: a call written to the old table between
     * the copy and the exchange is not copied.
     */
    statements: (database) => [
      `DROP TABLE IF EXISTS ${database}.${AI_CALLS_TABLE}_by_day`,
      `CREATE TABLE ${database}.${AI_CALLS_TABLE}_by_day (
        project_id UUID,
        timestamp DateTime64(9, 'UTC'),
        received_at DateTime64(3, 'UTC'),
        id String,
        trace_id String,
        span_id String,
        service LowCardinality(String),
        environment LowCardinality(String),
        release LowCardinality(String),
        provider LowCardinality(String),
        model LowCardinality(String),
        operation LowCardinality(String),
        feature LowCardinality(String),
        user_id String,
        conversation_id String DEFAULT '',
        input_tokens UInt64,
        input_includes_cache Bool
          DEFAULT input_tokens >= cache_read_tokens + cache_write_tokens,
        output_tokens UInt64,
        cache_read_tokens UInt64,
        cache_write_tokens UInt64,
        reasoning_tokens UInt64,
        duration_ns UInt64,
        first_chunk_ns Nullable(UInt64),
        failed Bool,
        error_type LowCardinality(String),
        finish_reasons Array(LowCardinality(String)),
        INDEX conversation_id_index conversation_id TYPE bloom_filter GRANULARITY 4
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (project_id, toDate(timestamp), id)
      SETTINGS non_replicated_deduplication_window = 1000,
        fsync_after_insert = 1, fsync_part_directory = 1,
        min_age_to_force_merge_seconds = ${FORCE_MERGE_SECONDS},
        min_age_to_force_merge_on_partition_only = 1`,
      `INSERT INTO ${database}.${AI_CALLS_TABLE}_by_day (${AI_CALL_COLUMNS})
       SELECT ${AI_CALL_COLUMNS} FROM ${database}.${AI_CALLS_TABLE}`,
      `EXCHANGE TABLES ${database}.${AI_CALLS_TABLE} AND ${database}.${AI_CALLS_TABLE}_by_day`,
      `DROP TABLE ${database}.${AI_CALLS_TABLE}_by_day`,
    ],
  },
  {
    name: "0013_events_received_at_index",
    /**
     * A minmax index on events' arrival, as logs have one (0005): a
     * project's first-seen rebuild adds back the users of the events that
     * arrived while it ran (clickhouse/delete-events.ts, rebuildFirstSeen),
     * and the index skips the granules that arrived before. Events arrive
     * roughly in day order, so old days' granules have old arrivals.
     */
    statements: (database) => [
      `ALTER TABLE ${database}.events
         ADD INDEX IF NOT EXISTS received_at_index received_at TYPE minmax GRANULARITY 1`,
      `ALTER TABLE ${database}.events
         MATERIALIZE INDEX received_at_index SETTINGS mutations_sync = 1`,
    ],
  },
  {
    name: "0014_ai_output_includes_reasoning",
    /**
     * Whether an AI call's output count holds its reasoning tokens
     * (`output_includes_reasoning`, ai/calls.ts; docs/ai-usage.md, "Cost"):
     * OpenAI's and Anthropic's do, Gemini's counts its thoughts apart, and
     * the cost then adds them. Rows already stored take what the cost used
     * to assume: included.
     */
    statements: (database) => [
      `ALTER TABLE ${database}.${AI_CALLS_TABLE}
         ADD COLUMN IF NOT EXISTS output_includes_reasoning Bool DEFAULT true AFTER output_tokens`,
    ],
  },
];
