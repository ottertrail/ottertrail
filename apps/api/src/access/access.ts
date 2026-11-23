import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { avatarUrlOf } from "../avatars/avatars.ts";
import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import {
  ALL_AREAS,
  AREAS,
  type Area,
  type Areas,
  hasPermission,
  type Permission,
  PERMISSIONS,
  reaches,
  type Role,
} from "./areas.ts";
import { isOverlayToken, overlaySessionUser } from "./overlay-tokens.ts";

/** What one dashboard user may reach, read from the database on each request. */
export interface UserAccess {
  userId: string;
  role: Role;
  /** "all" includes projects created later. */
  projects: "all" | readonly string[];
  areas: Areas;
}

/** Set by requireProjectAccess before project route handlers run. */
export interface ProjectAccess {
  projectId: string;
  timeZone: string;
  /** The user's role and grants, for a route that shows less to some users. */
  user: UserAccess;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireProjectAccess on the routes that use it. */
    projectAccess: ProjectAccess | null;
    /** Set by requireProjectAccess and requirePermission. */
    userAccess: UserAccess | null;
  }
}

export type ProjectNeed =
  /** An area, at a level: a member needs it granted. */
  | { area: Area; level: "view" | "manage" }
  /** An instance permission: the project's keys and settings need "projects". */
  | { permission: Permission }
  /** Only the project itself, such as its name. */
  | "project";

export type InstanceNeed = Permission | "signed_in";

/** What a route declares, read by the test that walks every route (tests/access-routes.test.ts). */
export type AccessDeclaration =
  | { scope: "project"; need: ProjectNeed }
  | { scope: "instance"; need: InstanceNeed }
  /** A heatmap overlay read: an overlay session token in place of the cookie, for one project. */
  | { scope: "overlay"; need: ProjectNeed };

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Each guard's declaration, for the test that walks every route (tests/access-routes.test.ts). */
const declarations = new WeakMap<object, AccessDeclaration>();

export function declarationOf(handler: object): AccessDeclaration | undefined {
  return declarations.get(handler);
}

export const NOT_FOUND = { error: "not_found", message: "No project has this ID." } as const;
export const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
} as const;
const UNAUTHORIZED = { error: "unauthorized", message: "Sign in to continue." } as const;

/**
 * Rereads role and grants. Members without dashboard_member_access have no
 * access; owner and admins reach all projects and areas. Missing users return null.
 */
