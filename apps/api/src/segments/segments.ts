import { type Kysely, type Selectable, sql } from "kysely";

import type { Database, SegmentsTable } from "../db/schema.ts";
import { type FilterQuery, filterQueryOf } from "../reports/routes.ts";

/**
 * Saved segments (docs/web-analytics.md, "Segments"): named Web analytics
 * filters, for one person (personal) or for everyone who reads the
 * project's Web analytics (project). The period, the environment, and the
 * goal are the page's, not the segment's.
 */
export type Visibility = "personal" | "project";

export interface Segment {
  id: string;
  name: string;
  visibility: Visibility;
  /**
   * The filters as the report routes take them, checked again on each
   * read: null when the routes would refuse them now, such as a filter
   * that no longer exists, so the dashboard shows the segment as invalid.
   */
  filters: FilterQuery | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A project's segments. */
export const MAX_PROJECT_SEGMENTS = 50;

/** One person's personal segments in one project. */
export const MAX_PERSONAL_SEGMENTS = 50;

/** Who asks: personal segments are only ever their owner's. */
export interface SegmentScope {
  projectId: string;
  visibility: Visibility;
  userId: string;
}

function segmentOf(row: Selectable<SegmentsTable>): Segment {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    filters: filterQueryOf(row.filters),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The rows of `scope`: the project's, or the user's own personal ones. */
function inScope(db: Kysely<Database>, scope: SegmentScope) {
  const rows = db
    .selectFrom("segments")
    .where("project_id", "=", scope.projectId)
    .where("visibility", "=", scope.visibility);
  return scope.visibility === "personal" ? rows.where("owner_id", "=", scope.userId) : rows;
}

/** The project's segments and the user's own, by name. */
export async function listSegments(
  db: Kysely<Database>,
  projectId: string,
  userId: string,
): Promise<Segment[]> {
  const rows = await db
    .selectFrom("segments")
    .selectAll()
    .where("project_id", "=", projectId)
    .where((eb) => eb.or([eb("owner_id", "is", null), eb("owner_id", "=", userId)]))
    .orderBy(sql`lower(name)`)
    .orderBy("name")
    .orderBy("id")
    .execute();
  return rows.map(segmentOf);
}

/** PostgreSQL's unique_violation: here, a name the scope's segments already have. */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

export interface SegmentDefinition {
  name: string;
  filters: FilterQuery;
}

/** Serialize JSON explicitly; the driver treats JavaScript arrays as PostgreSQL arrays. */
const filtersColumn = (filters: FilterQuery) => JSON.stringify(filters);

/** Refuse a name taken in the scope, and a scope at its limit. */
export async function createSegment(
  db: Kysely<Database>,
  scope: SegmentScope,
  definition: SegmentDefinition,
): Promise<{ segment: Segment } | { refused: "too_many" | "name_taken" }> {
  const limit = scope.visibility === "project" ? MAX_PROJECT_SEGMENTS : MAX_PERSONAL_SEGMENTS;
  try {
    return await db.transaction().execute(async (trx) => {
      // Serialize the project's saves so concurrent requests cannot pass the limit.
      await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", scope.projectId)
        .forUpdate()
        .executeTakeFirst();
      const { count } = await inScope(trx, scope)
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      if (Number(count) >= limit) return { refused: "too_many" as const };
      const row = await trx
        .insertInto("segments")
        .values({
          project_id: scope.projectId,
          name: definition.name,
          filters: filtersColumn(definition.filters),
          visibility: scope.visibility,
          owner_id: scope.visibility === "personal" ? scope.userId : null,
          created_by: scope.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { segment: segmentOf(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { refused: "name_taken" };
    throw error;
  }
}

/**
 * Replace a segment's name and filters. Require readUpdatedAt to prevent
 * overwriting a newer edit. Return null if the scope has no such segment.
 */
export async function updateSegment(
  db: Kysely<Database>,
  scope: SegmentScope,
  segmentId: string,
  readUpdatedAt: Date,
  definition: SegmentDefinition,
): Promise<{ segment: Segment } | { refused: "name_taken" | "changed" } | null> {
  try {
    const row = await updateInScope(db, scope)
      .set({
        name: definition.name,
        filters: filtersColumn(definition.filters),
        // Later than the version replaced, even within its millisecond.
        updated_at: sql<Date>`greatest(date_trunc('milliseconds', now()), updated_at + interval '1 millisecond')`,
      })
      .where("id", "=", segmentId)
      .where("updated_at", "=", readUpdatedAt)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return { segment: segmentOf(row) };
  } catch (error) {
    if (isUniqueViolation(error)) return { refused: "name_taken" };
    throw error;
  }
  const exists = await inScope(db, scope)
    .select("id")
    .where("id", "=", segmentId)
    .executeTakeFirst();
  return exists === undefined ? null : { refused: "changed" };
}

function updateInScope(db: Kysely<Database>, scope: SegmentScope) {
  const rows = db
    .updateTable("segments")
    .where("project_id", "=", scope.projectId)
    .where("visibility", "=", scope.visibility);
  return scope.visibility === "personal" ? rows.where("owner_id", "=", scope.userId) : rows;
}

/** Return false if the scope has no such segment. */
export async function deleteSegment(
  db: Kysely<Database>,
  scope: SegmentScope,
  segmentId: string,
): Promise<boolean> {
  const rows = db
    .deleteFrom("segments")
    .where("project_id", "=", scope.projectId)
    .where("visibility", "=", scope.visibility)
    .where("id", "=", segmentId);
  const result = await (
    scope.visibility === "personal" ? rows.where("owner_id", "=", scope.userId) : rows
  ).executeTakeFirst();
  return result.numDeletedRows > 0n;
}
