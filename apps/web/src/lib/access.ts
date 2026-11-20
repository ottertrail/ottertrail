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
export type Permission = "settings" | "ownership" | "members" | "channels" | "projects";
export type Areas = Record<Area, AreaLevel>;

/** The levels each area takes: an area with nothing to change has no "manage". */
export const AREA_LEVELS: Record<Area, readonly AreaLevel[]> = {
  web_analytics: ["none", "view"],
  product_analytics: ["none", "view", "manage"],
  errors: ["none", "view", "manage"],
  replays: ["none", "view"],
  users: ["none", "view"],
  monitoring: ["none", "view"],
  uptime_alerts: ["none", "view", "manage"],
};

/** Each area's name, and the pages it covers, as the Members page shows them. */
export const AREA_LABELS: Record<Area, { name: string; pages: string }> = {
  web_analytics: { name: "Web analytics", pages: "Analytics, Speed, and Heatmaps" },
  product_analytics: { name: "Product analytics", pages: "Events, funnels, goals, retention" },
  errors: { name: "Errors", pages: "Errors and occurrences" },
  replays: { name: "Replays", pages: "Session replays, which show individual people" },
  users: { name: "Users", pages: "Identified end users and their activity" },
  monitoring: { name: "Monitoring", pages: "Traces, logs, metrics, services, databases, hosts" },
  uptime_alerts: { name: "Uptime and alerts", pages: "Uptime checks and alert rules" },
};

/** Presets that fill in a member's areas (apps/api/src/access/areas.ts has the same). */
export const PRESETS = {
  viewer: {
    web_analytics: "view",
    product_analytics: "view",
    errors: "view",
    replays: "none",
    users: "none",
    monitoring: "view",
    uptime_alerts: "view",
  },
  engineering: {
    web_analytics: "view",
    product_analytics: "view",
    errors: "manage",
    replays: "view",
    users: "none",
    monitoring: "view",
    uptime_alerts: "manage",
  },
  marketing: {
    web_analytics: "view",
    product_analytics: "manage",
    errors: "none",
    replays: "none",
    users: "none",
    monitoring: "none",
    uptime_alerts: "none",
  },
} as const satisfies Record<string, Areas>;
export type Preset = keyof typeof PRESETS | "custom";
export const PRESET_NAMES = ["viewer", "engineering", "marketing"] as const;

/** The preset these areas match, or "custom". */
export function presetOf(areas: Areas): Preset {
  const found = PRESET_NAMES.find((preset) =>
    AREAS.every((area) => PRESETS[preset][area] === areas[area]),
  );
  return found ?? "custom";
}

export interface Me {
  /** `avatarUrl`: the user's avatar, or null for their initials. */
  user: { id: string; name: string; email: string; role: Role; avatarUrl: string | null };
  /** The instance's name, its timezone, which reports count days in, and its icon (or null). */
  instance: { name: string; timeZone: string; avatarUrl: string | null };
  access: { projects: "all" | string[]; areas: Record<Area, AreaLevel> };
  permissions: Record<Permission, boolean>;
  /** Whether avatars can be uploaded: the instance has object storage. */
  avatarUploads: boolean;
}

const isUrlOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isLevel = (value: unknown): value is AreaLevel =>
  value === "none" || value === "view" || value === "manage";
const isRole = (value: unknown): value is Role =>
  value === "owner" || value === "admin" || value === "member";

const isAreas = (value: unknown): value is Me["access"]["areas"] =>
  isRecord(value) && AREAS.every((area) => isLevel(value[area]));

const isPermissions = (value: unknown): value is Me["permissions"] =>
  isRecord(value) &&
  (["settings", "ownership", "members", "channels", "projects"] as const).every(
    (permission) => typeof value[permission] === "boolean",
  );

const isMe = (value: unknown): value is Me =>
  isRecord(value) &&
  isRecord(value.user) &&
  isText(value.user.id) &&
  isText(value.user.name) &&
  isText(value.user.email) &&
  isRole(value.user.role) &&
  isUrlOrNull(value.user.avatarUrl) &&
  isRecord(value.instance) &&
  isText(value.instance.name) &&
  isText(value.instance.timeZone) &&
  isUrlOrNull(value.instance.avatarUrl) &&
  typeof value.avatarUploads === "boolean" &&
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

/**
 * The areas the overview's widgets need (apps/web/src/lib/overview-api.ts,
 * WIDGETS): a user with none of them has nothing on the overview.
 */
export const OVERVIEW_AREAS: readonly Area[] = [
  "uptime_alerts",
  "errors",
  "monitoring",
  "web_analytics",
  "product_analytics",
];

/** Whether the overview has anything for this user. */
export const hasOverview = (me: Me | undefined) => OVERVIEW_AREAS.some((area) => canUse(me, area));

/**
 * The page a project opens on: its overview when the user has one of its
 * areas, otherwise the first page they may open; null when they have no area.
 */
export function firstPage(me: Me) {
  if (hasOverview(me)) return "/projects/$projectId/overview" as const;
  return AREA_PAGES.find(([area]) => canUse(me, area))?.[1] ?? null;
}
