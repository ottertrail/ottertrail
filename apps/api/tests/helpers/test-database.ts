import { type DatabaseIntrospector, type Kysely, sql } from "kysely";
import { type MigrationResult, Migrator } from "kysely/migration";

import { loadConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrate.ts";
import { migrations } from "../../src/db/migrations/index.ts";
import type { Database } from "../../src/db/schema.ts";
import { testName } from "./test-names.ts";

/**
 * Test files run in parallel, each in its own schema. Kysely's migrator
 * checks for its bookkeeping tables by listing every column of every table
 * in every schema, which under a full run is both slow (a dozen test
 * schemas of 50 tables each) and fragile: the listing fails ("schema … does
 * not exist") if another file drops its schema in the middle of it.
 *
 * So a test schema's own migrations list only that schema (schemaScoped),
 * and need no lock. Only a migration that lists every schema, as `vp run
 * migrate` does (createTestDatabase's `asDeployed`), holds this PostgreSQL
 * advisory lock exclusively; dropping a schema, or tables in one, holds it
 * shared, so drops run side by side and wait only for such a listing.
 * (Before, every migration held it shared and every drop exclusively: under
 * load drops queued behind migrations and migrations behind drops, and a
 * test that made a dashboard of its own waited seconds for the lock twice.)
 */
const SCHEMA_LOCK = 4_281_708_001;

/**
 * The time limit for a test that makes a schema of its own and moves it
 * back or forward (migrateTestDatabase): each move runs a dozen migrations
 * or more, which a busy machine can take tens of seconds over.
 */
export const MIGRATION_TEST_MS = 90_000;

/**
 * `db`, for Kysely's migrator, with an introspector that lists the tables
 * of the connection's own schema (its search path, the test schema) only.
 * The migrator reads nothing but their names and schemas.
 */
function schemaScoped(db: Kysely<Database>): Kysely<Database> {
  const introspection: DatabaseIntrospector = {
    getSchemas: () => db.introspection.getSchemas(),
    getTables: async () => {
      const { rows } = await sql<{ name: string; schema: string; kind: string }>`
        select c.relname as name, n.nspname as schema, c.relkind as kind
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind in ('r', 'v', 'p', 'f')
      `.execute(db);
      return rows.map((row) => ({
        name: row.name,
        schema: row.schema,
        isView: row.kind === "v",
        isForeign: row.kind === "f",
        columns: [],
      }));
    },
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "introspection") return introspection;
      // Kysely's methods read private fields: call them on the real instance.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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
    // As deployed, Kysely lists every schema: no drop may run meanwhile.
    await (asDeployed
      ? withSchemaLock(connectionString, "exclusive", () => migrateToLatest(db))
      : migrateToLatest(schemaScoped(db), { schema }));
  } catch (error) {
    await destroy();
    throw error;
  }
  return { db, schema, destroy };
}

/**
 * Drops a test schema, holding SCHEMA_LOCK shared: never while a migration
 * lists every schema (createTestDatabase's `asDeployed`).
 */
export async function dropTestSchema(schema: string): Promise<void> {
  await withSchemaLock(loadConfig().databaseUrl, "shared", (connection) =>
    sql`drop schema if exists ${sql.id(schema)} cascade`.execute(connection),
  );
}

/**
 * Moves a test database to a migration, back or forward ("latest" for the
 * newest), for tests of migrations themselves, and returns what ran. Going
 * back drops tables, as destroy() drops a schema, so it holds SCHEMA_LOCK
 * shared too.
 */
export async function migrateTestDatabase(
  testDb: TestDatabase,
  target: string,
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: schemaScoped(testDb.db),
    provider: { getMigrations: () => Promise.resolve(migrations) },
    migrationTableSchema: testDb.schema,
  });
  let ran: MigrationResult[] = [];
  await withSchemaLock(loadConfig().databaseUrl, "shared", async () => {
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
