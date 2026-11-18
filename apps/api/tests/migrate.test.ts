import { sql } from "kysely";
import { afterAll, expect, test } from "vite-plus/test";

import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

const created: TestDatabase[] = [];

afterAll(async () => {
  await Promise.all(created.map((testDb) => testDb.destroy()));
});

test("migrating without a named schema migrates the connection's own schema, whatever others hold", async () => {
  // Another schema with Kysely's bookkeeping tables, as a test run (or one
  // cut off before it dropped its schema) leaves beside "public".
  created.push(await createTestDatabase());
  const testDb = await createTestDatabase({ asDeployed: true });
  created.push(testDb);

  const { rows } = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = ${testDb.schema}
      and table_name in ('instance_settings', 'kysely_migration', 'kysely_migration_lock')
    order by table_name`.execute(testDb.db);
  expect(rows.map((row) => row.table_name)).toEqual([
    "instance_settings",
    "kysely_migration",
    "kysely_migration_lock",
  ]);
});
