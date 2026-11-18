import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";

import { loadConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/database.ts";
import { migrate } from "../../src/db/migrate.ts";
import { migrations } from "../../src/db/migrations/index.ts";
import type { Database } from "../../src/db/schema.ts";

/**
 * Test files run in parallel, each in its own schema. Kysely's migrator
 * checks for its bookkeeping table by listing every table in every schema,
 * and that listing fails ("schema … does not exist") if another file drops
 * its schema in the middle of it. Migrating holds this PostgreSQL advisory
 * lock shared and dropping holds it exclusively, so drops wait for listings.
 */
const SCHEMA_LOCK = 4_281_708_001;

export interface TestDatabase {
  db: Kysely<Database>;
  /** The schema the test's tables are in. */
  schema: string;
  destroy(): Promise<void>;
}

/**
 * Creates an empty schema with every migration applied, or those up to
 * `target`, so each test file starts from a clean database and never sees
 * development data. Drop it with destroy() when the tests finish.
 *
 * Needs the local database: `podman compose up -d` (or `docker compose up -d`).
 */
export async function createTestDatabase({
  target = "latest",
}: { target?: string } = {}): Promise<TestDatabase> {
  const connectionString = loadConfig().databaseUrl;
  const schema = `test_${randomUUID().replaceAll("-", "")}`;

  await withAdmin(connectionString, async (admin) => {
    await sql`create schema ${sql.id(schema)}`.execute(admin);
  });

  const db = createDatabase({ connectionString, maxConnections: 4, schema });
  async function destroy() {
    await db.destroy();
    await withSchemaLock(connectionString, "exclusive", (connection) =>
      sql`drop schema ${sql.id(schema)} cascade`.execute(connection),
    );
  }

  try {
    await withSchemaLock(connectionString, "shared", () => migrate(db, target, { schema }));
  } catch (error) {
    await destroy();
    throw error;
  }
  return { db, schema, destroy };
}

/**
 * Moves a test database to a migration, back or forward ("latest" for the
 * newest), for tests of migrations themselves. Going back drops tables, as
 * destroy() drops a schema, so it holds SCHEMA_LOCK exclusively too: other
 * files' migrators list every table while they run.
 */
export async function migrateTestDatabase(testDb: TestDatabase, target: string): Promise<void> {
  const migrator = new Migrator({
    db: testDb.db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    migrationTableSchema: testDb.schema,
  });
  await withSchemaLock(loadConfig().databaseUrl, "exclusive", async () => {
    const { error } =
      target === "latest" ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
    if (error !== undefined) {
      throw new Error(`Migrating the test database to ${target} failed`, { cause: error });
    }
  });
}

/**
 * Migrates a test database forward with migrate(), as migrate.ts does,
 * which refuses to go back.
 */
export async function migrateForward(testDb: TestDatabase, target: string): Promise<void> {
  await withSchemaLock(loadConfig().databaseUrl, "shared", () =>
    migrate(testDb.db, target, { schema: testDb.schema }),
  );
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

/** Runs work while holding SCHEMA_LOCK, on a connection of its own. */
async function withSchemaLock(
  connectionString: string,
  mode: "shared" | "exclusive",
  work: (connection: Kysely<Database>) => Promise<unknown>,
): Promise<void> {
  const locker = createDatabase({ connectionString, maxConnections: 1 });
  try {
    await locker.connection().execute(async (connection) => {
      await (
        mode === "shared"
          ? sql`select pg_advisory_lock_shared(${SCHEMA_LOCK})`
          : sql`select pg_advisory_lock(${SCHEMA_LOCK})`
      ).execute(connection);
      try {
        await work(connection);
      } finally {
        await (
          mode === "shared"
            ? sql`select pg_advisory_unlock_shared(${SCHEMA_LOCK})`
            : sql`select pg_advisory_unlock(${SCHEMA_LOCK})`
        ).execute(connection);
      }
    });
  } finally {
    await locker.destroy();
  }
}
