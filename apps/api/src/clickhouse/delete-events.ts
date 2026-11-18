import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { replayPrefix } from "../replays/replays.ts";
import { projectPrefix } from "../source-maps/source-maps.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { type ClickHouseClient, identifier } from "./clickhouse.ts";
import { TELEMETRY_TABLES } from "./migrations.ts";
import { clickHouseTime, QueryParams, queryRows, type Reader, runCommand } from "./query.ts";

/**
 * Projects per DELETE. Query values travel in the request's URL, which
 * ClickHouse limits to 1 MiB: a thousand IDs and times take about 80 KB.
 */
const PROJECTS_PER_DELETE = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += PROJECTS_PER_DELETE) {
    result.push(items.slice(start, start + PROJECTS_PER_DELETE));
  }
  return result;
}

/** Every table that holds a project's rows: events, traces, logs, metrics, and check results. */
const PROJECT_TABLES = ["events", ...TELEMETRY_TABLES, "check_results"] as const;

/**
 * Deletes the rows of `table` that match `where` (SQL over that table, its
 * values in `params`) and returns how many rows each project had.
 *
 * A lightweight DELETE: reports stop seeing the rows at once, and
 * removeDeletedRows() later takes them off the disk. ClickHouse carries a
 * DELETE out as a mutation of every part that holds such rows, which takes
 * seconds, so callers delete for many projects in one statement, and none
 * is sent when nothing matches, as on most of the worker's runs.
 */
async function deleteWhere(
  clickhouse: ClickHouseClient,
  table: (typeof PROJECT_TABLES)[number],
  where: string,
  params: QueryParams,
): Promise<Map<string, number>> {
  const reader: Reader = { client: clickhouse };
  const name = identifier(table);
  const rows = await queryRows<{ project_id: string; n: string }>(
    reader,
    `SELECT project_id, count() AS n FROM ${name} WHERE ${where} GROUP BY project_id`,
    params,
  );
  const counts = new Map(rows.map((row) => [row.project_id, Number(row.n)]));
  if (counts.size > 0) {
    await runCommand(reader, `DELETE FROM ${name} WHERE ${where}`, params);
  }
  return counts;
}

/**
 * Deletes each project's events that happened before its cut-off, a
 * thousand projects per statement, and returns how many rows each had.
 */
export async function deleteEventsBefore(
  clickhouse: ClickHouseClient,
  cutOffs: readonly { projectId: string; before: Date }[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const chunk of chunks(cutOffs)) {
    const params = new QueryParams();
    const ids = params.add(
      chunk.map((cutOff) => cutOff.projectId),
      "Array(UUID)",
    );
    const befores = params.add(
      chunk.map((cutOff) => clickHouseTime(cutOff.before)),
      "Array(DateTime64(3, 'UTC'))",
    );
    // Each project's own cut-off. A project missing from the list would get
    // 1970, so nothing; the project_id test comes first, for the index.
    const deleted = await deleteWhere(
      clickhouse,
      "events",
      `project_id IN ${ids}
       AND occurred_at < transform(project_id, ${ids}, ${befores}, toDateTime64(0, 3, 'UTC'))`,
      params,
    );
    for (const [projectId, count] of deleted) counts.set(projectId, count);
  }
  return counts;
}

/** What removeDeletedRows() did. */
export interface DiskCleanup {
  /** Whether it started rewriting parts. */
  started: boolean;
  /** The unfinished change it waited for instead, with ClickHouse's reason if that change failed. */
  waitingFor?: { mutationId: string; failReason: string } | undefined;
}

/**
 * Rewrites the parts that hold deleted rows without them, so the rows'
 * bytes leave the disk; without this, they would stay until ClickHouse
 * merged those parts again, which for an old month may be never.
 *
 * It looks at the tables, not at what this run deleted, so rows a failed
 * run left behind are removed by the next. A part of events holds every
 * project's events of its month, so a rewrite costs as much as the months
 * it touches: the worker runs this with retention, every few hours, not
 * after each project deletion. Traces, logs, and metrics are kept by the
 * day, so theirs are smaller. Each table is skipped while an earlier
 * change to it is still under way. ClickHouse does the work in the
 * background; `wait` waits for it (tests).
 */
export async function removeDeletedRows(
  clickhouse: ClickHouseClient,
  { wait = false }: { wait?: boolean } = {},
): Promise<DiskCleanup> {
  const cleanup: DiskCleanup = { started: false };
  for (const table of PROJECT_TABLES) {
    const result = await removeDeletedRowsOf(clickhouse, table, wait);
    cleanup.started ||= result.started;
    cleanup.waitingFor ??= result.waitingFor;
  }
  return cleanup;
}

