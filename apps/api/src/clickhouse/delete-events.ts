import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

import { projectAvatarPrefix } from "../avatars/avatars.ts";
import type { Database } from "../db/schema.ts";
import { projectSnapshotPrefix } from "../heatmaps/snapshots.ts";
import { replayPrefix } from "../replays/replays.ts";
import { projectPrefix } from "../source-maps/source-maps.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { type ClickHouseClient, identifier } from "./clickhouse.ts";
import {
  AI_CALLS_TABLE,
  firstSeenSelect,
  RELEASE_FIRST_SEEN,
  TELEMETRY_TABLES,
  USER_FIRST_SEEN,
} from "./migrations.ts";
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

/**
 * Every table that holds a project's rows: events, traces, logs, metrics,
 * check results, its signed-in users' and its releases' first-seen times,
 * its heatmaps, and its AI calls.
 */
export const PROJECT_TABLES = [
  "events",
  ...TELEMETRY_TABLES,
  "check_results",
  USER_FIRST_SEEN,
  RELEASE_FIRST_SEEN,
  "heatmaps",
  AI_CALLS_TABLE,
] as const;

/**
 * Deletes the rows of `table` that match `where` (SQL over that table, its
 * values in `params`) and returns how many rows each project had.
 *
 * A lightweight DELETE: reports stop seeing the rows at once, and
 * removeDeletedRows() later takes them off the disk. ClickHouse carries a
 * DELETE out as a mutation of every part that holds such rows, which takes
 * seconds, so callers delete for many projects in one statement, and none
 * is sent when nothing matches, as on most of the worker's runs. Also one
 * user's rows (identities/deletions.ts).
 */
export async function deleteWhere(
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
 * Deletes `table`'s rows that match `where` without waiting for ClickHouse
 * to mask them, and without counting them first: for filters no index
 * helps, such as a user ID inside spans' and logs' attributes, where each
 * pass reads the project's whole table and could outlast the request's
 * time limit. ClickHouse keeps a queued deletion until it is done.
 */
export async function deleteInBackground(
  clickhouse: ClickHouseClient,
  table: (typeof PROJECT_TABLES)[number],
  where: string,
  params: QueryParams,
): Promise<void> {
  await clickhouse.command({
    query: `DELETE FROM ${identifier(table)} WHERE ${where}`,
    query_params: params.values,
    clickhouse_settings: { lightweight_deletes_sync: "0" },
  });
}

/**
 * Deletes each project's events, and its AI calls, that happened before
 * its cut-off, a thousand projects per statement, and returns how many
 * rows each had (both tables together). AI calls are kept as long as
 * events (docs/ai-usage.md).
 */
export async function deleteEventsBefore(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  cutOffs: readonly { projectId: string; before: Date }[],
  room: RoomCheck = {},
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
    const aiCalls = await deleteWhere(
      clickhouse,
      AI_CALLS_TABLE,
      `project_id IN ${ids}
       AND timestamp < transform(project_id, ${ids}, ${befores}, toDateTime64(0, 3, 'UTC'))`,
      params,
    );
    for (const [projectId, count] of aiCalls) {
      counts.set(projectId, (counts.get(projectId) ?? 0) + count);
    }
    await rebuildFirstSeen(db, clickhouse, [...deleted.keys()], room);
  }
  return counts;
}

/**
 * Deletes each project's traces, logs, and metrics from before its cut-off,
 * a thousand projects per statement, and returns how many rows each had
 * (the four tables together). For projects that keep fewer days than the
 * instance's maximum; ClickHouse's TTL drops the rest (retention/retention.ts).
 */
export async function deleteTelemetryBefore(
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
    for (const table of TELEMETRY_TABLES) {
      // As for events: the project_id test first, for the index.
      const deleted = await deleteWhere(
        clickhouse,
        table,
        `project_id IN ${ids}
         AND timestamp < transform(project_id, ${ids}, ${befores}, toDateTime64(0, 3, 'UTC'))`,
        params,
      );
      for (const [projectId, count] of deleted) {
        counts.set(projectId, (counts.get(projectId) ?? 0) + count);
      }
    }
  }
  return counts;
}

/**
 * Works the projects' first-seen times out again from the events they
 * still have, after old events were deleted: a user whose early events are
 * gone is first seen at their earliest event kept, and a user with none
 * left is forgotten (docs/clickhouse.md, "First-seen times"). Also after a
 * project's spam visits are deleted (spam/delete-visits.ts).
 *
 * The new rows are worked out first, into a temporary table of a session
 * of its own: the read of every signed-in event, the step that can time
 * out or run out of memory, happens before anything is removed. Only then
 * are the old rows deleted and the new ones copied in, a copy of a few
 * rows. The table cannot be swapped in one step (it has no partition per
 * project), so if that last copy fails, the projects have no first-seen
 * times until the next rebuild, and the view adds every user seen meanwhile.
 *
 * Events keep arriving meanwhile. The view writes a row for each as it is
 * stored, and the delete takes the rows of the whole project, so a user
 * first seen in an event the snapshot did not read would lose their row.
 * So once the copy is in, the users of the events that arrived from
 * ARRIVAL_MARGIN_MS before the rebuild started are added again, read
 * after the delete (events' received_at, with its minmax index): an event
 * the snapshot missed was received after then, since an insert gives up
 * after the client's 2 minutes. A user counted by both, or by the view
 * too, is the same time again, which a min ignores.
 *
 * ClickHouse refuses inserts while less than 5% of its disk is free
 * (deploy/clickhouse/config.d/ottertrail.xml), which would refuse that
 * last copy after the old rows are gone. So each project is first marked
 * in PostgreSQL (first_seen_rebuilds), then the rebuild runs only with
 * REBUILD_FREE_RATIO of the disk free, and the mark goes once it is done.
 * Without the room, nothing is removed ("deferred"): the old first-seen
 * times stay, and the worker tries the marked projects again
 * (retryFirstSeenRebuilds) once there is room. A rebuild that fails part
 * way keeps its mark too.
 */
