import type { ColumnType } from "kysely";

import type { IngestOutcome, IngestSource } from "../activity/activity.ts";

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
  /** Whether the worker downloads new location data (migration 0009). */
  update_location_data: ColumnType<boolean, never, boolean>;
  updated_at: ColumnType<Date, never, Date>;
  /** The instance's icon in the object store (avatars/avatars.ts), or null (migration 0017). */
  avatar_key: ColumnType<string | null, never, string | null>;
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
  /** Heatmaps: whether collection takes clicks and scroll depth (docs/web-analytics.md, "Heatmaps"). */
  heatmaps: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * When the project's latest event happened; null before the first. The
   * API records it as it stores events (collection/last-event.ts).
   */
  last_event_at: ColumnType<Date | null, never, Date | null>;
  /** The goal the overview's business figures start with; null for none. One of the project's goals. */
  main_goal_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Addresses and CIDR ranges whose browser events are ignored, normalised
   * (projects/blocked-addresses.ts), at most 100. Typed in by an owner or admin.
   */
  blocked_addresses: ColumnType<string[], string[] | undefined, string[]>;
  /** Domains whose referrals are ignored, with their subdomains, normalised (projects/blocked-referrers.ts), at most 100. */
  blocked_referrers: ColumnType<string[], string[] | undefined, string[]>;
  /** The uploaded icon in the object store (avatars/avatars.ts), or null (migration 0017). */
  avatar_key: ColumnType<string | null, null | undefined, string | null>;
  /** The site's favicon the worker fetched (avatars/favicons.ts), or null. */
  favicon_key: ColumnType<string | null, null | undefined, string | null>;
  /** The allowed site the favicon was last fetched for; another first site fetches again. */
  favicon_hostname: ColumnType<string | null, null | undefined, string | null>;
  /** When the worker last tried to fetch the favicon: it tries again weekly. */
  favicon_checked_at: ColumnType<Date | null, null | undefined, Date | null>;
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
/** What an AI cost rule's closed hours were added up for (0018; alerts/ai-cost-hours.ts). */
export interface AiCostWindowsTable {
  rule_id: string;
  settings_key: string;
  filled_from: Date;
  filled_until: Date;
  recomputed_at: Date;
}

/**
 * One of the instance's own AI model prices (0019; ai/custom-prices.ts):
 * prices from a moment (or for all calls), or the model it is priced as.
 * numeric columns arrive as strings.
 */
