import type { Kysely } from "kysely";

import type { UserAccess } from "../access/access.ts";
import { type Area, reaches } from "../access/areas.ts";
import type { Database } from "../db/schema.ts";

/**
 * Each widget requires its area both in the layout and data route
 * (routes.ts), preventing unauthorized reads (docs/dashboard.md, "Overview").
 */
export const WIDGETS = [
  { id: "attention", area: "uptime_alerts" },
  { id: "errors", area: "errors" },
  { id: "uptime", area: "uptime_alerts" },
  { id: "services", area: "monitoring" },
  { id: "ai-cost", area: "ai" },
  { id: "speed", area: "web_analytics" },
  { id: "main-goal", area: "product_analytics" },
  { id: "traffic", area: "web_analytics" },
  { id: "goals", area: "product_analytics" },
  { id: "users", area: "product_analytics" },
  { id: "sources", area: "web_analytics" },
] as const satisfies readonly { id: string; area: Area }[];

export type WidgetId = (typeof WIDGETS)[number]["id"];
export const WIDGET_IDS: readonly WidgetId[] = WIDGETS.map((widget) => widget.id);

const isWidgetId = (id: string): id is WidgetId => (WIDGET_IDS as readonly string[]).includes(id);

export function visibleWidgets(access: UserAccess): WidgetId[] {
  return WIDGETS.filter((widget) => reaches(access.areas[widget.area], "view")).map(
    (widget) => widget.id,
  );
}

export interface Layout {
  widgets: { id: WidgetId; hidden: boolean }[];
  /** Whether this is the default layout: the user saved none, or reset theirs. */
  isDefault: boolean;
}

/**
 * Keep known IDs once each. Insert missing widgets after their default
 * predecessor, or first, so saved layouts include newly available widgets.
 */
export function completeOrder(stored: readonly string[]): WidgetId[] {
  const order = [...new Set(stored)].filter(isWidgetId);
  WIDGET_IDS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = WIDGET_IDS.slice(0, index).findLast((earlier) => order.includes(earlier));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  return order;
}

function layoutOf(
  access: UserAccess,
  stored: { widgets: string[]; hidden: string[] } | undefined,
): Layout {
  const visible = new Set(visibleWidgets(access));
  const hidden = new Set(stored?.hidden ?? []);
  return {
    widgets: completeOrder(stored?.widgets ?? [])
      .filter((id) => visible.has(id))
      .map((id) => ({ id, hidden: hidden.has(id) })),
    isDefault: stored === undefined,
  };
}

export async function readLayout(
  db: Kysely<Database>,
  access: UserAccess,
  projectId: string,
): Promise<Layout> {
  const row = await db
    .selectFrom("overview_layouts")
    .select(["widgets", "hidden"])
    .where("user_id", "=", access.userId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
  return layoutOf(access, row);
}

/**
 * Preserve omitted and inaccessible widgets through completeOrder,
 * so permission changes do not erase their saved positions.
 */
export async function saveLayout(
  db: Kysely<Database>,
  access: UserAccess,
  projectId: string,
  layout: { order: readonly WidgetId[]; hidden: readonly WidgetId[] },
): Promise<Layout> {
  // Lock the user row to serialize saves. Each reads the previous save,
  // and the last save wins.
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("dashboard_users")
      .select("id")
      .where("id", "=", access.userId)
      .forUpdate()
      .executeTakeFirst();
    const stored = await trx
      .selectFrom("overview_layouts")
      .select(["widgets", "hidden"])
      .where("user_id", "=", access.userId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    const storedOrder = completeOrder(stored?.widgets ?? []);
    const sent = new Set(layout.order);
    const merged: WidgetId[] = [...sent];
    storedOrder.forEach((id, index) => {
      if (sent.has(id)) return;
      const before = storedOrder.slice(0, index).findLast((earlier) => merged.includes(earlier));
      merged.splice(before === undefined ? 0 : merged.indexOf(before) + 1, 0, id);
    });
    const visible = new Set(visibleWidgets(access));
    const hidden = [
      ...new Set([
        ...layout.hidden,
        // A widget the user cannot see now stays hidden if it was.
        ...(stored?.hidden ?? []).filter(
          (id): id is WidgetId => isWidgetId(id) && !visible.has(id),
        ),
      ]),
    ];
    const values = { widgets: merged, hidden, updated_at: new Date() };
    await trx
      .insertInto("overview_layouts")
      .values({ user_id: access.userId, project_id: projectId, ...values })
      .onConflict((conflict) => conflict.columns(["user_id", "project_id"]).doUpdateSet(values))
      .execute();
    return layoutOf(access, { widgets: merged, hidden });
  });
}

export async function resetLayout(
  db: Kysely<Database>,
  access: UserAccess,
  projectId: string,
): Promise<Layout> {
  await db
    .deleteFrom("overview_layouts")
    .where("user_id", "=", access.userId)
    .where("project_id", "=", projectId)
    .execute();
  return layoutOf(access, undefined);
}
