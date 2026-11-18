import { type Kysely, sql } from "kysely";
import { type MigrationResult, Migrator } from "kysely/migration";

import { migrations } from "./migrations/index.ts";
import type { Database } from "./schema.ts";

/**
 * Applies every migration that has not run yet. Safe to run repeatedly:
 * migrations that already ran are skipped. On PostgreSQL the whole run is
 * one transaction, so if any migration fails, the database is left unchanged.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  options: { schema?: string } = {},
): Promise<MigrationResult[]> {
  return migrate(db, "latest", options);
}

/** Applies the migrations up to and including `target` ("latest" for all). */
async function migrate(
  db: Kysely<Database>,
  target: string,
  options: { schema?: string } = {},
): Promise<MigrationResult[]> {
  // Kysely's bookkeeping tables (kysely_migration, kysely_migration_lock)
  // must live in the same schema as the tables they track, so it is always
  // named: the given one, else the connection's own ("public" by default).
  // Unnamed, Kysely looks for them in every schema, finds a test schema's,
  // skips creating its own, and then fails to read them.
  const schema = options.schema ?? (await currentSchema(db));
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    ...(schema === undefined ? {} : { migrationTableSchema: schema }),
  });
  const { error, results = [] } =
    target === "latest" ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
  if (error !== undefined) {
    const failed = results.find((result) => result.status === "Error");
    throw new Error(
      failed === undefined ? "Migration failed" : `Migration ${failed.migrationName} failed`,
      { cause: error },
    );
  }
  return results;
}

/** The first schema of the connection's search path that exists; undefined when none does. */
async function currentSchema(db: Kysely<Database>): Promise<string | undefined> {
  const { rows } = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(
    db,
  );
  return rows[0]?.schema ?? undefined;
}