export async function readUserAccess(
  db: Kysely<Database>,
  userId: string,
): Promise<UserAccess | null> {
  const row = await db
    .selectFrom("dashboard_users")
    .leftJoin("dashboard_member_access", "dashboard_member_access.user_id", "dashboard_users.id")
    .select([
      "dashboard_users.role",
      "dashboard_member_access.user_id as grant_user_id",
      "dashboard_member_access.all_projects",
      ...AREAS.map((area) => `dashboard_member_access.${area}` as const),
    ])
    .where("dashboard_users.id", "=", userId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  if (row.role !== "member") {
    return { userId, role: row.role, projects: "all", areas: ALL_AREAS };
  }
  const areas: Areas = {
    web_analytics: row.web_analytics ?? "none",
    product_analytics: row.product_analytics ?? "none",
    errors: row.errors ?? "none",
    replays: row.replays ?? "none",
    users: row.users ?? "none",
    monitoring: row.monitoring ?? "none",
    ai: row.ai ?? "none",
    uptime_alerts: row.uptime_alerts ?? "none",
  };
  if (row.grant_user_id === null) {
    return { userId, role: "member", projects: [], areas };
  }
  if (row.all_projects === true) {
    return { userId, role: "member", projects: "all", areas };
  }
  const projects = await db
    .selectFrom("dashboard_member_projects")
    .select("project_id")
    .where("user_id", "=", userId)
    .execute();
  return { userId, role: "member", projects: projects.map((p) => p.project_id), areas };
}

export function canReachProject(access: UserAccess, projectId: string): boolean {
  return access.projects === "all" || access.projects.includes(projectId);
}

/** manage includes view. */
export function canUse(access: UserAccess, area: Area, level: "view" | "manage"): boolean {
  return reaches(access.areas[area], level);
}

export function can(access: UserAccess, permission: Permission): boolean {
  return hasPermission(access.role, permission);
}

/** For SQL-filtered lists such as notifications/inbox.ts, avoiding per-row checks. */
export interface Reach {
  userId: string;
  projects: "all" | readonly string[];
  areas: Area[];
  permissions: Permission[];
}

const isPermission = (key: string): key is Permission => Object.hasOwn(PERMISSIONS, key);

export function reachOf(access: UserAccess): Reach {
  return {
    userId: access.userId,
    projects: access.projects,
    areas: AREAS.filter((area) => canUse(access, area, "view")),
    permissions: Object.keys(PERMISSIONS)
      .filter(isPermission)
      .filter((permission) => can(access, permission)),
  };
}

/** Lists permitted assignees by name. Recheck each selection with checkProjectAccess. */
export async function usersWithArea(
  db: Kysely<Database>,
  projectId: string,
  area: Area,
  level: "view" | "manage",
): Promise<{ id: string; name: string; avatarUrl: string | null }[]> {
  const levels: ("view" | "manage")[] = level === "view" ? ["view", "manage"] : ["manage"];
  const rows = await db
    .selectFrom("dashboard_users as u")
    .leftJoin("dashboard_member_access as a", "a.user_id", "u.id")
    .select(["u.id", "u.name", "u.avatar_key"])
    .where((eb) =>
      eb.or([
        eb("u.role", "in", ["owner", "admin"]),
        eb.and([
          eb("u.role", "=", "member"),
          eb(`a.${area}`, "in", levels),
          eb.or([
            eb("a.all_projects", "=", true),
            eb.exists(
              eb
                .selectFrom("dashboard_member_projects as p")
                .select("p.project_id")
                .whereRef("p.user_id", "=", "u.id")
                .where("p.project_id", "=", projectId),
            ),
          ]),
        ]),
      ]),
    )
    .orderBy("u.name")
    .orderBy("u.id")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    avatarUrl: avatarUrlOf(row.avatar_key),
  }));
}

function meets(access: UserAccess, need: ProjectNeed): boolean {
  if (need === "project") return true;
  if ("permission" in need) return can(access, need.permission);
  return canUse(access, need.area, need.level);
}

function declare(guard: Guard, declaration: AccessDeclaration): Guard {
  declarations.set(guard, declaration);
  return guard;
}

export type ProjectCheck =
  | { ok: true; access: ProjectAccess }
  | {
      ok: false;
      status: 401 | 403 | 404;
      body: typeof UNAUTHORIZED | typeof NOT_FOUND | typeof FORBIDDEN;
    };

/**
 * What `userId` may do with `projectId` for `need`, read from the database
 * now: the one decision behind requireProjectAccess and
 * requireOverlayAccess, and the overlay's exchange.
 *
 * - The user no longer exists: 401.
 * - The project does not exist, or is not one the user may reach: 404,
 *   the same answer for both, so a member cannot tell the two apart.
 * - The project is reachable but the need is an area or permission the
 *   user lacks: 403.
 */
export async function checkProjectAccess(
  db: Kysely<Database>,
  userId: string,
  projectId: string,
  need: ProjectNeed,
): Promise<ProjectCheck> {
  const access = await readUserAccess(db, userId);
  if (access === null) {
    return { ok: false, status: 401, body: UNAUTHORIZED };
  }
  const project = await db
    .selectFrom("projects")
    .select("id")
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (project === undefined || !canReachProject(access, project.id)) {
    return { ok: false, status: 404, body: NOT_FOUND };
  }
  if (!meets(access, need)) {
    return { ok: false, status: 403, body: FORBIDDEN };
  }
  const { timeZone } = await readInstanceSettings(db);
  return { ok: true, access: { projectId: project.id, timeZone, user: access } };
}

