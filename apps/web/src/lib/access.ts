import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { isRecord, isText } from "./telemetry-shapes";

/**
 * Who is signed in and what they may reach (docs/access.md), from GET
 * /api/me. The dashboard hides what the user cannot use; the API refuses
 * it regardless. The areas and permissions match the API's
 * (apps/api/src/access/areas.ts).
 */

export const AREAS = [
  "web_analytics",
  "product_analytics",
  "errors",
  "replays",
  "users",
  "monitoring",
  "uptime_alerts",
] as const;
export type Area = (typeof AREAS)[number];
export type AreaLevel = "none" | "view" | "manage";
export type Role = "owner" | "admin" | "member";
export type Permission = "settings" | "members" | "channels" | "projects";

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  /** The instance's name, and its timezone, which reports count days in. */
  instance: { name: string; timeZone: string };
  access: { projects: "all" | string[]; areas: Record<Area, AreaLevel> };
  permissions: Record<Permission, boolean>;
}

const isLevel = (value: unknown): value is AreaLevel =>
  value === "none" || value === "view" || value === "manage";
const isRole = (value: unknown): value is Role =>
  value === "owner" || value === "admin" || value === "member";

const isAreas = (value: unknown): value is Me["access"]["areas"] =>
  isRecord(value) && AREAS.every((area) => isLevel(value[area]));

const isPermissions = (value: unknown): value is Me["permissions"] =>
  isRecord(value) &&
  (["settings", "members", "channels", "projects"] as const).every(
    (permission) => typeof value[permission] === "boolean",
  );

const isMe = (value: unknown): value is Me =>
  isRecord(value) &&
  isRecord(value.user) &&
  isText(value.user.id) &&
  isText(value.user.name) &&
  isText(value.user.email) &&
  isRole(value.user.role) &&
  isRecord(value.instance) &&
  isText(value.instance.name) &&
  isText(value.instance.timeZone) &&
  isRecord(value.access) &&
  (value.access.projects === "all" ||
    (Array.isArray(value.access.projects) && value.access.projects.every(isText))) &&
  isAreas(value.access.areas) &&
  isPermissions(value.permissions);

export const meQuery = () =>
  queryOptions({
    queryKey: ["me"],
    queryFn: async ({ signal }) => expectShape(await apiRequest("/api/me", { signal }), isMe),
  });

const RANK: Record<AreaLevel, number> = { none: 0, view: 1, manage: 2 };

/** Whether the user has `area` at `level` or more; false until /api/me has loaded. */
export function canUse(me: Me | undefined, area: Area, level: "view" | "manage" = "view") {
  return me !== undefined && RANK[me.access.areas[area]] >= RANK[level];
}

/** Whether the user has the instance permission; false until /api/me has loaded. */
export function hasPermission(me: Me | undefined, permission: Permission) {
  return me?.permissions[permission] === true;
}

/** The signed-in user's access, and checks against it. Everything is false while it loads. */
export function useAccess() {
  const me = useQuery(meQuery());
  return {
    me: me.data,
    canUse: (area: Area, level: "view" | "manage" = "view") => canUse(me.data, area, level),
    can: (permission: Permission) => hasPermission(me.data, permission),
  };
}

/** What a project page needs: an area, or the project's settings (the "projects" permission). */
export type PageAccess = Area | "project_settings";

export function canOpen(me: Me | undefined, page: PageAccess) {
  return page === "project_settings" ? hasPermission(me, "projects") : canUse(me, page);
}

/** Each area's first page, in the project menu's order, for opening a project. */
export const AREA_PAGES = [
  ["web_analytics", "/projects/$projectId/web-analytics"],
  ["users", "/projects/$projectId/users"],
  ["errors", "/projects/$projectId/errors"],
  ["replays", "/projects/$projectId/replays"],
  ["monitoring", "/projects/$projectId/traces"],
  ["uptime_alerts", "/projects/$projectId/uptime"],
  ["product_analytics", "/projects/$projectId/product/events"],
] as const;

/** The first page of a project this user may open, or null when they have no area. */
export function firstPage(me: Me) {
  return AREA_PAGES.find(([area]) => canUse(me, area))?.[1] ?? null;
}
