import { type Kysely, type Selectable, sql } from "kysely";

import type { Database, SavedFunnelsTable } from "../db/schema.ts";
import {
  FUNNEL_WINDOWS,
  type FunnelCount,
  type FunnelStep,
  funnelStepsOf,
  type FunnelWindow,
  MAX_VISITOR_WINDOW,
} from "../product/funnel.ts";

/**
 * Save steps, count type, and conversion window; omit page period and
 * environment (docs/product-analytics.md, "Saved funnels").
 */
export interface SavedFunnel {
  id: string;
  name: string;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
  createdAt: Date;
  updatedAt: Date;
}

export interface FunnelDefinition {
  name: string;
  steps: readonly FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}

export const MAX_SAVED_FUNNELS = 50;

function savedFunnelOf(row: Selectable<SavedFunnelsTable>): SavedFunnel {
  return {
    id: row.id,
    name: row.name,
    // Invalid stored values fall back without changing the row. Validation
    // rule changes need a saved-funnel migration.
    steps: funnelStepsOf(row.steps) ?? [],
    count: row.count_by,
    window: FUNNEL_WINDOWS.find((seconds) => seconds === row.window_seconds) ?? MAX_VISITOR_WINDOW,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const columnsOf = (definition: FunnelDefinition) => ({
  name: definition.name,
  // Serialize JSON explicitly; the driver treats JavaScript arrays as PostgreSQL arrays.
  steps: JSON.stringify(definition.steps),
  count_by: definition.count,
  window_seconds: definition.window,
});

export async function listSavedFunnels(
  db: Kysely<Database>,
  projectId: string,
): Promise<SavedFunnel[]> {
  const rows = await db
    .selectFrom("saved_funnels")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy(sql`lower(name)`)
    .orderBy("name")
    .orderBy("id")
    .execute();
  return rows.map(savedFunnelOf);
}

/** PostgreSQL's unique_violation: here, a name the project's funnels already have. */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

/** Refuse duplicate names and projects at MAX_SAVED_FUNNELS. */
export async function createSavedFunnel(
  db: Kysely<Database>,
  projectId: string,
  definition: FunnelDefinition,
): Promise<{ funnel: SavedFunnel } | { refused: "too_many" | "name_taken" }> {
  try {
    return await db.transaction().execute(async (trx) => {
      // Serialize project saves so concurrent requests cannot exceed the limit.
      await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .forUpdate()
        .executeTakeFirst();
      const { count } = await trx
        .selectFrom("saved_funnels")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("project_id", "=", projectId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_SAVED_FUNNELS) return { refused: "too_many" as const };
      const row = await trx
        .insertInto("saved_funnels")
        .values({ project_id: projectId, ...columnsOf(definition) })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { funnel: savedFunnelOf(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { refused: "name_taken" };
    throw error;
  }
}

/**
 * Require readUpdatedAt to prevent overwriting a newer edit. Return null
 * if the project has no matching funnel.
 */
export async function updateSavedFunnel(
  db: Kysely<Database>,
  projectId: string,
  funnelId: string,
  readUpdatedAt: Date,
  definition: FunnelDefinition,
): Promise<{ funnel: SavedFunnel } | { refused: "name_taken" | "changed" } | null> {
  try {
    const row = await db
      .updateTable("saved_funnels")
      .set({
        ...columnsOf(definition),
        // Later than the version replaced, even within its millisecond.
        updated_at: sql<Date>`greatest(date_trunc('milliseconds', now()), updated_at + interval '1 millisecond')`,
      })
      .where("project_id", "=", projectId)
      .where("id", "=", funnelId)
      .where("updated_at", "=", readUpdatedAt)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return { funnel: savedFunnelOf(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { refused: "name_taken" };
    throw error;
  }
  const exists = await db
    .selectFrom("saved_funnels")
    .select("id")
    .where("project_id", "=", projectId)
    .where("id", "=", funnelId)
    .executeTakeFirst();
  return exists === undefined ? null : { refused: "changed" };
}

/** Return false if the project has no matching funnel. */
export async function deleteSavedFunnel(
  db: Kysely<Database>,
  projectId: string,
  funnelId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom("saved_funnels")
    .where("project_id", "=", projectId)
    .where("id", "=", funnelId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
