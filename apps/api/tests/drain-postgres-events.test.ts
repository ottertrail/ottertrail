import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  drainPostgresEvents,
  hasPostgresEvents,
  needsEventDrain,
} from "../src/clickhouse/drain-postgres-events.ts";
import { UncopiedEventsError } from "../src/db/migrations/0024_drop_events.ts";
import { countEvents, storedEvents } from "./helpers/events.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import {
  createTestDatabase,
  migrateForward,
  migrateTestDatabase,
  type TestDatabase,
} from "./helpers/test-database.ts";

let testClickHouse: TestClickHouse | undefined;

beforeAll(async () => {
  testClickHouse = await createTestClickHouse();
});

afterAll(async () => {
  await testClickHouse?.destroy();
});

function clickhouse() {
  if (testClickHouse === undefined) throw new Error("The test ClickHouse was not created");
  return testClickHouse.client;
}

/** A database as an install had it before events went straight to ClickHouse. */
async function beforeUpgrade(work: (testDb: TestDatabase) => Promise<void>) {
  const testDb = await createTestDatabase({ target: "0023_create_replays" });
  try {
    await work(testDb);
  } finally {
    await testDb.destroy();
  }
}

/** One event straight into PostgreSQL's events table, copied to ClickHouse or not. */
async function insertEvent(
  testDb: TestDatabase,
  projectId: string,
  {
    occurredAt,
    copied = false,
    name = "pageview",
    path = "/pricing",
    error = false,
  }: {
    occurredAt: string;
    copied?: boolean;
    name?: string;
    path?: string | null;
    error?: boolean;
  },
): Promise<string> {
  const eventId = randomUUID();
  await sql`
    insert into events (project_id, event_id, name, occurred_at, received_at, path, referrer,
                        properties, browser, country, visitor_id, environment, release, user_id,
                        error_type, error_message, error_stack, error_handled, error_fingerprint,
                        copied_at)
    values (${projectId}, ${eventId}, ${name}, ${occurredAt}, ${occurredAt}, ${path},
            ${error ? null : "https://news.ycombinator.com/"}, ${JSON.stringify({ plan: "free" })},
            'Firefox', 'DE', -4611686018427387904, 'staging', '1.4.2', 'user-42',
            ${error ? "TypeError" : null}, ${error ? "x is undefined" : null}, null,
            ${error ? false : null}, ${error ? "1-0123456789abcdef0123" : null},
            ${copied ? sql`now()` : null})
  `.execute(testDb.db);
  return eventId;
}

describe("drainPostgresEvents", () => {
  test("copies exactly the events not yet copied, then migration 0024 drops the table", async () => {
    await beforeUpgrade(async (testDb) => {
      const { id: projectId } = await insertProject(testDb.db, { name: "Upgrading" });
      const { id: quietId } = await insertProject(testDb.db, { name: "Quiet" });
      const uncopied = [
        await insertEvent(testDb, projectId, { occurredAt: "2026-11-16T12:00:00.123Z" }),
        await insertEvent(testDb, projectId, {
          occurredAt: "2026-11-16T12:01:00Z",
          name: "error",
          error: true,
        }),
        // A server-side event, without a page.
        await insertEvent(testDb, projectId, {
          occurredAt: "2026-11-16T12:02:00Z",
          name: "invoice_paid",
          path: null,
        }),
      ];
      // Copied already: ClickHouse has these, and they must not come again.
      await insertEvent(testDb, projectId, { occurredAt: "2026-11-16T11:00:00Z", copied: true });
      await insertEvent(testDb, quietId, { occurredAt: "2026-11-16T11:30:00Z", copied: true });

      expect(await hasPostgresEvents(testDb.db)).toBe(true);
      expect(await needsEventDrain(testDb.db)).toBe(true);
      expect(await drainPostgresEvents(testDb.db, clickhouse(), { batchSize: 2 })).toBe(3);

      const stored = await storedEvents(clickhouse(), projectId);
      expect(stored.map((event) => event.event_id)).toEqual(uncopied);
      expect(stored[0]).toMatchObject({
        name: "pageview",
        occurred_at: new Date("2026-11-16T12:00:00.123Z"),
        path: "/pricing",
        referrer: "https://news.ycombinator.com/",
        properties: { plan: "free" },
        browser: "Firefox",
        country: "DE",
        visitor_id: "-4611686018427387904",
        environment: "staging",
        release: "1.4.2",
        user_id: "user-42",
        error_type: null,
      });
      expect(stored[1]).toMatchObject({
        name: "error",
        error_type: "TypeError",
        error_message: "x is undefined",
        error_stack: null,
        error_handled: false,
        error_fingerprint: "1-0123456789abcdef0123",
      });
      expect(stored[2]).toMatchObject({ name: "invoice_paid", path: null });
      expect(await countEvents(clickhouse(), quietId)).toBe(0);

      // The latest of the copied events is recorded, as the worker did.
      const projects = await testDb.db
        .selectFrom("projects")
        .select(["id", "last_event_at"])
        .execute();
      expect(projects).toEqual(
        expect.arrayContaining([
          { id: projectId, last_event_at: new Date("2026-11-16T12:02:00Z") },
          { id: quietId, last_event_at: null },
        ]),
      );

      // Each batch was marked copied, so a second run copies nothing.
      const left = await sql<{ n: string }>`
        select count(*) as n from events where copied_at is null
      `.execute(testDb.db);
      expect(left.rows).toEqual([{ n: "0" }]);
      expect(await drainPostgresEvents(testDb.db, clickhouse(), { batchSize: 2 })).toBe(0);
      expect(await countEvents(clickhouse(), projectId)).toBe(3);

      // An event an API of the earlier version stored after the copy:
      // migration 0024 refuses to drop it, and the table stays.
      const late = await insertEvent(testDb, projectId, { occurredAt: "2026-11-16T12:03:00Z" });
      const refused = await migrateTestDatabase(testDb, "latest").then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).cause).toBeInstanceOf(UncopiedEventsError);
      expect(await hasPostgresEvents(testDb.db)).toBe(true);

      // Copied, then dropped.
      expect(await drainPostgresEvents(testDb.db, clickhouse())).toBe(1);
      expect(
        (await storedEvents(clickhouse(), projectId)).map((event) => event.event_id),
      ).toContain(late);
      await migrateTestDatabase(testDb, "latest");
      expect(await hasPostgresEvents(testDb.db)).toBe(false);
      expect(await needsEventDrain(testDb.db)).toBe(false);
      // Nothing left to copy, and nothing fails.
      expect(await drainPostgresEvents(testDb.db, clickhouse())).toBe(0);

      // A table of that name made later never sends the database back to 0023.
      await sql`create table events (id integer)`.execute(testDb.db);
      expect(await needsEventDrain(testDb.db)).toBe(false);
      await expect(migrateForward(testDb, "0023_create_replays")).rejects.toThrow(
        "The database is past 0023_create_replays (0024_drop_events ran); migrate() never goes back",
      );
      await sql`drop table events`.execute(testDb.db);

      // Going back makes an empty table again.
      await migrateTestDatabase(testDb, "0023_create_replays");
      expect(await hasPostgresEvents(testDb.db)).toBe(true);
      await insertEvent(testDb, projectId, {
        occurredAt: "2026-11-16T13:00:00Z",
        name: "error",
        error: true,
      });
    });
  });
});
