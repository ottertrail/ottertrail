import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

/** Matches the projects table's check (migration 0001_create_schema). */
export const MAX_ALLOWED_HOSTNAMES = 50;
export const MAX_PROJECT_NAME_LENGTH = 100;

/** A project as the dashboard sees it. */
export interface Project {
  id: string;
  name: string;
  /** Goes in the site's script tag. Public: it only lets a page send events. */
  publicKey: string;
  /** Sites whose pages may send events. Empty accepts nothing. */
  allowedHostnames: string[];
  createdAt: Date;
  /**
   * When the most recent event happened, or null before the first one. Set
   * as events are stored, at most once a minute (collection/last-event.ts).
   */
  lastEventAt: Date | null;
  /** Days of events kept; null keeps them forever. The worker deletes older ones. */
  retentionDays: number | null;
  /**
   * For the site's own server only: sends server-side events and signs user
   * IDs. Shown in the dashboard, never put in a page.
   */
  secretKey: string;
  /** Accept a browser's user ID only with a valid signature from the site's server. */
  requireSignedUserIds: boolean;
  /** Ignore browser events from cloud and hosting providers' addresses: nearly all are programs. */
  ignoreDataCenters: boolean;
  /** Session replays: "off", or "errors", recorded around errors (docs/session-replay.md). */
  replayMode: "off" | "errors";
}

/** The fewest and most days a project may keep its events; the database checks the same. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/**
 * The hostname to store for one entry of the allowed list, or null when it
 * is not a hostname. Browsers send the page's hostname in the Origin header
 * and the collection endpoint compares it exactly, so entries are stored the
 * way browsers write hostnames: lowercase, and internationalized names in
 * their ASCII form ("bücher.example" becomes "xn--bcher-kva.example").
 *
 * Only a bare hostname is accepted: no scheme, port, path, or wildcard.
 * Each subdomain is its own entry (www.example.com is not example.com).
 */
export function parseHostname(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "" || trimmed.length > 253 || /[\s/:@*?#\\[\]]/.test(trimmed)) {
    return null;
  }
  const url = URL.parse(`http://${trimmed}`);
  if (url === null || url.port !== "" || url.pathname !== "/") {
    return null;
  }
  return url.hostname;
}

export type HostnamesResult = { ok: true; hostnames: string[] } | { ok: false; message: string };

/** Parses and de-duplicates an allowed-hostname list, or says what is wrong. */
export function parseHostnames(raw: readonly string[]): HostnamesResult {
  const hostnames: string[] = [];
  for (const entry of raw) {
    const hostname = parseHostname(entry);
    if (hostname === null) {
      return {
        ok: false,
        message: `"${entry.slice(0, 100)}" is not a hostname. Enter hostnames only, such as example.com or www.example.com, without https:// or a path.`,
      };
    }
    if (!hostnames.includes(hostname)) {
      hostnames.push(hostname);
    }
  }
  if (hostnames.length > MAX_ALLOWED_HOSTNAMES) {
    return { ok: false, message: `A project allows at most ${MAX_ALLOWED_HOSTNAMES} hostnames.` };
  }
  return { ok: true, hostnames };
}

function baseQuery(db: Kysely<Database>) {
  return db
    .selectFrom("projects")
    .select([
      "projects.id",
      "projects.name",
      "projects.public_key",
      "projects.allowed_hostnames",
      "projects.created_at",
      "projects.retention_days",
      "projects.last_event_at",
      "projects.secret_key",
      "projects.require_signed_user_ids",
      "projects.ignore_data_centers",
      "projects.replay_mode",
    ]);
}

type ProjectRow = Awaited<ReturnType<ReturnType<typeof baseQuery>["executeTakeFirstOrThrow"]>>;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.public_key,
    allowedHostnames: row.allowed_hostnames,
    createdAt: row.created_at,
    lastEventAt: row.last_event_at,
    retentionDays: row.retention_days,
    secretKey: row.secret_key,
    requireSignedUserIds: row.require_signed_user_ids,
    ignoreDataCenters: row.ignore_data_centers,
    replayMode: row.replay_mode,
  };
}

