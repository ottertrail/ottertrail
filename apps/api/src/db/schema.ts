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

/** One customer. Owns projects; dashboard users reach it through memberships. */
export interface OrganizationsTable {
  id: ColumnType<string, string | undefined, never>;
  name: string;
  /**
   * IANA timezone, such as "Asia/Singapore". Reports count days in it, and
   * visitor salts change at its midnight.
   */
  time_zone: string;
  created_at: DatabaseDefault<Date>;
}

export type MembershipRole = "owner" | "member";

export interface MembershipsTable {
  organization_id: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  role: MembershipRole;
  created_at: DatabaseDefault<Date>;
}

export interface ProjectsTable {
  id: ColumnType<string, string | undefined, never>;
  /** The organization that owns the project. Never changes. */
  organization_id: ColumnType<string, string, never>;
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
   * server-side events and signs user IDs (migration 0016).
   */
  secret_key: ColumnType<string, string | undefined, string>;
  /** Accept a browser's user ID only with a valid signature from the site's server. */
  require_signed_user_ids: ColumnType<boolean, boolean | undefined, boolean>;
  /** Ignore browser events from cloud and hosting providers' addresses (migration 0017). */
  ignore_data_centers: ColumnType<boolean, boolean | undefined, boolean>;
  /** Session replays: "off", or "errors", around errors (migration 0023). */
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

/** A project's saved conversion: a page or a product event (migration 0020). */
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

/** A project's named funnel (migration 0021). */
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

/** A piece of a session replay as a browser sent it: one gzip member (migration 0023). */
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

/** A session replay, joined from its chunks into one object (migration 0023). */
export interface ReplaysTable {
  project_id: string;
  replay_id: string;
  /** Where it is, gzip-compressed JSON, in the object store. */
  object_key: string;
  /** Its stored, compressed size. */
  bytes: number;
  cut: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** A source map a project uploaded, for one release and minified file (migration 0022). */
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

/** An error group a project's team marked resolved (migration 0019). No row: unresolved. */
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
   * whole install; "member" otherwise. Roles inside an organization are in
   * memberships.
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
  organizations: OrganizationsTable;
  memberships: MembershipsTable;
  projects: ProjectsTable;
  project_deletions: ProjectDeletionsTable;
  error_resolutions: ErrorResolutionsTable;
  goals: GoalsTable;
  saved_funnels: SavedFunnelsTable;
  source_maps: SourceMapsTable;
  replay_chunks: ReplayChunksTable;
  replays: ReplaysTable;
  visitor_salts: VisitorSaltsTable;
  dashboard_users: DashboardUsersTable;
  dashboard_sessions: DashboardSessionsTable;
  dashboard_accounts: DashboardAccountsTable;
  owner_setup_tokens: OwnerSetupTokensTable;
}
