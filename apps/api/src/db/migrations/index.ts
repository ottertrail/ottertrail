import type { Migration } from "kysely/migration";

import * as createProjectsAndEvents from "./0001_create_projects_and_events.ts";
import * as addProjectKeysAndHostnames from "./0002_add_project_keys_and_hostnames.ts";
import * as addEventEnrichment from "./0003_add_event_enrichment.ts";
import * as addVisitorIds from "./0004_add_visitor_ids.ts";
import * as addPreviousVisitorId from "./0005_add_previous_visitor_id.ts";
import * as dropPreviousVisitorId from "./0006_drop_previous_visitor_id.ts";
import * as loosenPropertiesSizeCheck from "./0007_loosen_properties_size_check.ts";
import * as addDashboardAuth from "./0008_add_dashboard_auth.ts";
import * as addProjectRetention from "./0009_add_project_retention.ts";
import * as addOrganizations from "./0010_add_organizations.ts";
import * as addEventsCopiedAt from "./0011_add_events_copied_at.ts";
import * as addProjectsLastEventAt from "./0012_add_projects_last_event_at.ts";
import * as addProjectDeletions from "./0013_add_project_deletions.ts";
import * as addEventsEnvironmentAndRelease from "./0014_add_events_environment_and_release.ts";
import * as addEventsUserId from "./0015_add_events_user_id.ts";
import * as addProjectSecretKeys from "./0016_add_project_secret_keys.ts";
import * as addIgnoreDataCenters from "./0017_add_ignore_data_centers.ts";
import * as addEventErrors from "./0018_add_event_errors.ts";
import * as createErrorResolutions from "./0019_create_error_resolutions.ts";
import * as createGoals from "./0020_create_goals.ts";
import * as createSavedFunnels from "./0021_create_saved_funnels.ts";
import * as createSourceMaps from "./0022_create_source_maps.ts";
import * as createReplays from "./0023_create_replays.ts";
import * as dropEvents from "./0024_drop_events.ts";
import * as widenReplayChunkNumbers from "./0025_widen_replay_chunk_numbers.ts";
import * as createUptimeChecks from "./0026_create_uptime_checks.ts";

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
  "0006_drop_previous_visitor_id": dropPreviousVisitorId,
  "0007_loosen_properties_size_check": loosenPropertiesSizeCheck,
  "0008_add_dashboard_auth": addDashboardAuth,
  "0009_add_project_retention": addProjectRetention,
  "0010_add_organizations": addOrganizations,
  "0011_add_events_copied_at": addEventsCopiedAt,
  "0012_add_projects_last_event_at": addProjectsLastEventAt,
  "0013_add_project_deletions": addProjectDeletions,
  "0014_add_events_environment_and_release": addEventsEnvironmentAndRelease,
  "0015_add_events_user_id": addEventsUserId,
  "0016_add_project_secret_keys": addProjectSecretKeys,
  "0017_add_ignore_data_centers": addIgnoreDataCenters,
  "0018_add_event_errors": addEventErrors,
  "0019_create_error_resolutions": createErrorResolutions,
  "0020_create_goals": createGoals,
  "0021_create_saved_funnels": createSavedFunnels,
  "0022_create_source_maps": createSourceMaps,
  "0023_create_replays": createReplays,
  "0024_drop_events": dropEvents,
  "0025_widen_replay_chunk_numbers": widenReplayChunkNumbers,
  "0026_create_uptime_checks": createUptimeChecks,
};
