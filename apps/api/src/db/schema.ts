import type { ColumnType } from "kysely";

/**
 * TypeScript view of the database tables, used by Kysely to check queries.
 * Keep it in step with the migrations in ./migrations.
 *
 * ColumnType<Select, Insert, Update> describes what a column returns when
 * read, and what it accepts on insert and update.
 */

/** Set by the database on insert; never written by the application. */
type DatabaseDefault<T> = ColumnType<T, never, never>;

/** Optional on insert: leaving it out stores NULL. */
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

export type JsonObject = { [key: string]: unknown };

/**
 * The instance's settings: one row (migration 0001_create_schema). Read them
 * through settings/settings.ts, which caches them.
 */
export interface InstanceSettingsTable {
  id: ColumnType<boolean, never, never>;
  /** What the dashboard shows above the projects. */
  name: string;
  /**
   * IANA timezone, such as "Asia/Singapore". Reports count days in it, and
   * visitor salts change at its midnight.
   */
  time_zone: string;
  updated_at: ColumnType<Date, never, Date>;
}

export interface ProjectsTable {
  id: ColumnType<string, string | undefined, never>;
  name: string;
  created_at: DatabaseDefault<Date>;
  /** "pk_" + 32 hex characters. Public: identifies the project to the collection endpoint. */
  public_key: ColumnType<string, string | undefined, string>;
  /** Sites whose pages may send events, such as "example.com". Empty accepts nothing. */
  allowed_hostnames: ColumnType<string[], string[] | undefined, string[]>;
  /** Days of events to keep, 30 to 3650; null keeps them forever. */
  retention_days: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * "sk_" + 32 hex characters, for the site's own server only: it sends
   * server-side events and telemetry, and signs user IDs.
   */
  secret_key: ColumnType<string, string | undefined, string>;
  /** Accept a browser's user ID only with a valid signature from the site's server. */
  require_signed_user_ids: ColumnType<boolean, boolean | undefined, boolean>;
  /** Ignore browser events from cloud and hosting providers' addresses. */
  ignore_data_centers: ColumnType<boolean, boolean | undefined, boolean>;
  /** Session replays: "off", or "errors", around errors. */
  replay_mode: ColumnType<"off" | "errors", "off" | "errors" | undefined, "off" | "errors">;
  /**
   * When the project's latest event happened; null before the first. The
   * API records it as it stores events (collection/last-event.ts).
   */
  last_event_at: ColumnType<Date | null, never, Date | null>;
}

/**
 * A deleted project whose events ClickHouse may still hold, until the
 * worker has deleted them there (clickhouse/delete-events.ts).
 */
export interface ProjectDeletionsTable {
  project_id: string;
  deleted_at: DatabaseDefault<Date>;
}

/** Why a check's request failed (uptime/request.ts). */
export type CheckCause =
  | "timeout"
  | "refused"
  | "connection"
  | "dns"
  | "tls"
  | "status"
  | "word"
  | "redirects"
  | "address";

