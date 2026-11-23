import type { Migration } from "kysely/migration";

import * as createSchema from "./0001_create_schema.ts";
import * as notificationChannels from "./0002_notification_channels.ts";
import * as alertRules from "./0003_alert_rules.ts";
import * as telemetryRuleEvaluation from "./0004_telemetry_rule_evaluation.ts";
import * as replayDetails from "./0005_replay_details.ts";
import * as access from "./0006_access.ts";
import * as overview from "./0007_overview.ts";
import * as spamRules from "./0008_spam_rules.ts";
import * as locationDataUpdates from "./0009_location_data_updates.ts";
import * as storageWarnings from "./0010_storage_warnings.ts";
import * as heatmaps from "./0011_heatmaps.ts";
import * as heatmapOverlayTokens from "./0012_heatmap_overlay_tokens.ts";
import * as accountEmails from "./0013_account_emails.ts";
import * as backups from "./0014_backups.ts";
import * as projectStars from "./0015_project_stars.ts";
import * as notifications from "./0016_notifications.ts";
import * as avatars from "./0017_avatars.ts";
import * as aiCostHours from "./0018_ai_cost_hours.ts";
import * as aiModelPrices from "./0019_ai_model_prices.ts";
import * as backupDestinationEnv from "./0020_backup_destination_env.ts";
import * as alertHistoryKind from "./0021_alert_history_kind.ts";
import * as aiArea from "./0022_ai_area.ts";
import * as heatmapSnapshots from "./0023_heatmap_snapshots.ts";
import * as ingestActivity from "./0024_ingest_activity.ts";

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
  "0004_telemetry_rule_evaluation": telemetryRuleEvaluation,
  "0005_replay_details": replayDetails,
  "0006_access": access,
  "0007_overview": overview,
  "0008_spam_rules": spamRules,
  "0009_location_data_updates": locationDataUpdates,
  "0010_storage_warnings": storageWarnings,
  "0011_heatmaps": heatmaps,
  "0012_heatmap_overlay_tokens": heatmapOverlayTokens,
  "0013_account_emails": accountEmails,
  "0014_backups": backups,
  "0015_project_stars": projectStars,
  "0016_notifications": notifications,
  "0017_avatars": avatars,
  "0018_ai_cost_hours": aiCostHours,
  "0019_ai_model_prices": aiModelPrices,
  "0020_backup_destination_env": backupDestinationEnv,
  "0021_alert_history_kind": alertHistoryKind,
  "0022_ai_area": aiArea,
  "0023_heatmap_snapshots": heatmapSnapshots,
  "0024_ingest_activity": ingestActivity,
};