export async function rebuildFirstSeen(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  projectIds: string[],
  { freeRatio = () => clickHouseFreeRatio(clickhouse), afterSnapshot }: RebuildOptions = {},
): Promise<"rebuilt" | "deferred"> {
  if (projectIds.length === 0) return "rebuilt";
  // Only projects PostgreSQL still knows: a deleted one's rows go with its purge.
  await sql`
    insert into first_seen_rebuilds (project_id)
    select id from projects where id = any(${projectIds}::uuid[])
    on conflict (project_id) do nothing
  `.execute(db);
  if ((await freeRatio()) < REBUILD_FREE_RATIO) return "deferred";
  const reader: Reader = { client: clickhouse, sessionId: randomUUID() };
  const params = new QueryParams();
  const ids = params.add(projectIds, "Array(UUID)");
  const table = identifier(USER_FIRST_SEEN);
  // Taken before the snapshot reads: every event it misses was received after this.
  const arrivedFrom = params.time(new Date(Date.now() - ARRIVAL_MARGIN_MS));
  await runCommand(reader, `CREATE TEMPORARY TABLE rebuilt AS ${table} ENGINE = Memory`);
  await runCommand(
    reader,
    `INSERT INTO rebuilt ${firstSeenSelect(null, `project_id IN ${ids}`)}`,
    params,
  );
  await afterSnapshot?.();
  await runCommand(reader, `DELETE FROM ${table} WHERE project_id IN ${ids}`, params);
  await runCommand(reader, `INSERT INTO ${table} SELECT * FROM rebuilt`);
  await runCommand(
    reader,
    `INSERT INTO ${table} ${firstSeenSelect(null, `project_id IN ${ids} AND received_at >= ${arrivedFrom}`)}`,
    params,
  );
  await db.deleteFrom("first_seen_rebuilds").where("project_id", "in", projectIds).execute();
  return "rebuilt";
}

/**
 * How long before a first-seen rebuild starts an event it adds back may
 * have been received: an insert gives up after the ClickHouse client's
 * 2 minutes (clickhouse/clickhouse.ts), and the rest allows for the API's
 * and the worker's clocks to differ.
 */
export const ARRIVAL_MARGIN_MS = 10 * 60_000;

/** A rebuild's room check, and for tests, a step between its snapshot and its delete. */
export interface RebuildOptions extends RoomCheck {
  afterSnapshot?: () => Promise<void>;
}

/**
 * The share of ClickHouse's disk a first-seen rebuild needs free: the 5%
 * under which ClickHouse refuses inserts, plus 2% for what is written
 * meanwhile.
 */
export const REBUILD_FREE_RATIO = 0.07;

/** How rebuildFirstSeen learns the disk's free share; tests replace it. */
export interface RoomCheck {
  freeRatio?: () => Promise<number>;
}

/** The free share of ClickHouse's disk, from system.disks (0 when it reports none). */
export async function clickHouseFreeRatio(clickhouse: ClickHouseClient): Promise<number> {
  const [disk] = await queryRows<{ free_space: string; total_space: string }>(
    { client: clickhouse },
    "SELECT free_space, total_space FROM system.disks WHERE name = 'default'",
    new QueryParams(),
  );
  const total = Number(disk?.total_space ?? 0);
  return total > 0 ? Number(disk?.free_space ?? 0) / total : 0;
}

/** Rebuilds the first-seen times a skipped or failed rebuild left marked, a thousand projects at a time. */
export async function retryFirstSeenRebuilds(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  room: RoomCheck = {},
): Promise<{ projects: number; outcome: "rebuilt" | "deferred" | "none" }> {
  const rows = await db
    .selectFrom("first_seen_rebuilds")
    .select("project_id")
    .orderBy("requested_at")
    .limit(PROJECTS_PER_DELETE)
    .execute();
  if (rows.length === 0) return { projects: 0, outcome: "none" };
  const ids = rows.map((row) => row.project_id);
  return { projects: ids.length, outcome: await rebuildFirstSeen(db, clickhouse, ids, room) };
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
 * Deletes the events, traces, logs, metrics, check results, heatmaps, and AI calls of every deleted project
 * (project_deletions) from ClickHouse, and its files from the object store (its source maps,
 * session replays, saved heatmap views, icon, and favicon), then
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
        for (const prefix of [
          projectPrefix(projectId),
          replayPrefix(projectId),
          projectSnapshotPrefix(projectId),
          projectAvatarPrefix(projectId),
        ]) {
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
 * metrics, check results, heatmaps, AI calls) but PostgreSQL no longer
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