async function removeDeletedRowsOf(
  clickhouse: ClickHouseClient,
  table: (typeof PROJECT_TABLES)[number],
  wait: boolean,
): Promise<DiskCleanup> {
  const reader: Reader = { client: clickhouse };
  const params = new QueryParams();
  const name = params.add(table, "String");
  const [parts] = await queryRows<{ n: string }>(
    reader,
    `SELECT count() AS n FROM system.parts
     WHERE database = currentDatabase() AND table = ${name} AND active AND has_lightweight_delete`,
    params,
  );
  if (Number(parts?.n ?? 0) === 0) return { started: false };
  const [unfinished] = await queryRows<{ mutation_id: string; latest_fail_reason: string }>(
    reader,
    `SELECT mutation_id, latest_fail_reason FROM system.mutations
     WHERE database = currentDatabase() AND table = ${name} AND NOT is_done
     ORDER BY create_time LIMIT 1`,
    params,
  );
  if (unfinished !== undefined) {
    return {
      started: false,
      waitingFor: { mutationId: unfinished.mutation_id, failReason: unfinished.latest_fail_reason },
    };
  }
  await clickhouse.command({
    query: `ALTER TABLE ${identifier(table)} APPLY DELETED MASK`,
    clickhouse_settings: { mutations_sync: wait ? "1" : "0" },
  });
  return { started: true };
}

/**
 * Deletes the events, traces, logs, metrics, and check results of every deleted project
 * (project_deletions) from ClickHouse, and its files from the object store (its source maps and
 * session replays), then
 * forgets the deletions. A deletion stays until both have confirmed, so an
 * outage only delays it. The worker runs it every minute; running it
 * twice, or in two workers at once, is harmless. The rows leave reports at
 * once and the disk with removeDeletedRows().
 */
export async function purgeDeletedProjects(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  store: ObjectStore | null = null,
): Promise<{ projects: number; rows: number; files: number }> {
  const deletions = await db.selectFrom("project_deletions").select("project_id").execute();
  let rows = 0;
  let files = 0;
  for (const chunk of chunks(deletions.map((deletion) => deletion.project_id))) {
    for (const table of PROJECT_TABLES) {
      const params = new QueryParams();
      const counts = await deleteWhere(
        clickhouse,
        table,
        `project_id IN ${params.add(chunk, "Array(UUID)")}`,
        params,
      );
      rows += [...counts.values()].reduce((sum, count) => sum + count, 0);
    }
    if (store !== null) {
      for (const projectId of chunk) {
        for (const prefix of [projectPrefix(projectId), replayPrefix(projectId)]) {
          files += await store.deletePrefix(prefix);
        }
      }
    }
    await db.deleteFrom("project_deletions").where("project_id", "in", chunk).execute();
  }
  return { projects: deletions.length, rows, files };
}

/**
 * The most projects queueOrphanedProjects() deletes in one run without a
 * person deciding: 5, or a tenth of ClickHouse's projects if that is more.
 */
export function orphanLimit(projectsInClickHouse: number): number {
  return Math.max(5, Math.floor(projectsInClickHouse / 10));
}

/** What queueOrphanedProjects() found and did. */
export interface OrphanSweep {
  /** Projects ClickHouse holds events of but PostgreSQL does not know. */
  orphans: number;
  /** Whether it asked for them to be deleted; false when there were too many to trust. */
  queued: boolean;
}

/**
 * Finds projects that ClickHouse holds rows of (events, traces, logs,
 * metrics, check results) but PostgreSQL no longer
 * knows, and asks purgeDeletedProjects() to delete them (project_deletions).
 * A deletion can miss ClickHouse's copy: a restore puts back a ClickHouse
 * backup made before the project was deleted, or an insert that timed out
 * lands after the purge ran. The worker runs this with retention.
 *
 * Those cases leave a project or two. When PostgreSQL knows no projects, or
 * more are missing than orphanLimit(), PostgreSQL is far more likely to be
 * the wrong one (empty after an upgrade, a wrong DATABASE_URL), so nothing
 * is queued and the worker logs an error for a person to decide.
 */
export async function queueOrphanedProjects(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
): Promise<OrphanSweep> {
  // The one query on these tables not narrowed to a project: maintenance
  // across all of them. Ordered by project first, so it reads only that column.
  const inClickHouse = await queryRows<{ project_id: string }>(
    { client: clickhouse },
    PROJECT_TABLES.map((table) => `SELECT DISTINCT project_id FROM ${identifier(table)}`).join(
      " UNION DISTINCT ",
    ),
    new QueryParams(),
  );
  const ids = inClickHouse.map((row) => row.project_id);
  const orphans: string[] = [];
  for (const chunk of chunks(ids)) {
    const known = await db.selectFrom("projects").select("id").where("id", "in", chunk).execute();
    const knownIds = new Set(known.map((project) => project.id));
    orphans.push(...chunk.filter((id) => !knownIds.has(id)));
  }
  if (orphans.length === 0) return { orphans: 0, queued: false };
  const [projects] = await db
    .selectFrom("projects")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .execute();
  if (Number(projects?.n ?? 0) === 0 || orphans.length > orphanLimit(ids.length)) {
    return { orphans: orphans.length, queued: false };
  }
  await db
    .insertInto("project_deletions")
    .values(orphans.map((id) => ({ project_id: id })))
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  return { orphans: orphans.length, queued: true };
}
