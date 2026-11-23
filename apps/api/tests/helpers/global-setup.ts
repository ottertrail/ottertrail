import { dropStaleTestDatabases } from "./stale-test-databases.ts";

/**
 * Clean up interrupted runs before API tests (vite.config.ts, test.globalSetup).
 * If databases are unavailable, let each test report its own failure.
 */
export default async function setup(): Promise<void> {
  try {
    const { schemas, databases } = await dropStaleTestDatabases();
    const dropped = schemas.length + databases.length;
    if (dropped > 0) {
      console.log(
        `Dropped ${schemas.length} PostgreSQL schemas and ${databases.length} ClickHouse databases left over from earlier test runs.`,
      );
    }
  } catch (error) {
    console.warn("Could not look for test databases left over from earlier runs:", error);
  }
}
