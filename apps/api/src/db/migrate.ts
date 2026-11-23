import { type Kysely, sql } from "kysely";
import { type MigrationResult, Migrator } from "kysely/migration";

import { migrations } from "./migrations/index.ts";
import type { Database } from "./schema.ts";

/** Skips completed migrations. PostgreSQL rolls back the whole run if any migration fails. */
export async function migrateToLatest(
  db: Kysely<Database>,
  options: { schema?: string } = {},
): Promise<MigrationResult[]> {
  return migrate(db, "latest", options);
}

async function migrate(
  db: Kysely<Database>,
  target: string,
  options: { schema?: string } = {},
): Promise<MigrationResult[]> {
  // Set the schema explicitly so Kysely does not find a test schema's migration tables
  // and skip creating its own. Defaults to the connection's schema (usually "public").
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

async function currentSchema(db: Kysely<Database>): Promise<string | undefined> {
  const { rows } = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(
    db,
  );
  return rows[0]?.schema ?? undefined;
}
