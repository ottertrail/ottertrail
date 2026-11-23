import { type DatabaseIntrospector, type Kysely, sql } from "kysely";
import { type MigrationResult, Migrator } from "kysely/migration";

import { loadConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrate.ts";
import { migrations } from "../../src/db/migrations/index.ts";
import type { Database } from "../../src/db/schema.ts";
import { testName } from "./test-names.ts";

/**
 * Kysely's all-schema listing can fail if another test drops a schema.
 * schemaScoped avoids the listing and needs no lock.
 *
 * asDeployed migrations take this advisory lock exclusively. Schema and
 * table drops share it, so they can run together but wait for listings.
 */
const SCHEMA_LOCK = 4_281_708_001;

/** Migration tests can take tens of seconds on a busy machine. */
export const MIGRATION_TEST_MS = 90_000;

/**
 * Limit introspection to the connection's schema to avoid other tests' drops.
 * The migrator only needs table names and schemas.
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
  schema: string;
  destroy(): Promise<void>;
}

/**
 * Isolates each test file from development data. Call destroy() after use.
 *
 * Needs the local database: `podman compose up -d` (or `docker compose up -d`).
 *
 * `asDeployed` tests the `vp run migrate` path without naming the schema.
 */
export async function createTestDatabase({
  asDeployed = false,
}: { asDeployed?: boolean } = {}): Promise<TestDatabase> {
  const connectionString = loadConfig().databaseUrl;
  // The timestamp lets later runs clean up after an interrupted run.
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
 * Share SCHEMA_LOCK to wait for all-schema migration listings.
 */
export async function dropTestSchema(schema: string): Promise<void> {
  await withSchemaLock(loadConfig().databaseUrl, "shared", (connection) =>
    sql`drop schema if exists ${sql.id(schema)} cascade`.execute(connection),
  );
}

/**
 * Use "latest" for the newest migration. Rollbacks drop tables, so share
 * SCHEMA_LOCK to wait for all-schema listings.
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
