import type { AreaLevel, Role } from "../db/schema.ts";

export type { AreaLevel, Role };

/**
 * The areas of a project a member is granted, each none, view, or manage
 * (docs/access.md). The dashboard has the same list (apps/web/src/lib/access.ts).
 */
export const AREAS = [
  "web_analytics",
  "product_analytics",
  "errors",
  "replays",
  "users",
  "monitoring",
  "ai",
  "uptime_alerts",
] as const;
export type Area = (typeof AREAS)[number];

/** The levels each area takes: an area with nothing to change has no "manage". */
export const AREA_LEVELS: Record<Area, readonly AreaLevel[]> = {
  web_analytics: ["none", "view"],
  product_analytics: ["none", "view", "manage"],
  errors: ["none", "view", "manage"],
  replays: ["none", "view"],
  users: ["none", "view"],
  monitoring: ["none", "view"],
  ai: ["none", "view"],
  uptime_alerts: ["none", "view", "manage"],
};

/** A level for each area; those with nothing to change stop at view. */
export interface Areas {
  web_analytics: "none" | "view";
  product_analytics: AreaLevel;
  errors: AreaLevel;
  replays: "none" | "view";
  users: "none" | "view";
  monitoring: "none" | "view";
  ai: "none" | "view";
  uptime_alerts: AreaLevel;
}

/** The most each area takes: what the owner and admins have. */
export const ALL_AREAS: Areas = {
  web_analytics: "view",
  product_analytics: "manage",
  errors: "manage",
  replays: "view",
  users: "view",
  monitoring: "view",
  ai: "view",
  uptime_alerts: "manage",
};

/** Presets that fill in a member's areas when inviting or editing; "custom" is any other mix. */
export const PRESETS = {
  viewer: {
    web_analytics: "view",
    product_analytics: "view",
    errors: "view",
    replays: "none",
    users: "none",
    monitoring: "view",
    ai: "view",
    uptime_alerts: "view",
  },
  engineering: {
    web_analytics: "view",
    product_analytics: "view",
    errors: "manage",
    replays: "view",
    users: "none",
    monitoring: "view",
    ai: "view",
    uptime_alerts: "manage",
  },
  marketing: {
    web_analytics: "view",
    product_analytics: "manage",
    errors: "none",
    replays: "none",
    users: "none",
    monitoring: "none",
    ai: "none",
    uptime_alerts: "none",
  },
} as const satisfies Record<string, Areas>;

/**
 * What instance routes need, by role. Settings: the instance's name and
 * timezone. Members: the Members page. Channels: notification channels.
 * Projects: creating, changing, and deleting projects, their keys and
 * settings. Ownership: handing it to another user.
 */
export const PERMISSIONS = {
  settings: ["owner"],
  ownership: ["owner"],
  members: ["owner", "admin"],
  channels: ["owner", "admin"],
  projects: ["owner", "admin"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

const LEVEL_RANK: Record<AreaLevel, number> = { none: 0, view: 1, manage: 2 };

/** Whether `level` reaches `needed`: manage includes view. */
export function reaches(level: AreaLevel, needed: "view" | "manage"): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[needed];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
