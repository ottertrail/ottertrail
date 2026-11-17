import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import {
  purgeDeletedProjects,
  queueOrphanedProjects,
  removeDeletedRows,
} from "../src/clickhouse/delete-events.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { loadConfig } from "../src/config.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertOrganization, insertProject } from "./helpers/projects.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await dashboard?.close();
});

function pageviews(count: number): NewEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(Date.UTC(2026, 10, 16, 12, 0, i)),
    path: `/page-${i}`,
    visitorId: "1",
  }));
}

/** A project of the dashboard's organization with `events` pageviews, in both databases. */
async function projectWith(name: string, events: number) {
  const project = await insertProject(dashboard.db, {
    organization_id: dashboard.organizationId,
    name,
  });
  await dashboard.store(project.id, pageviews(events));
  return project.id;
}

/** The project's events in ClickHouse, as reports see them, or every row still on disk. */
async function inClickHouse(projectId: string, { onDisk = false } = {}): Promise<number> {
  const result = await dashboard.reader.client.query({
    query: "SELECT count() AS n FROM events WHERE project_id = {project:UUID}",
    query_params: { project: projectId },
    format: "JSONEachRow",
    clickhouse_settings: onDisk ? { apply_deleted_mask: 0 } : {},
  });
  const [row] = await result.json<{ n: string }>();
  return Number(row?.n ?? 0);
}

async function deleteThroughDashboard(projectId: string, name: string) {
  const response = await dashboard.app.inject({
    method: "DELETE",
    url: `/api/projects/${projectId}`,
    headers: { origin: PUBLIC_URL, cookie: dashboard.cookie },
    payload: { confirmName: name },
  });
  expect(response.statusCode).toBe(204);
}

async function pendingDeletions(): Promise<string[]> {
  const rows = await dashboard.db.selectFrom("project_deletions").select("project_id").execute();
  return rows.map((row) => row.project_id);
}

// ClickHouse carries out a DELETE in the background, which takes seconds.
describe("deleting a project's events from ClickHouse", { timeout: 60_000 }, () => {
  test("a deleted project's events leave ClickHouse, and its disk; other projects keep theirs", async () => {
    const doomed = await projectWith("Doomed", 3);
    const kept = await projectWith("Kept", 2);

    await deleteThroughDashboard(doomed, "Doomed");
    // PostgreSQL's events are gone at once; ClickHouse waits for the worker.
    expect(await pendingDeletions()).toEqual([doomed]);
    expect(await inClickHouse(doomed)).toBe(3);

    expect(await purgeDeletedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      projects: 1,
      rows: 3,
      files: 0,
    });
    // Out of reports at once; off the disk with the next retention run.
    expect(await inClickHouse(doomed)).toBe(0);
    await removeDeletedRows(dashboard.reader.client, { wait: true });
    expect(await inClickHouse(doomed, { onDisk: true })).toBe(0);
    expect(await inClickHouse(kept)).toBe(2);
    expect(await pendingDeletions()).toEqual([]);
    // Nothing left to do: no DELETE is sent.
    expect(await purgeDeletedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      projects: 0,
      rows: 0,
      files: 0,
    });
  });

  test("while ClickHouse is unreachable, the deletion waits for the next run", async () => {
    const doomed = await projectWith("Doomed later", 2);
    await deleteThroughDashboard(doomed, "Doomed later");
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    try {
      await expect(purgeDeletedProjects(dashboard.db, unreachable)).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      await unreachable.close();
    }
    expect(await pendingDeletions()).toEqual([doomed]);

    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);

    expect(await inClickHouse(doomed)).toBe(0);
    expect(await pendingDeletions()).toEqual([]);
  });

  test("a project with no events in ClickHouse is forgotten without a DELETE", async () => {
    const empty = await projectWith("Empty", 0);
    await deleteThroughDashboard(empty, "Empty");

    expect(await purgeDeletedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      projects: 1,
      rows: 0,
      files: 0,
    });
    expect(await pendingDeletions()).toEqual([]);
  });

  test("deleting an organization records each of its projects too", async () => {
    const organizationId = await insertOrganization(dashboard.db, { name: "Going away" });
    const { id: projectId } = await insertProject(dashboard.db, {
      organization_id: organizationId,
      name: "With its organization",
    });
    await dashboard.store(projectId, pageviews(1));

    // No route deletes organizations yet: the database's cascade does it.
    await dashboard.db.deleteFrom("organizations").where("id", "=", organizationId).execute();

    expect(await pendingDeletions()).toEqual([projectId]);
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await inClickHouse(projectId)).toBe(0);
  });

  test("finds events of projects PostgreSQL no longer knows, and deletes them", async () => {
    const restored = await projectWith("Back from a backup", 2);
    const kept = await projectWith("Still here", 1);
    // As after a restore: ClickHouse's backup was made before the project
    // was deleted, PostgreSQL's after the purge had forgotten it.
    await dashboard.db.deleteFrom("projects").where("id", "=", restored).execute();
    await dashboard.db.deleteFrom("project_deletions").execute();

    expect(await queueOrphanedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      orphans: 1,
      queued: true,
    });
    expect(await pendingDeletions()).toEqual([restored]);

    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await inClickHouse(restored)).toBe(0);
    expect(await inClickHouse(kept)).toBe(1);
    expect(await queueOrphanedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      orphans: 0,
      queued: false,
    });
  });

  test("deletes nothing when PostgreSQL seems to be the wrong database", async () => {
    const projects = await Promise.all(
      Array.from({ length: 6 }, (_, i) => projectWith(`Mine ${i}`, 1)),
    );
    // As with a wrong DATABASE_URL, or PostgreSQL emptied for an upgrade.
    await dashboard.db.deleteFrom("projects").where("id", "in", projects).execute();
    await dashboard.db.deleteFrom("project_deletions").execute();

    const sweep = await queueOrphanedProjects(dashboard.db, dashboard.reader.client);

    expect(sweep).toEqual({ orphans: 6, queued: false });
    expect(await pendingDeletions()).toEqual([]);
    expect(await Promise.all(projects.map((id) => inClickHouse(id)))).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
