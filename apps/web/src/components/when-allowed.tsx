import type * as React from "react";

import { type Area, type Permission, useAccess } from "@/lib/access";

/** Hide inaccessible controls (docs/access.md). The API checks access independently. */
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
