import type { Migration } from "kysely/migration";

import * as createSchema from "./0001_create_schema.ts";
import * as notificationChannels from "./0002_notification_channels.ts";
import * as alertRules from "./0003_alert_rules.ts";

/**
 * Every migration, in order. Kysely runs them by name, alphabetically, and
 * records which ones have run in the kysely_migration table.
 *
 * Migrations are imported here instead of read from disk at runtime, so the
 * bundled build (dist/) contains them.
 */
export const migrations: Record<string, Migration> = {
  "0001_create_schema": createSchema,
  "0002_notification_channels": notificationChannels,
  "0003_alert_rules": alertRules,
};
