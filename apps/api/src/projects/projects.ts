import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

/** Matches the check in migration 0002. */
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
  /** When the most recent event happened, or null before the first one. */
  lastEventAt: Date | null;
}

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
  return db.selectFrom("projects").select((eb) => [
    "projects.id",
    "projects.name",
    "projects.public_key",
    "projects.allowed_hostnames",
    "projects.created_at",
    // Uses the (project_id, occurred_at) index: one lookup, not a scan.
    eb
      .selectFrom("events")
      .select(sql<Date | null>`max(occurred_at)`.as("max"))
      .whereRef("events.project_id", "=", "projects.id")
      .as("last_event_at"),
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
    lastEventAt: row.last_event_at ?? null,
  };
}

export async function listProjects(db: Kysely<Database>): Promise<Project[]> {
  const rows = await baseQuery(db).orderBy("projects.created_at").orderBy("projects.id").execute();
  return rows.map(toProject);
}

export async function findProject(db: Kysely<Database>, id: string): Promise<Project | null> {
  const row = await baseQuery(db).where("projects.id", "=", id).executeTakeFirst();
  return row === undefined ? null : toProject(row);
}

export async function createProject(
  db: Kysely<Database>,
  input: { name: string; allowedHostnames: string[] },
): Promise<Project> {
  const { id } = await db
    .insertInto("projects")
    .values({ name: input.name, allowed_hostnames: input.allowedHostnames })
    .returning("id")
    .executeTakeFirstOrThrow();
  const project = await findProject(db, id);
  if (project === null) {
    throw new Error("The new project could not be read back");
  }
  return project;
}

/** Changes a project's name or allowed hostnames; null when no project has this ID. */
export async function updateProject(
  db: Kysely<Database>,
  id: string,
  changes: { name?: string; allowedHostnames?: string[] },
): Promise<Project | null> {
  const values = {
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.allowedHostnames === undefined
      ? {}
      : { allowed_hostnames: changes.allowedHostnames }),
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
 * Deletes a project and, with it, all its events (the database cascades
 * the delete). Returns the project's public key, or null when no project
 * has this ID.
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
    // The same form as the column's default (migration 0002).
    .set({ public_key: sql<string>`'pk_' || replace(gen_random_uuid()::text, '-', '')` })
    .where("id", "=", id)
    .executeTakeFirst();
  const project = result.numUpdatedRows === 0n ? null : await findProject(db, id);
  return project === null ? null : { project, oldKey: old.public_key };
}
