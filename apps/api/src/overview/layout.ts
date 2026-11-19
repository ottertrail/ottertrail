import type { Kysely } from "kysely";

import type { UserAccess } from "../access/access.ts";
import { type Area, reaches } from "../access/areas.ts";
import type { Database } from "../db/schema.ts";

/**
 * The overview's widgets (docs/dashboard.md, "Overview"), in their default
 * order, each with the area a user needs to see it. A widget's data has a
 * route of its own (routes.ts), which checks that area: a user without it
 * neither sees the widget nor can ask for its numbers.
 */
export const WIDGETS = [
  { id: "attention", area: "uptime_alerts" },
  { id: "errors", area: "errors" },
  { id: "uptime", area: "uptime_alerts" },
  { id: "services", area: "monitoring" },
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

/** The widgets a user may see, by the areas they have. */
export function visibleWidgets(access: UserAccess): WidgetId[] {
  return WIDGETS.filter((widget) => reaches(access.areas[widget.area], "view")).map(
    (widget) => widget.id,
  );
}

export interface Layout {
  /** The widgets the user may see, in their order, each shown or hidden. */
  widgets: { id: WidgetId; hidden: boolean }[];
  /** Whether this is the default layout: the user saved none, or reset theirs. */
  isDefault: boolean;
}

/**
 * A stored order with every widget in it: known IDs once each, in the
 * stored order; a widget the order lacks (one added since, or one the user
 * could not see when they saved) goes right after the widget before it in
 * the default order, or first.
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

/** The user's layout of the project's overview: theirs, or the default. */
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
 * Saves the user's layout of the project's overview. The order may name
 * only some widgets: the others keep their place (completeOrder). Widgets
 * the user cannot see now keep their place too, so a layout saved before
 * an area was granted or taken still holds.
 */
export async function saveLayout(
  db: Kysely<Database>,
  access: UserAccess,
  projectId: string,
  layout: { order: readonly WidgetId[]; hidden: readonly WidgetId[] },
): Promise<Layout> {
  // One transaction, with the user's row locked first: two saves of the
  // same user's layout wait for each other, so each reads what the one
  // before it wrote, and the last to arrive wins whole.
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

/** Back to the default layout: the user's own is deleted. */
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
