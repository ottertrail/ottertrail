import {
  type ClickHouseClient,
  createClickHouse,
  identifier,
} from "../../src/clickhouse/clickhouse.ts";
import { migrateClickHouse } from "../../src/clickhouse/migrate.ts";
import { loadConfig } from "../../src/config.ts";
import { testName } from "./test-names.ts";

export interface TestClickHouse {
  client: ClickHouseClient;
  database: string;
  destroy(): Promise<void>;
}

/**
 * Isolate one test file in a migrated database. Call destroy() after use.
 *
 * Needs the local ClickHouse: `podman compose up -d` (or `docker compose up -d`).
 */
export async function createTestClickHouse(): Promise<TestClickHouse> {
  const config = loadConfig().clickhouse;
  // The timestamp lets later runs clean up after an interrupted run.
  const database = testName();
  const admin = createClickHouse(config, { database: "default" });
  try {
    await migrateClickHouse(admin, database);
  } catch (error) {
    // The database may exist with only some tables: leave nothing behind.
    await admin
      .command({ query: `DROP DATABASE IF EXISTS ${identifier(database)}` })
      .catch(() => undefined);
    await admin.close();
    throw new Error(
      "Could not prepare the test ClickHouse. Is it running? Start it with `podman compose up -d` from the repository root.",
      { cause: error },
    );
  }
  const client = createClickHouse(config, { database });
  return {
    client,
    database,
    destroy: async () => {
      await client.close();
      await admin.command({ query: `DROP DATABASE IF EXISTS ${identifier(database)}` });
      await admin.close();
    },
  };
}