/** The instance's projects, oldest first. */
export async function listProjects(db: Kysely<Database>): Promise<Project[]> {
  const rows = await baseQuery(db).orderBy("projects.created_at").orderBy("projects.id").execute();
  return rows.map(toProject);
}

/**
 * A project by ID. Routes call it only after requireProjectAccess
 * (access/access.ts) has checked the request.
 */
export async function findProject(db: Kysely<Database>, id: string): Promise<Project | null> {
  const row = await baseQuery(db).where("projects.id", "=", id).executeTakeFirst();
  return row === undefined ? null : toProject(row);
}

/** A new project. Checking that the user may add one is the caller's job. */
export async function createProject(
  db: Kysely<Database>,
  input: { name: string; allowedHostnames: string[] },
): Promise<Project> {
  const { id } = await db
    .insertInto("projects")
    .values({
      name: input.name,
      allowed_hostnames: input.allowedHostnames,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const project = await findProject(db, id);
  if (project === null) {
    throw new Error("The new project could not be read back");
  }
  return project;
}

/** Changes a project's settings; null when no project has this ID. */
export async function updateProject(
  db: Kysely<Database>,
  id: string,
  changes: {
    name?: string;
    allowedHostnames?: string[];
    retentionDays?: number | null;
    requireSignedUserIds?: boolean;
    ignoreDataCenters?: boolean;
    replayMode?: "off" | "errors";
  },
): Promise<Project | null> {
  const values = {
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.allowedHostnames === undefined
      ? {}
      : { allowed_hostnames: changes.allowedHostnames }),
    ...(changes.retentionDays === undefined ? {} : { retention_days: changes.retentionDays }),
    ...(changes.requireSignedUserIds === undefined
      ? {}
      : { require_signed_user_ids: changes.requireSignedUserIds }),
    ...(changes.ignoreDataCenters === undefined
      ? {}
      : { ignore_data_centers: changes.ignoreDataCenters }),
    ...(changes.replayMode === undefined ? {} : { replay_mode: changes.replayMode }),
  };
  if (Object.keys(values).length > 0) {
    const result = await db
      .updateTable("projects")
      .set(values)
      .where("id", "=", id)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      return null;
    }
  }
  return findProject(db, id);
}

/**
 * Deletes a project and, with it, all its data: PostgreSQL's rows at once
 * (the database cascades the delete), its events and telemetry in
 * ClickHouse within a minute, by the worker, which a trigger asks to
 * (project_deletions).
 * Returns the project's public key, or null when no project has this ID.
 */
export async function deleteProject(
  db: Kysely<Database>,
  id: string,
): Promise<{ publicKey: string } | null> {
  const row = await db
    .deleteFrom("projects")
    .where("id", "=", id)
    .returning("public_key")
    .executeTakeFirst();
  return row === undefined ? null : { publicKey: row.public_key };
}

/**
 * Gives a project a new public key; pages with the old one can no longer
 * send events. Returns the project and its old key, or null when no
 * project has this ID.
 */
export async function replacePublicKey(
  db: Kysely<Database>,
  id: string,
): Promise<{ project: Project; oldKey: string } | null> {
  const old = await db
    .selectFrom("projects")
    .select("public_key")
    .where("id", "=", id)
    .executeTakeFirst();
  if (old === undefined) {
    return null;
  }
  const result = await db
    .updateTable("projects")
    // The same form as the column's default.
    .set({ public_key: sql<string>`'pk_' || replace(gen_random_uuid()::text, '-', '')` })
    .where("id", "=", id)
    .executeTakeFirst();
  const project = result.numUpdatedRows === 0n ? null : await findProject(db, id);
  return project === null ? null : { project, oldKey: old.public_key };
}

/**
 * Gives a project a new server key; servers with the old one can no longer
 * send events, and user IDs signed with it no longer pass. Returns the
 * project, or null when no project has this ID.
 */
export async function replaceSecretKey(db: Kysely<Database>, id: string): Promise<Project | null> {
  const result = await db
    .updateTable("projects")
    // The same form as the column's default.
    .set({ secret_key: sql<string>`'sk_' || replace(gen_random_uuid()::text, '-', '')` })
    .where("id", "=", id)
    .executeTakeFirst();
  return result.numUpdatedRows === 0n ? null : findProject(db, id);
}