export interface AiModelPricesTable {
  id: ColumnType<string, string | undefined, never>;
  provider: string;
  model: string;
  effective_from: Date | null;
  input: ColumnType<string | null, number | null, number | null>;
  output: ColumnType<string | null, number | null, number | null>;
  cache_read: ColumnType<string | null, number | null, number | null>;
  cache_write: ColumnType<string | null, number | null, number | null>;
  price_as_provider: string | null;
  price_as_model: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: DatabaseDefault<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** One closed hour of an AI cost rule's window, with calls. */
export interface AiCostHoursTable {
  rule_id: string;
  hour: Date;
  cost_usd: number;
  /** bigint: read back as text. */
  calls: ColumnType<string, number, number>;
  no_price_calls: ColumnType<string, number, number>;
}

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
  /**
   * The rule's kind when it fired (0021): who may read the alert goes by
   * it, since a rule can change kind and keep its history.
   */
  kind: ColumnType<string, string, never>;
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
  /** What `data` unpacks to, in bytes: a replay's sum is capped (MAX_REPLAY_UNPACKED_BYTES). */
  unpacked_bytes: ColumnType<number, number | undefined, never>;
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
   * "owner" for the one account that owns the instance (the setup flow
   * creates it); "admin" or "member" otherwise (docs/access.md).
   */
  role: ColumnType<Role, Role | undefined, Role>;
  /** When the user last signed in; null before the first time. */
  last_sign_in_at: Nullable<Date>;
  /** The user's avatar in the object store (avatars/avatars.ts), or null (migration 0017). */
  avatar_key: ColumnType<string | null, null | undefined, string | null>;
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

/** A dashboard user's role (docs/access.md). */
export type Role = "owner" | "admin" | "member";
/** How far a member reaches into one area: an area with nothing to change has no "manage". */
export type AreaLevel = "none" | "view" | "manage";

/** The areas of a member's access, or of an invitation's, one column each. */
interface AreaColumns {
  web_analytics: ColumnType<"none" | "view", "none" | "view" | undefined, "none" | "view">;
  product_analytics: ColumnType<AreaLevel, AreaLevel | undefined, AreaLevel>;
  errors: ColumnType<AreaLevel, AreaLevel | undefined, AreaLevel>;
  replays: ColumnType<"none" | "view", "none" | "view" | undefined, "none" | "view">;
  users: ColumnType<"none" | "view", "none" | "view" | undefined, "none" | "view">;
  monitoring: ColumnType<"none" | "view", "none" | "view" | undefined, "none" | "view">;
  ai: ColumnType<"none" | "view", "none" | "view" | undefined, "none" | "view">;
  uptime_alerts: ColumnType<AreaLevel, AreaLevel | undefined, AreaLevel>;
}

/** What a member may reach. The owner and admins have no row: they reach everything. */
export interface DashboardMemberAccessTable extends AreaColumns {
  user_id: string;
  /** Every project, including those created later; otherwise dashboard_member_projects. */
  all_projects: ColumnType<boolean, boolean | undefined, boolean>;
}

/** The projects a member without all_projects may reach. */
export interface DashboardMemberProjectsTable {
  user_id: string;
  project_id: string;
}

/** A pending invitation (docs/access.md). Only a SHA-256 hash of its token is kept. */
export interface DashboardInvitationsTable extends AreaColumns {
  id: ColumnType<string, string | undefined, never>;
  token_hash: ColumnType<Buffer, Buffer, Buffer>;
  /** Lowercase; one invitation per email. */
  email: string;
  role: "admin" | "member";
  all_projects: ColumnType<boolean, boolean | undefined, boolean>;
  /** Not a foreign key: accepting drops the projects deleted since. */
  project_ids: ColumnType<string[], string[] | undefined, string[]>;
  invited_by: string;
  expires_at: Date;
  created_at: ColumnType<Date, Date | undefined, Date>;
}

/** A one-time link that sets a user's password. One per user; a hash only. */
export interface DashboardPasswordResetsTable {
  user_id: string;
  token_hash: ColumnType<Buffer, Buffer, Buffer>;
  expires_at: Date;
  /** Who made it; null exactly when the server's command did (made_by_command). */
  created_by: Nullable<string>;
  made_by_command: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Asked for on the sign-in page and emailed (one hour). A user has one
   * emailed link and one made by a person or the command at most.
   */
  emailed: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, Date>;
}

export type AccountEmailKind =
  | "password_reset"
  | "reset_link"
  | "password_changed"
  | "backup_changed"
  | "invitation"
  | "email_changed"
  | "error_assigned";

/**
 * An account email waiting for the worker (notifications/account-emails.ts):
 * deleted once sent or given up.
 */
export interface AccountEmailsTable {
  id: ColumnType<string, string | undefined, never>;
  kind: ColumnType<AccountEmailKind, AccountEmailKind, never>;
  to_address: ColumnType<string, string, never>;
  /** What the message names: names, addresses, and any link sealed (account-emails.ts). */
  params: ColumnType<unknown, string | undefined, string>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date, Date | undefined, Date>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** One-time links that create the owner. Only a SHA-256 hash of each token is kept. */
export interface OwnerSetupTokensTable {
  token_hash: ColumnType<Buffer, Buffer, never>;
  expires_at: ColumnType<Date, Date, never>;
  created_at: DatabaseDefault<Date>;
}

/**
 * Heatmap overlay links and sessions (access/overlay-tokens.ts). Only a
 * SHA-256 hash of each token is kept.
 */
export interface HeatmapOverlayTokensTable {
  token_hash: ColumnType<Buffer, Buffer, never>;
  kind: ColumnType<"link" | "session", "link" | "session", never>;
  user_id: ColumnType<string, string, never>;
  /** The dashboard session that made it: it ends with that session. */
  session_id: ColumnType<string, string, never>;
  project_id: ColumnType<string, string, never>;
  scope: ColumnType<"heatmap:overlay", "heatmap:overlay", never>;
  expires_at: ColumnType<Date, Date, never>;
  /** When a link was exchanged; null until then, and always for a session. */
  used_at: ColumnType<Date | null, never, Date>;
  /** The page the link was made for, which its session may save a view of (heatmaps/snapshots.ts). */
  path: ColumnType<string | null, string | null | undefined, never>;
  created_at: DatabaseDefault<Date>;
}

/** A saved heatmap view: one per project, page, and device class (heatmaps/snapshots.ts). */
export interface HeatmapSnapshotsTable {
  project_id: string;
  path: string;
  device: "mobile" | "tablet" | "desktop";
  width: number;
  height: number;
  page_height: number;
  object_key: string;
  size_bytes: number;
  /** Who saved it; null once that user is removed. */
  saved_by: string | null;
  saved_at: Date;
}

/** One project's ingestion counts for one hour, source, and outcome (activity/activity.ts). */
export interface IngestActivityTable {
  project_id: string;
  hour: Date;
  source: IngestSource;
  outcome: IngestOutcome;
  /** Requests; bigint, so the driver returns text. */
  count: ColumnType<string, number, number>;
  items: ColumnType<string, number, number>;
  last_at: Date;
}

/** One dashboard user's layout of one project's overview (overview/layout.ts). */
export interface OverviewLayoutsTable {
  user_id: string;
  project_id: string;
  /** Widget IDs in order. */
  widgets: string[];
  /** Widget IDs the user hid. */
  hidden: ColumnType<string[], string[] | undefined, string[]>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** A project one dashboard user starred (projects/stars.ts). */
export interface ProjectStarsTable {
  user_id: string;
  project_id: string;
  created_at: DatabaseDefault<Date>;
}

/**
 * The last update of one location data file (enrichment/updates.ts):
 * "locations", the geolocation database, or "data_centers".
 */
export interface LocationDataUpdatesTable {
  kind: "locations" | "data_centers";
  last_attempt_at: Date;
  last_success_at: Nullable<Date>;
  /** Locations: the month of DB-IP's file, such as "2026-11". */
  version: Nullable<string>;
  /** Locations: when DB-IP built the file. Data centers: when the file was written. */
  built_at: Nullable<Date>;
  /** Data centers: how many providers the file holds. */
  providers: Nullable<number>;
  /** The file as the update left it, to tell whether it was replaced since. */
  file_size: ColumnType<string | null, number | null | undefined, number | null>;
  file_modified_at: Nullable<Date>;
  /** Why the last attempt failed, or which sources failed; null after a clean one. */
  last_error: Nullable<string>;
  /** Failed attempts in a row; 0 after a success. */
  failures: ColumnType<number, number | undefined, number>;
}

/** One row while a location data update runs (enrichment/updates.ts, withUpdateLease). */
export interface LocationDataLeaseTable {
  id: ColumnType<boolean, boolean | undefined, never>;
  holder: string;
  expires_at: Date;
}

/** A channel that gets storage warnings (storage/warning-state.ts). */
export interface StorageWarningChannelsTable {
  channel_id: string;
}

/** A storage warning that is on (storage/warning-job.ts); no row when it is off. */
export interface StorageWarningsTable {
  warning: string;
  level: "warning" | "critical";
  started_at: Date;
  updated_at: Date;
}

/** A project whose first-seen times must be worked out again (clickhouse/delete-events.ts). */
export interface FirstSeenRebuildsTable {
  project_id: string;
  requested_at: ColumnType<Date, Date | undefined, Date>;
}

/** Scheduled backups' settings: one row (migrations 0014 and 0020; backups/settings.ts). */
export interface BackupSettingsTable {
  id: ColumnType<boolean, never, never>;
  enabled: boolean;
  /** "HH:MM" in the instance's timezone. */
  time_of_day: string;
  keep_days: number;
  /** The backup key, an age X25519 identity, sealed (backups/secrets.ts). */
  key_sealed: string | null;
  /** Its public half ("age1…"), which each backup is encrypted to. */
  key_recipient: string | null;
  key_created_at: Date | null;
  /** When the owner confirmed they saved the key. */
  key_saved_at: Date | null;
  /** Daily times before this are not due: turning backups on at 15:00 waits for the next 03:00. */
  schedule_from: Date | null;
  /** The local day ("YYYY-MM-DD") of the last daily time taken. */
  last_slot: string | null;
  /** When a failed backup is tried once more. */
  retry_at: Date | null;
  /** Since when backups are off, and the name of who turned them off; null while on, or never on. */
  disabled_at: Date | null;
  disabled_by: string | null;
  backup_requested_at: Date | null;
  test_restore_requested_at: Date | null;
  /**
   * What the worker last reported about BACKUP_S3_* (migration 0020): the
   * destination without its secret ({ endpoint, region, bucket, prefix,
   * accessKeyId }), or the problem with it in words, and when.
   */
  destination: ColumnType<unknown, string | null, string | null>;
  destination_problem: string | null;
  destination_reported_at: Date | null;
  /** Test connection, asked for on the tab; the worker runs it and stores its steps. */
  connection_test_requested_at: Date | null;
  connection_test: ColumnType<unknown, string | null, string | null>;
  connection_tested_at: Date | null;
  /** The folder's backups as the worker last listed them, or why it could not. */
  backup_list: ColumnType<unknown, string | null, string | null>;
  backup_listed_at: Date | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** A backup or a test restore (backups/state.ts). */
export interface BackupRunsTable {
  id: ColumnType<string, string | undefined, never>;
  kind: ColumnType<"backup" | "test_restore", "backup" | "test_restore", never>;
  trigger: ColumnType<"schedule" | "manual" | "retry", "schedule" | "manual" | "retry", never>;
  status: "running" | "succeeded" | "failed";
  started_at: ColumnType<Date, Date | undefined, never>;
  heartbeat_at: ColumnType<Date, Date | undefined, Date>;
  finished_at: Nullable<Date>;
  /** The backup's folder name, its UTC time ("2026-11-20T030000Z"). */
  folder: Nullable<string>;
  /** Encrypted bytes uploaded, or checked. */
  bytes: Nullable<string | number>;
  error: Nullable<string>;
}

/** The instance permissions an inbox item can need (access/permissions). */
export type InboxPermission = "projects" | "settings";

/**
 * An inbox item (notifications/inbox.ts, migration 0016): who sees it is
 * decided when it is read, from its project, areas, permission, and user.
 */
export interface NotificationsTable {
  id: ColumnType<string, string | undefined, never>;
  /** An event type (notifications/events.ts), or "error.assigned". */
  kind: ColumnType<string, string, never>;
  /** null: about the instance, for those with `permission`. */
  project_id: ColumnType<string | null, string | null | undefined, never>;
  /** An instance item's reader: "projects" (the owner and admins) or "settings" (the owner). */
  permission: ColumnType<InboxPermission | null, InboxPermission | null | undefined, never>;
  /** The areas of the project a reader needs, each at view. */
  areas: ColumnType<string[], string[] | undefined, never>;
  /** A personal item's one reader; null for everyone the rest allows. */
  user_id: ColumnType<string | null, string | null | undefined, never>;
  title: ColumnType<string, string, never>;
  /** The dashboard's path, with its query. */
  link: ColumnType<string, string, never>;
  /** The channel notification it mirrors: one item per source. */
  source_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** Which inbox items a user has read; none: unread. */
export interface NotificationReadsTable {
  user_id: string;
  notification_id: string;
  read_at: ColumnType<Date, Date | undefined, Date>;
}

/** Who is on an error group (errors/assignments.ts): one person at most. */
export interface ErrorAssignmentsTable {
  project_id: string;
  fingerprint: string;
  assignee_id: string;
  /** Who assigned it; null once that user is deleted. */
  assigned_by: Nullable<string>;
  assigned_at: ColumnType<Date, Date | undefined, Date>;
  /** The resolution whose regression the assignee was told of. */
  regression_told_for: Nullable<Date>;
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
  ai_cost_windows: AiCostWindowsTable;
  ai_cost_hours: AiCostHoursTable;
  ai_model_prices: AiModelPricesTable;
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
  heatmap_overlay_tokens: HeatmapOverlayTokensTable;
  heatmap_snapshots: HeatmapSnapshotsTable;
  ingest_activity: IngestActivityTable;
  dashboard_member_access: DashboardMemberAccessTable;
  dashboard_member_projects: DashboardMemberProjectsTable;
  dashboard_invitations: DashboardInvitationsTable;
  dashboard_password_resets: DashboardPasswordResetsTable;
  account_emails: AccountEmailsTable;
  overview_layouts: OverviewLayoutsTable;
  project_stars: ProjectStarsTable;
  location_data_updates: LocationDataUpdatesTable;
  location_data_lease: LocationDataLeaseTable;
  storage_warning_channels: StorageWarningChannelsTable;
  storage_warnings: StorageWarningsTable;
  first_seen_rebuilds: FirstSeenRebuildsTable;
  backup_settings: BackupSettingsTable;
  backup_runs: BackupRunsTable;
  notifications: NotificationsTable;
  notification_reads: NotificationReadsTable;
  error_assignments: ErrorAssignmentsTable;
}