/**
 * Run after requireSession on every /projects/:id route. Rereads role and grants
 * so changes apply on the next request. Fastify has already validated the UUID.
 * Returns 401 without a session; otherwise follows checkProjectAccess.
 */
export function requireProjectAccess(db: Kysely<Database>, need: ProjectNeed): Guard {
  return declare(
    async (request, reply) => {
      const user = request.dashboardUser;
      const { params } = request;
      const projectId =
        typeof params === "object" && params !== null && "id" in params ? params.id : undefined;
      if (user === null || typeof projectId !== "string") {
        // Fail closed if requireSession was not registered first.
        return reply.code(401).send(UNAUTHORIZED);
      }
      const checked = await checkProjectAccess(db, user.id, projectId, need);
      if (!checked.ok) {
        return reply.code(checked.status).send(checked.body);
      }
      request.userAccess = checked.access.user;
      request.projectAccess = checked.access;
      return undefined;
    },
    { scope: "project", need },
  );
}

export const OVERLAY_SESSION_ENDED = {
  error: "session_expired",
  message: "This heatmap session has ended. Open it again from the dashboard.",
} as const;

/**
 * The check on routes the heatmap overlay reads from a customer's site
 * (heatmaps/overlay-routes.ts), which take no cookie: an overlay session
 * token as `Authorization: Bearer <token>`, for the project in the route's
 * `projectId`. The token only names a user (access/overlay-tokens.ts); what
 * that user may do is decided as for the dashboard, by checkProjectAccess,
 * on every request, so a removed member, a revoked grant, or a deleted
 * project fails on the next read.
 *
 * - No session, a session for another project, or one that has ended: 401
 *   `session_expired`.
 * - Otherwise as checkProjectAccess answers.
 *
 * The header's shape is checked before this runs (the routes refuse a
 * malformed one before any database work).
 */
export function requireOverlayAccess(
  db: Kysely<Database>,
  need: ProjectNeed,
  { now = () => new Date() }: { now?: () => Date } = {},
): Guard {
  return declare(
    async (request, reply) => {
      const { params } = request;
      const projectId =
        typeof params === "object" && params !== null && "projectId" in params
          ? params.projectId
          : undefined;
      const token = bearerToken(request.headers.authorization);
      if (token === null || typeof projectId !== "string") {
        return reply.code(401).send(OVERLAY_SESSION_ENDED);
      }
      const userId = await overlaySessionUser(db, token, projectId, now());
      if (userId === null) {
        return reply.code(401).send(OVERLAY_SESSION_ENDED);
      }
      const checked = await checkProjectAccess(db, userId, projectId, need);
      if (!checked.ok) {
        return reply
          .code(checked.status)
          .send(checked.status === 401 ? OVERLAY_SESSION_ENDED : checked.body);
      }
      request.userAccess = checked.access.user;
      request.projectAccess = checked.access;
      return undefined;
    },
    { scope: "overlay", need },
  );
}

/** The token of an `Authorization: Bearer <token>` header with an overlay token's shape, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return isOverlayToken(token) ? token : null;
}

/**
 * Run after requireSession on dashboard routes outside projects. Missing
 * permissions return 403. signed_in routes must filter results to user access.
 */
export function requirePermission(db: Kysely<Database>, need: InstanceNeed): Guard {
  return declare(
    async (request, reply) => {
      const user = request.dashboardUser;
      if (user === null) {
        return reply.code(401).send(UNAUTHORIZED);
      }
      const access = await readUserAccess(db, user.id);
      if (access === null) {
        return reply.code(401).send(UNAUTHORIZED);
      }
      if (need !== "signed_in" && !can(access, need)) {
        return reply.code(403).send(FORBIDDEN);
      }
      request.userAccess = access;
      return undefined;
    },
    { scope: "instance", need },
  );
}

/** Requires an access guard to have run first. */
export function userAccessOf(request: FastifyRequest): UserAccess {
  if (request.userAccess === null) {
    throw new Error("requireProjectAccess or requirePermission must run before this route");
  }
  return request.userAccess;
}
