import type { Kysely } from "kysely";
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

/**
 * Applies the migrations up to and including `target`, as migrateToLatest()
 * does. Only forward: a database already past `target` is an error, never
 * migrated back, which would drop the later migrations' tables.
 */
export async function migrate(
  db: Kysely<Database>,
  target: string,
  options: { schema?: string } = {},
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    // Kysely's bookkeeping tables (kysely_migration, kysely_migration_lock)
    // must live in the same schema as the tables they track. Without this,
    // Kysely would find the ones in "public" and skip creating its own.
    ...(options.schema === undefined ? {} : { migrationTableSchema: options.schema }),
  });
  if (target !== "latest") {
    const known = await migrator.getMigrations();
    const position = known.findIndex((migration) => migration.name === target);
    if (position === -1) throw new Error(`No migration is named ${target}`);
    const past = known.slice(position + 1).find((migration) => migration.executedAt !== undefined);
    if (past !== undefined) {
      throw new Error(
        `The database is past ${target} (${past.name} ran); migrate() never goes back`,
      );
    }
  }
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
