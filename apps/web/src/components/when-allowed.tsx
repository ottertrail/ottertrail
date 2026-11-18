import type * as React from "react";

import { type Area, type Permission, useAccess } from "@/lib/access";

/**
 * Shows its children only to a user with the area (at `level`, view by
 * default) or the permission; others see `fallback`, or nothing. For links
 * from one area's page into another (docs/access.md). The API refuses
 * regardless; this only hides what would be refused.
 */
export function WhenAllowed({
  area,
  level = "view",
  permission,
  fallback = null,
  children,
}: (
  | { area: Area; level?: "view" | "manage"; permission?: never }
  | { permission: Permission; area?: never; level?: never }
) & { fallback?: React.ReactNode; children: React.ReactNode }) {
  const access = useAccess();
  const allowed = permission === undefined ? access.canUse(area, level) : access.can(permission);
  return allowed ? children : fallback;
}
