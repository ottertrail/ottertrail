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
  /** The test file's own database. */
  database: string;
  destroy(): Promise<void>;
}

/**
 * A ClickHouse database of its own for one test file, with every migration
 * applied, as createTestDatabase makes a PostgreSQL schema. Drop it with
 * destroy() when the tests finish.
 *
 * Needs the local ClickHouse: `podman compose up -d` (or `docker compose up -d`).
 */
export async function createTestClickHouse(): Promise<TestClickHouse> {
  const config = loadConfig().clickhouse;
  // Named with when it was made, so a later run can drop it if this one is cut off.
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
