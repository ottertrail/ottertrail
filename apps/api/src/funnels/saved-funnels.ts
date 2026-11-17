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
 * A project's saved funnels (docs/product-analytics.md, "Saved funnels"):
 * a name for a funnel's steps, who it counts, and its window, so the
 * funnel page can open it again. The page's period and environment are
 * not part of it.
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

/** What a saved funnel holds besides its ID and times: checked before it gets here. */
export interface FunnelDefinition {
  name: string;
  steps: readonly FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}

/** Saved funnels a project may have: a list to pick from, kept within one screen or two. */
export const MAX_SAVED_FUNNELS = 50;

function savedFunnelOf(row: Selectable<SavedFunnelsTable>): SavedFunnel {
  return {
    id: row.id,
    name: row.name,
    // Both checked when saved. Should a later rule refuse what a row holds,
    // it reads as no steps, or the default window, and the row keeps it:
    // a change of rules comes with a migration for saved funnels.
    steps: funnelStepsOf(row.steps) ?? [],
    count: row.count_by,
    window: FUNNEL_WINDOWS.find((seconds) => seconds === row.window_seconds) ?? MAX_VISITOR_WINDOW,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const columnsOf = (definition: FunnelDefinition) => ({
  name: definition.name,
  // As JSON text: the driver would write a JavaScript array as a
  // PostgreSQL array.
  steps: JSON.stringify(definition.steps),
  count_by: definition.count,
  window_seconds: definition.window,
});

/** A project's saved funnels, by name: as a list to pick one from. */
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

/** Saves a funnel; or says why not: the project has MAX_SAVED_FUNNELS, or one with this name. */
export async function createSavedFunnel(
  db: Kysely<Database>,
  projectId: string,
  definition: FunnelDefinition,
): Promise<{ funnel: SavedFunnel } | { refused: "too_many" | "name_taken" }> {
  try {
    return await db.transaction().execute(async (trx) => {
      // Saves to one project wait for each other here, so two at once
      // cannot both find room for the last funnel.
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
 * Replaces one of the project's saved funnels, its name and what it
 * counts, if it is still the version read (`readUpdatedAt`): a change made
 * from an older copy would undo another one, made since, without a word.
 * Null when the project has no funnel with this ID.
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

/** Deletes one of the project's saved funnels; false when it has none with this ID. */
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
