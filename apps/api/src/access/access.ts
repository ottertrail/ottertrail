import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import {
  ALL_AREAS,
  AREAS,
  type Area,
  type Areas,
  hasPermission,
  type Permission,
  reaches,
  type Role,
} from "./areas.ts";

/** What one dashboard user may reach, read from the database on each request. */
export interface UserAccess {
  userId: string;
  role: Role;
  /** "all" includes projects created later. */
  projects: "all" | readonly string[];
  areas: Areas;
}

/**
 * What a signed-in user may reach of one project: set on the request by
 * requireProjectAccess before any project route runs.
 */
export interface ProjectAccess {
  projectId: string;
  /** The instance's timezone, which reports count days in. */
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

/** What a route on one project needs, besides the project being one the user may reach. */
export type ProjectNeed =
  /** An area, at a level: a member needs it granted. */
  | { area: Area; level: "view" | "manage" }
  /** An instance permission: the project's keys and settings need "projects". */
  | { permission: Permission }
  /** Only the project itself, such as its name. */
  | "project";

/** What an instance route needs: a permission, or only a signed-in user. */
export type InstanceNeed = Permission | "signed_in";

/** What a route declares, read by the test that walks every route (tests/access-routes.test.ts). */
export type AccessDeclaration =
  | { scope: "project"; need: ProjectNeed }
  | { scope: "instance"; need: InstanceNeed };

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Each guard's declaration, for the test that walks every route (tests/access-routes.test.ts). */
const declarations = new WeakMap<object, AccessDeclaration>();

/** What a preHandler declares, if it is one of these guards. */
export function declarationOf(handler: object): AccessDeclaration | undefined {
  return declarations.get(handler);
}

export const NOT_FOUND = { error: "not_found", message: "No project has this ID." } as const;
export const FORBIDDEN = { error: "forbidden", message: "You don't have access to this." } as const;
const UNAUTHORIZED = { error: "unauthorized", message: "Sign in to continue." } as const;

/**
 * A user's role and grants, or null when the user no longer exists. The
 * owner and admins reach every project and area; a member, what their row
 * in dashboard_member_access grants, and nothing without one.
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

/** Whether the user has `area` at `level` or more. */
export function canUse(access: UserAccess, area: Area, level: "view" | "manage"): boolean {
  return reaches(access.areas[area], level);
}

export function can(access: UserAccess, permission: Permission): boolean {
  return hasPermission(access.role, permission);
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

/**
 * The one check every route under /projects/:id runs, after requireSession.
 * Each route says what it needs. The user's role and grants are read from
 * the database on every request, so a change applies on the next one.
 *
 * - Not signed in: 401.
 * - The project does not exist, or is not one the user may reach: 404,
 *   the same answer for both, so a member cannot tell the two apart.
 * - The project is reachable but the route needs an area or permission
 *   the user lacks: 403.
 *
 * Fastify validates the route's params before this runs, so `id` is a UUID.
 */
export function requireProjectAccess(db: Kysely<Database>, need: ProjectNeed): Guard {
  return declare(
    async (request, reply) => {
      const user = request.dashboardUser;
      const { params } = request;
      const projectId =
        typeof params === "object" && params !== null && "id" in params ? params.id : undefined;
      if (user === null || typeof projectId !== "string") {
        // A route registered without requireSession first: refuse rather than guess.
        return reply.code(401).send(UNAUTHORIZED);
      }
      const access = await readUserAccess(db, user.id);
      if (access === null) {
        return reply.code(401).send(UNAUTHORIZED);
      }
      const project = await db
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (project === undefined || !canReachProject(access, project.id)) {
        return reply.code(404).send(NOT_FOUND);
      }
      if (!meets(access, need)) {
        return reply.code(403).send(FORBIDDEN);
      }
      const { timeZone } = await readInstanceSettings(db);
      request.userAccess = access;
      request.projectAccess = { projectId: project.id, timeZone, user: access };
      // Nothing sent: Fastify goes on to the route handler.
      return undefined;
    },
    { scope: "project", need },
  );
}

/**
 * The check every dashboard route outside a project runs, after
 * requireSession: the user has the permission, or the answer is 403.
 * "signed_in" lets every user through; such a route shows each user only
 * what they may reach (the project list, /api/me).
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

/** The access a guard set. Routes that call it always run one first. */
export function userAccessOf(request: FastifyRequest): UserAccess {
  if (request.userAccess === null) {
    throw new Error("requireProjectAccess or requirePermission must run before this route");
  }
  return request.userAccess;
}