/** A project's HTTP(S) uptime check, and its state (docs/uptime-alerts.md). */
export interface UptimeChecksTable {
  id: ColumnType<string, string | undefined, never>;
  project_id: ColumnType<string, string, never>;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  interval_seconds: number;
  timeout_seconds: number;
  /** Status codes that count as up, such as "200-399" or "200,204,300-302" (uptime/checks.ts). */
  expected_statuses: string;
  /** A word the body must hold (word_mode present) or must not (absent); null for none. */
  word: Nullable<string>;
  word_mode: "present" | "absent";
  failures_before_down: number;
  paused: ColumnType<boolean, boolean | undefined, boolean>;
  state: ColumnType<"pending" | "up" | "down", "pending" | "up" | "down" | undefined>;
  consecutive_failures: ColumnType<number, number | undefined, number>;
  /** The first failure of the current run of failures, and its cause; null while the latest succeeded. */
  failing_since: Nullable<Date>;
  failing_cause: Nullable<CheckCause>;
  failing_detail: Nullable<string>;
  next_due_at: Date;
  last_checked_at: Nullable<Date>;
  last_up: Nullable<boolean>;
  last_status_code: Nullable<number>;
  last_response_ms: Nullable<number>;
  last_cause: Nullable<CheckCause>;
  /** When the HTTPS certificate seen last expires. */
  tls_expires_at: Nullable<Date>;
  /** When the URL last changed: a run started before it is not recorded. */
  url_changed_at: Nullable<Date>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** One time a check was down: open (ended_at null) while it still is. */
export interface UptimeIncidentsTable {
  id: ColumnType<string, string | undefined, never>;
  check_id: ColumnType<string, string, never>;
  project_id: ColumnType<string, string, never>;
  started_at: Date;
  ended_at: Nullable<Date>;
  /** The first failure's cause and what it said. */
  cause: CheckCause;
  detail: ColumnType<string, string | undefined, string>;
}

/** A place notifications go (docs/uptime-alerts.md, "Where alerts go"): an email list or a webhook. */
export interface NotificationChannelsTable {
  id: ColumnType<string, string | undefined, never>;
  name: string;
  kind: ColumnType<"email" | "webhook", "email" | "webhook", never>;
  /** An email channel's 1 to 20 addresses; null for a webhook. */
  email_addresses: Nullable<string[]>;
  /** A webhook's URL and signing secret; null for an email channel. */
  webhook_url: Nullable<string>;
  webhook_secret: Nullable<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type DeliveryStatus = "pending" | "sent" | "failed";

/** One notification to one channel, and how sending it went (notifications/deliveries.ts). */
export interface NotificationDeliveriesTable {
  id: ColumnType<string, string | undefined, never>;
  /** The notification it belongs to: one per call to notify, shared by its channels. */
  notification_id: ColumnType<string, string, never>;
  channel_id: ColumnType<string, string, never>;
  event_type: ColumnType<string, string, never>;
  /** The webhook body, version 1 (notifications/events.ts, NotificationPayload). */
  payload: ColumnType<unknown, string, never>;
  status: ColumnType<DeliveryStatus, DeliveryStatus | undefined, DeliveryStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  /** When it is next tried; null once it is sent or has failed. */
  next_attempt_at: Nullable<Date>;
  /** Why the latest attempt failed, in a sentence the dashboard shows. */
  last_error: Nullable<string>;
  /**
   * For a row the channel's hourly cap refused: how many notifications it
   * stands for (one row per channel and hour); 0 for every other row.
   */
  refused: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  sent_at: Nullable<Date>;
}

/**
 * A project's alert rule (docs/uptime-alerts.md, "Alerts"; alerts/rules.ts):
 * what it watches (its kind and settings) and the channels it sends to.
 */
export interface AlertRulesTable {
  id: ColumnType<string, string | undefined, never>;
  project_id: ColumnType<string, string, never>;
  name: string;
  /** One of alerts/kinds.ts's RULE_KINDS. */
  kind: string;
  /** The kind's settings (alerts/kinds.ts); written as JSON text. */
  settings: ColumnType<unknown, string, string>;
  channel_ids: ColumnType<string[], string[], string[]>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Why the server turned the rule off; null when on, or turned off by a user. */
  disabled_reason: Nullable<string>;
  /** The hour the rule's notifications are counted in, and what it sent and held back. */
  cap_window_start: Nullable<Date>;
  cap_sent: ColumnType<number, number | undefined, number>;
  cap_held: ColumnType<number, number | undefined, number>;
  /** When it was created, turned on again, or changed what it watches: error rules read nothing older. */
  active_since: ColumnType<Date, Date | undefined, Date>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  /** Telemetry rules: when it is due next; null, due now (taken FOR UPDATE SKIP LOCKED). */
  next_evaluation_at: Nullable<Date>;
  /** Telemetry rules: why the last evaluation failed, and since when they have; null after one that worked. */
  evaluation_error: Nullable<string>;
  evaluation_failing_since: Nullable<Date>;
}

/** Whether a rule fires for one subject (a check, a fingerprint, or '' for a spike rule). */
export interface AlertStatesTable {
  rule_id: string;
  subject: string;
  firing: boolean;
  /** What it fired for, when that matters: a certificate's expiry, a resolution's time. */
  key: ColumnType<string, string | undefined, string>;
  since: Date;
  /** A spike rule's: since when its count has been below the threshold. */
  clear_since: Nullable<Date>;
  last_notified_at: Nullable<Date>;
  /** The open alert in alert_history. */
  history_id: Nullable<string>;
}

/** One alert: when it fired and resolved, what it said, and its notifications. */
export interface AlertHistoryTable {
  id: ColumnType<string, string | undefined, never>;
  rule_id: ColumnType<string, string, never>;
  project_id: ColumnType<string, string, never>;
  subject: string;
  subject_name: string;
  fired_at: Date;
  resolved_at: Nullable<Date>;
  message: string;
  /** The notification sent when it fired; null when the rule's hourly cap held it back. */
  notification_id: Nullable<string>;
  resolve_notification_id: Nullable<string>;
}

/**
 * Up to when a project's error rules have read arrivals, and, when a
 * minute read more groups than it takes, the last group read.
 */
export interface AlertEvaluationsTable {
  project_id: string;
  errors_until: Date;
  after_arrival: Nullable<Date>;
  after_fingerprint: Nullable<string>;
  after_environment: Nullable<string>;
}

/** An error group (in one environment) new-error rules have seen, and when it first arrived. */
export interface AlertErrorGroupsTable {
  project_id: string;
  fingerprint: string;
  environment: string;
  first_arrival: Date;
}

/** A project's saved conversion: a page or a product event. */
export interface GoalsTable {
  id: ColumnType<string, string | undefined, never>;
  project_id: string;
  name: string;
  kind: "page" | "event";
  /** For a page goal: the path viewed. */
  path: Nullable<string>;
  /** For an event goal: the product event's name, and its property filter if any. */
  event_name: Nullable<string>;
  filter_key: Nullable<string>;
  filter_value: Nullable<string>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** A project's named funnel. */
export interface SavedFunnelsTable {
  id: ColumnType<string, string | undefined, never>;
  project_id: string;
  name: string;
  /** The steps as the funnel report takes them (product/steps.ts); written as JSON text. */
  steps: ColumnType<unknown, string, string>;
  count_by: "visitors" | "users";
  window_seconds: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** A piece of a session replay as a browser sent it: one gzip member. */
export interface ReplayChunksTable {
  project_id: string;
  replay_id: string;
  /** From 0: the pieces join in this order. */
  seq: number;
  /** The replay's last piece. */
  last: boolean;
  /** The browser stopped at the size limit: the replay is shorter than it was. */
  cut: boolean;
  data: Buffer;
  received_at: ColumnType<Date, Date | undefined, never>;
}

/** A session replay, joined from its chunks into one object. */
export interface ReplaysTable {
  project_id: string;
  replay_id: string;
  /** Where it is, gzip-compressed JSON, in the object store. */
  object_key: string;
  /** Its stored, compressed size. */
  bytes: number;
  cut: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
  /** The recording's first and last event, on the server's clock (migration 0005). */
  started_at: Date;
  ended_at: Date;
  /** The server's clock minus the recording's, in ms: 0 unless the visitor's was off. */
  clock_offset_ms: ColumnType<string, number | undefined, never>;
  /** Paths visited, in the order first seen, at most 30. */
  pages: ColumnType<string[], string[] | undefined, never>;
  clicks: ColumnType<number, number | undefined, never>;
  page_changes: ColumnType<number, number | undefined, never>;
  /** `{"items":[…],"truncated":false|"scrolls"|"earliest"}` (replays/derive.ts); written as JSON text. */
  timeline: ColumnType<unknown, string | undefined, never>;
  /** The worker's search for the replay's error is over: found, or given up. */
  linked: ColumnType<boolean, boolean | undefined, boolean>;
  /** When the worker looks for the error again. */
  next_link_at: ColumnType<Date, Date | undefined, Date>;
  /** From the replay's first error event, once found; null until then, or when never found. */
  error_at: ColumnType<Date | null, never, Date | null>;
  error_fingerprint: ColumnType<string | null, never, string | null>;
  error_type: ColumnType<string | null, never, string | null>;
  error_message: ColumnType<string | null, never, string | null>;
  user_id: ColumnType<string | null, never, string | null>;
  environment: ColumnType<string | null, never, string | null>;
  browser: ColumnType<string | null, never, string | null>;
  os: ColumnType<string | null, never, string | null>;
  device_type: ColumnType<string | null, never, string | null>;
}

/** A source map a project uploaded, for one release and minified file. */
export interface SourceMapsTable {
  project_id: string;
  release: string;
  /** The minified file's path, as the browser loads it: "/assets/index-4f3a.js". */
  path: string;
  /** Where the map is, gzip-compressed, in the object store. */
  object_key: string;
  /** Its stored, compressed size. */
  bytes: number;
  uploaded_at: ColumnType<Date, Date | undefined, Date>;
}

/** An error group a project's team marked resolved. No row: unresolved. */
export interface ErrorResolutionsTable {
  project_id: string;
  /** The group (errors/fingerprint.ts). */
  fingerprint: string;
  resolved_at: ColumnType<Date, Date | undefined, Date>;
  /** The dashboard user who resolved it; null once that user is deleted. */
  resolved_by: Nullable<string>;
}

/** One random secret per day. Deleted once no event can still need it. */
export interface VisitorSaltsTable {
  /** The IANA timezone whose calendar `day` is in: one salt per timezone and day. */
  time_zone: ColumnType<string, string, never>;
  /** "YYYY-MM-DD" in `time_zone` (date columns arrive as strings; see database.ts). */
  day: ColumnType<string, string, never>;
  salt: ColumnType<Buffer, Buffer, never>;
  created_at: DatabaseDefault<Date>;
}

/**
 * Dashboard sign-in. Better Auth reads and writes these tables itself
 * (src/auth/auth.ts); the application only reads them and sets `role`.
 */
export interface DashboardUsersTable {
  id: ColumnType<string, string | undefined, never>;
  name: string;
  email: string;
  email_verified: ColumnType<boolean, boolean | undefined, boolean>;
  image: Nullable<string>;
  /**
   * "owner" for the one account the setup flow creates, the owner of the
   * instance, who may change its settings; "member" otherwise.
   */
  role: ColumnType<"owner" | "member", "owner" | "member" | undefined, "owner" | "member">;
  created_at: DatabaseDefault<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface DashboardSessionsTable {
  id: ColumnType<string, string | undefined, never>;
  user_id: string;
  token: string;
  expires_at: Date;
  user_agent: Nullable<string>;
  /** Always NULL: a check constraint refuses an IP address. */
  ip_address: ColumnType<null, null | undefined, null>;
  created_at: DatabaseDefault<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** How a user signs in. For a password, provider_id is "credential" and account_id the user's ID. */
export interface DashboardAccountsTable {
  id: ColumnType<string, string | undefined, never>;
  user_id: string;
  account_id: string;
  provider_id: string;
  /** A scrypt hash, never the password itself. */
  password: Nullable<string>;
  created_at: DatabaseDefault<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** One-time links that create the owner. Only a SHA-256 hash of each token is kept. */
export interface OwnerSetupTokensTable {
  token_hash: ColumnType<Buffer, Buffer, never>;
  expires_at: ColumnType<Date, Date, never>;
  created_at: DatabaseDefault<Date>;
}

export interface Database {
  instance_settings: InstanceSettingsTable;
  projects: ProjectsTable;
  project_deletions: ProjectDeletionsTable;
  error_resolutions: ErrorResolutionsTable;
  goals: GoalsTable;
  saved_funnels: SavedFunnelsTable;
  uptime_checks: UptimeChecksTable;
  uptime_incidents: UptimeIncidentsTable;
  notification_channels: NotificationChannelsTable;
  notification_deliveries: NotificationDeliveriesTable;
  alert_rules: AlertRulesTable;
  alert_states: AlertStatesTable;
  alert_history: AlertHistoryTable;
  alert_evaluations: AlertEvaluationsTable;
  alert_error_groups: AlertErrorGroupsTable;
  source_maps: SourceMapsTable;
  replay_chunks: ReplayChunksTable;
  replays: ReplaysTable;
  visitor_salts: VisitorSaltsTable;
  dashboard_users: DashboardUsersTable;
  dashboard_sessions: DashboardSessionsTable;
  dashboard_accounts: DashboardAccountsTable;
  owner_setup_tokens: OwnerSetupTokensTable;
}
