/**
 * Command-line entry point: brings the database schema up to date.
 * Run it as a deployment step before starting the API, not from the API
 * itself, so several API processes never race to migrate.
 */
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { migrateToLatest } from "./db/migrate.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });

try {
  const results = await migrateToLatest(db);
  if (results.length === 0) {
    console.log("Database is up to date; no migrations to run.");
  }
  for (const result of results) {
    console.log(
      `${result.status === "Success" ? "applied" : result.status}: ${result.migrationName}`,
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
