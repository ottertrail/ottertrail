import type { Kysely, Selectable } from "kysely";

import type { Database, GoalsTable } from "../db/schema.ts";
import type { Step } from "../product/steps.ts";

/**
 * Goals use funnel steps and are counted by reports/analytics.ts
 * (docs/product-analytics.md, "Goals").
 */
export interface Goal {
  id: string;
  name: string;
  step: Step;
  createdAt: Date;
}

export const MAX_GOALS = 20;

function goalOf(row: Selectable<GoalsTable>): Goal {
  const step: Step =
    row.kind === "page"
      ? { type: "page", path: row.path ?? "" }
      : {
          type: "event",
          name: row.event_name ?? "",
          ...(row.filter_key === null || row.filter_value === null
            ? {}
            : { filter: { key: row.filter_key, value: row.filter_value } }),
        };
  return { id: row.id, name: row.name, step, createdAt: row.created_at };
}

export async function listGoals(db: Kysely<Database>, projectId: string): Promise<Goal[]> {
  const rows = await db
    .selectFrom("goals")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map(goalOf);
}

/** PostgreSQL's unique_violation: here, a name the project's goals already have. */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

/** Refuse duplicate names and projects at MAX_GOALS. */
export async function createGoal(
  db: Kysely<Database>,
  projectId: string,
  name: string,
  step: Step,
): Promise<{ goal: Goal } | { refused: "too_many" | "name_taken" }> {
  try {
    return await db.transaction().execute(async (trx) => {
      // Serialize project inserts so concurrent requests cannot exceed the limit.
      await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .forUpdate()
        .executeTakeFirst();
      const { count } = await trx
        .selectFrom("goals")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("project_id", "=", projectId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_GOALS) return { refused: "too_many" as const };
      const row = await trx
        .insertInto("goals")
        .values({
          project_id: projectId,
          name,
          kind: step.type,
          path: step.type === "page" ? step.path : null,
          event_name: step.type === "event" ? step.name : null,
          filter_key: step.type === "event" ? (step.filter?.key ?? null) : null,
          filter_value: step.type === "event" ? (step.filter?.value ?? null) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { goal: goalOf(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { refused: "name_taken" };
    throw error;
  }
}

/** Return false if the project has no matching goal. */
export async function deleteGoal(
  db: Kysely<Database>,
  projectId: string,
  goalId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom("goals")
    .where("project_id", "=", projectId)
    .where("id", "=", goalId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
