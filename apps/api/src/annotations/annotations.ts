import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";

/**
 * Notes on the Web analytics chart: a day, or a day and a time, on the
 * instance's clock (docs/web-analytics.md, "Notes and releases on the chart").
 */
export interface Annotation {
  id: string;
  /** "YYYY-MM-DD" in the instance's timezone. */
  day: string;
  /** "HH:MM" in the instance's timezone, or null for the whole day. */
  time: string | null;
  text: string;
  /** null: every environment. */
  environment: string | null;
  /** Who last wrote the text; null once that user is removed. */
  author: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_ANNOTATIONS = 500;
export const MAX_ANNOTATION_LENGTH = 200;

export interface AnnotationFields {
  day: string;
  time: string | null;
  text: string;
  environment: string | null;
}

function select(db: Kysely<Database>, projectId: string) {
  return db
    .selectFrom("annotations")
    .leftJoin("dashboard_users", "dashboard_users.id", "annotations.author_id")
    .select([
      "annotations.id",
      "annotations.day",
      "annotations.time",
      "annotations.text",
      "annotations.environment",
      "annotations.author_id",
      "annotations.created_at",
      "annotations.updated_at",
      "dashboard_users.name as author_name",
    ])
    .where("annotations.project_id", "=", projectId);
}

type Row = Awaited<ReturnType<ReturnType<typeof select>["executeTakeFirstOrThrow"]>>;

function annotationOf(row: Row): Annotation {
  return {
    id: row.id,
    day: row.day,
    time: row.time === null ? null : row.time.slice(0, 5),
    text: row.text,
    environment: row.environment,
    author:
      row.author_id === null || row.author_name === null
        ? null
        : { id: row.author_id, name: row.author_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The project's notes for one environment, those for every environment
 * included, from `from` to `to` (days, both included), in time order.
 */
export async function listAnnotations(
  db: Kysely<Database>,
  projectId: string,
  { environment, from, to }: { environment: string; from?: string; to?: string },
): Promise<Annotation[]> {
  let query = select(db, projectId).where((eb) =>
    eb.or([
      eb("annotations.environment", "=", environment),
      eb("annotations.environment", "is", null),
    ]),
  );
  if (from !== undefined) query = query.where("annotations.day", ">=", from);
  if (to !== undefined) query = query.where("annotations.day", "<=", to);
  const rows = await query
    .orderBy("annotations.day")
    .orderBy("annotations.time", (order) => order.asc().nullsFirst())
    .orderBy("annotations.created_at")
    .orderBy("annotations.id")
    .execute();
  return rows.map(annotationOf);
}

/** Refuse a project at MAX_ANNOTATIONS. */
export async function createAnnotation(
  db: Kysely<Database>,
  projectId: string,
  authorId: string,
  fields: AnnotationFields,
): Promise<{ annotation: Annotation } | { refused: "too_many" }> {
  return db.transaction().execute(async (trx) => {
    // Serialize project inserts so concurrent requests cannot exceed the limit.
    await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();
    const { count } = await trx
      .selectFrom("annotations")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_ANNOTATIONS) return { refused: "too_many" as const };
    const { id } = await trx
      .insertInto("annotations")
      .values({ project_id: projectId, author_id: authorId, ...fields })
      .returning("id")
      .executeTakeFirstOrThrow();
    const row = await select(trx, projectId)
      .where("annotations.id", "=", id)
      .executeTakeFirstOrThrow();
    return { annotation: annotationOf(row) };
  });
}

/** The changed note, or null if the project has no such note. The editor becomes its author. */
export async function updateAnnotation(
  db: Kysely<Database>,
  projectId: string,
  annotationId: string,
  authorId: string,
  fields: AnnotationFields,
): Promise<Annotation | null> {
  const updated = await db
    .updateTable("annotations")
    .set({ ...fields, author_id: authorId, updated_at: new Date() })
    .where("project_id", "=", projectId)
    .where("id", "=", annotationId)
    .executeTakeFirst();
  if (updated.numUpdatedRows === 0n) return null;
  const row = await select(db, projectId)
    .where("annotations.id", "=", annotationId)
    .executeTakeFirst();
  return row === undefined ? null : annotationOf(row);
}

/** Return false if the project has no such note. */
export async function deleteAnnotation(
  db: Kysely<Database>,
  projectId: string,
  annotationId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom("annotations")
    .where("project_id", "=", projectId)
    .where("id", "=", annotationId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
