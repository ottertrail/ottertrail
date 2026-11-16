import type { Migration } from "kysely/migration";

import * as createProjectsAndEvents from "./0001_create_projects_and_events.ts";
import * as addProjectKeysAndHostnames from "./0002_add_project_keys_and_hostnames.ts";
import * as addEventEnrichment from "./0003_add_event_enrichment.ts";
import * as addVisitorIds from "./0004_add_visitor_ids.ts";
import * as addPreviousVisitorId from "./0005_add_previous_visitor_id.ts";

/**
 * Every migration, in order. Kysely runs them by name, alphabetically, and
 * records which ones have run in the kysely_migration table.
 *
 * Migrations are imported here instead of read from disk at runtime, so the
 * bundled build (dist/) contains them.
 */
export const migrations: Record<string, Migration> = {
  "0001_create_projects_and_events": createProjectsAndEvents,
  "0002_add_project_keys_and_hostnames": addProjectKeysAndHostnames,
  "0003_add_event_enrichment": addEventEnrichment,
  "0004_add_visitor_ids": addVisitorIds,
  "0005_add_previous_visitor_id": addPreviousVisitorId,
};
