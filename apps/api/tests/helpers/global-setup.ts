import { dropStaleTestDatabases } from "./stale-test-databases.ts";

/**
 * Runs once before the API's test files (vite.config.ts, test.globalSetup):
 * drops the test schemas and databases runs that were cut off left behind.
 * Without the databases running, it says so and lets the tests fail with
 * their own messages.
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
