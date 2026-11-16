import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

import { loadConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrate.ts";
import type { Database } from "../../src/db/schema.ts";

export interface TestDatabase {
  db: Kysely<Database>;
  destroy(): Promise<void>;
}

/**
 * Creates an empty schema with every migration applied, so each test file
 * starts from a clean database and never sees development data. Drop it
 * with destroy() when the tests finish.
 *
 * Needs the local database: `podman compose up -d` (or `docker compose up -d`).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const connectionString = loadConfig().databaseUrl;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;

  await withAdmin(connectionString, async (admin) => {
    await sql`create schema ${sql.id(schema)}`.execute(admin);
  });

  const db = createDatabase({ connectionString, maxConnections: 4, schema });
  async function destroy() {
    await db.destroy();
    await withAdmin(connectionString, async (admin) => {
      await sql`drop schema ${sql.id(schema)} cascade`.execute(admin);
    });
  }

  try {
    await migrateToLatest(db, { schema });
  } catch (error) {
    await destroy();
    throw error;
  }
  return { db, destroy };
}

async function withAdmin(
  connectionString: string,
  work: (admin: Kysely<Database>) => Promise<void>,
): Promise<void> {
  const admin = createDatabase({ connectionString, maxConnections: 1 });
  try {
    await work(admin);
  } catch (error) {
    throw new Error(
      "Could not prepare the test database. Is PostgreSQL running? Start it with `podman compose up -d` from the repository root.",
      { cause: error },
    );
  } finally {
    await admin.destroy();
  }
}
