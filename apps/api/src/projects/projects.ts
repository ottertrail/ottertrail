import { type Kysely, sql } from "kysely";

import { avatarUrlOf } from "../avatars/avatars.ts";
import type { Database } from "../db/schema.ts";

/** Matches the projects table's check (migration 0001_create_schema). */
export const MAX_ALLOWED_HOSTNAMES = 50;
export const MAX_PROJECT_NAME_LENGTH = 100;

export interface Project {
  id: string;
  name: string;
  /** Goes in the site's script tag. Public: it only lets a page send events. */
  publicKey: string;
  /** Sites whose pages may send events. Empty accepts nothing. */
  allowedHostnames: string[];
  createdAt: Date;
  /**
   * Updated at most once a minute as events are stored (collection/last-event.ts).
   * Null until the first event.
   */
  lastEventAt: Date | null;
  /** Days of events kept; null keeps them forever. The worker deletes older ones. */
  retentionDays: number | null;
  /** Server-side events and user-ID signatures only. Never expose in a page. */
  secretKey: string;
  requireSignedUserIds: boolean;
  ignoreDataCenters: boolean;
  /** Session replays: "off", or "errors", recorded around errors (docs/session-replay.md). */
  replayMode: "off" | "errors";
  /** Heatmaps: clicks and scroll depth from pages whose snippet asks (docs/web-analytics.md, "Heatmaps"). */
  heatmaps: boolean;
  /** The goal the overview's business figures start with, or null (docs/dashboard.md, "Overview"). */
  mainGoalId: string | null;
  /** Only project managers see these IP and CIDR blocks (blocked-addresses.ts). */
  blockedAddresses: string[];
  /** Domains whose referrals are ignored, with their subdomains (blocked-referrers.ts). Only those who manage projects see them. */
  blockedReferrers: string[];
  /**
   * What the dashboard shows for the project: its uploaded icon, else its
   * site's favicon (avatars/favicons.ts), else null for its initial.
   */
  avatarUrl: string | null;
  /** The uploaded icon alone, for the settings form; null without one. */
  iconUrl: string | null;
}

/** The fewest and most days a project may keep its events; the database checks the same. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/**
 * Store lowercase ASCII hostnames to match browser Origin values exactly.
 * Reject schemes, ports, paths, and wildcards. Each subdomain needs its own entry;
 * IDNs such as bücher.example become xn--bcher-kva.example.
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
      "projects.heatmaps",
      "projects.main_goal_id",
      "projects.blocked_addresses",
      "projects.blocked_referrers",
      "projects.avatar_key",
      "projects.favicon_key",
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
    heatmaps: row.heatmaps,
    mainGoalId: row.main_goal_id,
    blockedAddresses: row.blocked_addresses,
    blockedReferrers: row.blocked_referrers,
    avatarUrl: avatarUrlOf(row.avatar_key ?? row.favicon_key),
    iconUrl: avatarUrlOf(row.avatar_key),
  };
}

/** The instance's projects, oldest first. */
export async function listProjects(db: Kysely<Database>): Promise<Project[]> {
  const rows = await baseQuery(db).orderBy("projects.created_at").orderBy("projects.id").execute();
  return rows.map(toProject);
}

/** Call only after requireProjectAccess (access/access.ts). */
export async function findProject(db: Kysely<Database>, id: string): Promise<Project | null> {
  const row = await baseQuery(db).where("projects.id", "=", id).executeTakeFirst();
  return row === undefined ? null : toProject(row);
}

/** The caller must check permission to create projects. */
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

/** PostgreSQL's foreign_key_violation. */
const isForeignKeyViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23503";

/** Returns null for missing projects, or no_such_goal if the goal belongs elsewhere. */
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
    heatmaps?: boolean;
    mainGoalId?: string | null;
    /** Already checked and normalised (parseBlockedAddresses). */
    blockedAddresses?: string[];
    /** Already checked and normalised (parseBlockedReferrers). */
    blockedReferrers?: string[];
  },
): Promise<Project | null | "no_such_goal"> {
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
    ...(changes.heatmaps === undefined ? {} : { heatmaps: changes.heatmaps }),
    ...(changes.mainGoalId === undefined ? {} : { main_goal_id: changes.mainGoalId }),
    ...(changes.blockedAddresses === undefined
      ? {}
      : { blocked_addresses: changes.blockedAddresses }),
    ...(changes.blockedReferrers === undefined
      ? {}
      : { blocked_referrers: changes.blockedReferrers }),
  };
  if (Object.keys(values).length > 0) {
    try {
      const result = await db
        .updateTable("projects")
        .set(values)
        .where("id", "=", id)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        return null;
      }
    } catch (error) {
      // The main goal's foreign key: not one of this project's goals.
      if (isForeignKeyViolation(error)) return "no_such_goal";
      throw error;
    }
  }
  return findProject(db, id);
}

/**
 * PostgreSQL cascades immediately. A project_deletions trigger asks the worker
 * to remove ClickHouse events and telemetry within a minute. Returns the public
 * key, or null if the project does not exist.
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
 * Invalidates the old public key. Returns it with the updated project, or null
 * if the project does not exist.
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
 * Invalidates server access and user signatures made with the old secret.
 * Returns null if the project does not exist.
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
