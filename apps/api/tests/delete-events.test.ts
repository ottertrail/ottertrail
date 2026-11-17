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
import { nowNs, secretKeyOf } from "./helpers/telemetry.ts";

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

const TELEMETRY = ["spans", "logs", "metric_points", "metric_histograms"] as const;

/** Sends a span, a log record, a gauge point, and a histogram point over OTLP, as a server would. */
async function sendTelemetry(projectId: string) {
  const key = await secretKeyOf(dashboard.db, projectId);
  const time = String(nowNs(-1000));
  const resource = { attributes: [{ key: "service.name", value: { stringValue: "api" } }] };
  const requests = {
    "/v1/traces": {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              spans: [
                {
                  traceId: randomUUID().replaceAll("-", ""),
                  spanId: randomUUID().replaceAll("-", "").slice(0, 16),
                  name: "GET /",
                  startTimeUnixNano: time,
                  endTimeUnixNano: time,
                },
              ],
            },
          ],
        },
      ],
    },
    "/v1/logs": {
      resourceLogs: [
        {
          resource,
          scopeLogs: [{ logRecords: [{ timeUnixNano: time, body: { stringValue: "hi" } }] }],
        },
      ],
    },
    "/v1/metrics": {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              metrics: [
                { name: "up", gauge: { dataPoints: [{ timeUnixNano: time, asInt: "1" }] } },
                {
                  name: "latency",
                  histogram: {
                    dataPoints: [{ timeUnixNano: time, count: "1", bucketCounts: ["1"] }],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  for (const [url, body] of Object.entries(requests)) {
    const response = await dashboard.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: JSON.stringify(body),
    });
    expect(response.statusCode).toBe(200);
  }
}

/** The project's rows in each telemetry table, as reports see them, or every row still on disk. */
async function telemetryOf(projectId: string, { onDisk = false } = {}): Promise<number[]> {
  return Promise.all(
    TELEMETRY.map(async (table) => {
      const result = await dashboard.reader.client.query({
        query: `SELECT count() AS n FROM ${table} WHERE project_id = {project:UUID}`,
        query_params: { project: projectId },
        format: "JSONEachRow",
        clickhouse_settings: onDisk ? { apply_deleted_mask: 0 } : {},
      });
      const [row] = await result.json<{ n: string }>();
      return Number(row?.n ?? 0);
    }),
  );
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

  test("a deleted project's traces, logs, and metrics leave ClickHouse, and its disk, too", async () => {
    const doomed = await projectWith("Doomed telemetry", 1);
    const kept = await projectWith("Kept telemetry", 0);
    await sendTelemetry(doomed);
    await sendTelemetry(kept);
    expect(await telemetryOf(doomed)).toEqual([1, 1, 1, 1]);

    await deleteThroughDashboard(doomed, "Doomed telemetry");
    expect(await purgeDeletedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      projects: 1,
      rows: 5,
      files: 0,
    });
    expect(await telemetryOf(doomed)).toEqual([0, 0, 0, 0]);
    expect(await removeDeletedRows(dashboard.reader.client, { wait: true })).toMatchObject({
      started: true,
    });
    expect(await telemetryOf(doomed, { onDisk: true })).toEqual([0, 0, 0, 0]);
    expect(await telemetryOf(kept)).toEqual([1, 1, 1, 1]);
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

  test("finds a project PostgreSQL no longer knows that ClickHouse holds only telemetry of", async () => {
    const restored = await projectWith("Telemetry only", 0);
    await sendTelemetry(restored);
    await dashboard.db.deleteFrom("projects").where("id", "=", restored).execute();
    await dashboard.db.deleteFrom("project_deletions").execute();

    expect(await queueOrphanedProjects(dashboard.db, dashboard.reader.client)).toEqual({
      orphans: 1,
      queued: true,
    });
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await telemetryOf(restored)).toEqual([0, 0, 0, 0]);
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
