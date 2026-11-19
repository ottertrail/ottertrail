import { type Kysely, sql } from "kysely";
import { type MigrationResult, Migrator } from "kysely/migration";

import { loadConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrate.ts";
import { migrations } from "../../src/db/migrations/index.ts";
import type { Database } from "../../src/db/schema.ts";
import { testName } from "./test-names.ts";

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
 * Creates an empty schema with every migration applied, so each test file
 * starts from a clean database and never sees development data. Drop it
 * with destroy() when the tests finish.
 *
 * Needs the local database: `podman compose up -d` (or `docker compose up -d`).
 *
 * `asDeployed` migrates as `vp run migrate` does, without naming the
 * schema, so a test can check that path.
 */
export async function createTestDatabase({
  asDeployed = false,
}: { asDeployed?: boolean } = {}): Promise<TestDatabase> {
  const connectionString = loadConfig().databaseUrl;
  // Named with when it was made, so a later run can drop it if this one is cut off.
  const schema = testName();

  await withAdmin(connectionString, async (admin) => {
    await sql`create schema ${sql.id(schema)}`.execute(admin);
  });

  const db = createDatabase({ connectionString, maxConnections: 4, schema });
  async function destroy() {
    await db.destroy();
    await dropTestSchema(schema);
  }

  try {
    await withSchemaLock(connectionString, "shared", () =>
      asDeployed ? migrateToLatest(db) : migrateToLatest(db, { schema }),
    );
  } catch (error) {
    await destroy();
    throw error;
  }
  return { db, schema, destroy };
}

/**
 * Drops a test schema, holding SCHEMA_LOCK exclusively, as other files'
 * migrators list every table while they run.
 */
export async function dropTestSchema(schema: string): Promise<void> {
  await withSchemaLock(loadConfig().databaseUrl, "exclusive", (connection) =>
    sql`drop schema if exists ${sql.id(schema)} cascade`.execute(connection),
  );
}

/**
 * Moves a test database to a migration, back or forward ("latest" for the
 * newest), for tests of migrations themselves, and returns what ran. Going
 * back drops tables, as destroy() drops a schema, so it holds SCHEMA_LOCK
 * exclusively too: other files' migrators list every table while they run.
 */
export async function migrateTestDatabase(
  testDb: TestDatabase,
  target: string,
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: testDb.db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    migrationTableSchema: testDb.schema,
  });
  let ran: MigrationResult[] = [];
  await withSchemaLock(loadConfig().databaseUrl, "exclusive", async () => {
    const { error, results = [] } =
      target === "latest" ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
    if (error !== undefined) {
      throw new Error(`Migrating the test database to ${target} failed`, { cause: error });
    }
    ran = results;
  });
  return ran;
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
