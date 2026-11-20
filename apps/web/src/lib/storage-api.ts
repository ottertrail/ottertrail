import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * The instance's storage (GET /api/settings/storage; docs/deployment.md,
 * "Storage"): what fills the server's disk, the warnings, and the channels
 * that get them. The owner and admins only.
 */

/** A store's figures, or why they could not be measured. */
export type Measured<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface Budget {
  usedBytes: number;
  limitBytes: number;
}

export type Retention =
  | { kind: "days"; days: number }
  | { kind: "projects"; keptForever: number | null }
  | { kind: "with_events" }
  | { kind: "none" };

export interface Disk {
  totalBytes: number;
  freeBytes: number;
  readOnly: boolean;
  broken: boolean;
}

export type WarningLevel = "warning" | "critical";

export interface StorageWarning {
  id: string;
  level: WarningLevel;
  title: string;
  text: string;
}

export interface HeldWarning {
  id: string;
  level: WarningLevel;
  title: string;
  /** When it started. */
  since: string;
}

export type GarageStatus =
  | { state: "no_token"; message: string }
  | { state: "failed"; error: string }
  | {
      state: "ok";
      bucket: { objects: number; bytes: number; quotaBytes: number | null } | null;
      dataPartition: { availableBytes: number; totalBytes: number } | null;
      plannedQuotaBytes: number;
      /** The quota sits above the budgets plus 10%, as the bucket holds more than they allow. */
      quotaAboveBudgets: boolean;
    };

export interface ChannelChoice {
  id: string;
  name: string;
  kind: "email" | "webhook";
}

export interface WarningChannels {
  channelIds: string[];
  channels: ChannelChoice[];
}

export interface StorageReport {
  measuredAt: string;
  objectStore: "none" | "garage" | "other";
  disk: Measured<Disk>;
  budgets: Measured<{ replays: Budget; sourceMaps: Budget }> | null;
  clickhouse: Measured<{
    tables: { name: string; bytes: number; rows: number; retention: Retention }[];
    totalBytes: number;
    largestPartition: { table: string; partition: string; bytes: number } | null;
  }>;
  postgres: Measured<{ databaseBytes: number; tables: { name: string; bytes: number }[] }>;
  garage: GarageStatus | null;
  warnings: StorageWarning[];
  /** On when last measured, and not measured now: still on. */
  held: HeldWarning[];
  /** The warnings that could not be worked out now, as their figures were not measured. */
  undetermined: string[];
  warningChannels: WarningChannels;
  /** Scheduled backups: off says since when and by whom; absent from an older API. */
  backups?: { enabled: boolean; disabledAt: string | null; disabledBy: string | null } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";

/** A measured store: its failure, or figures that pass `ok`. */
const isMeasured = (value: unknown, ok: (record: Record<string, unknown>) => boolean) =>
  isRecord(value) && (value.ok === false ? isText(value.error) : value.ok === true && ok(value));

const isBudget = (value: unknown) =>
  isRecord(value) && isNumber(value.usedBytes) && isNumber(value.limitBytes);

const isWarningChannels = (value: unknown): value is WarningChannels =>
  isRecord(value) &&
  Array.isArray(value.channelIds) &&
  value.channelIds.every(isText) &&
  Array.isArray(value.channels) &&
  value.channels.every(
    (channel) =>
      isRecord(channel) &&
      isText(channel.id) &&
      isText(channel.name) &&
      (channel.kind === "email" || channel.kind === "webhook"),
  );

const isGarage = (value: unknown) =>
  value === null ||
  (isRecord(value) &&
    ((value.state === "no_token" && isText(value.message)) ||
      (value.state === "failed" && isText(value.error)) ||
      (value.state === "ok" &&
        isNumber(value.plannedQuotaBytes) &&
        typeof value.quotaAboveBudgets === "boolean")));

const isReport = (value: unknown): value is StorageReport =>
  isRecord(value) &&
  isText(value.measuredAt) &&
  (value.objectStore === "none" ||
    value.objectStore === "garage" ||
    value.objectStore === "other") &&
  isMeasured(value.disk, (disk) => isNumber(disk.totalBytes) && isNumber(disk.freeBytes)) &&
  (value.budgets === null ||
    isMeasured(
      value.budgets,
      (budgets) => isBudget(budgets.replays) && isBudget(budgets.sourceMaps),
    )) &&
  isMeasured(
    value.clickhouse,
    (clickhouse) => Array.isArray(clickhouse.tables) && isNumber(clickhouse.totalBytes),
  ) &&
  isMeasured(
    value.postgres,
    (postgres) => isNumber(postgres.databaseBytes) && Array.isArray(postgres.tables),
  ) &&
  isGarage(value.garage) &&
  Array.isArray(value.warnings) &&
  value.warnings.every(
    (warning) =>
      isRecord(warning) &&
      isText(warning.id) &&
      (warning.level === "warning" || warning.level === "critical") &&
      isText(warning.title) &&
      isText(warning.text),
  ) &&
  Array.isArray(value.held) &&
  value.held.every(
    (warning) =>
      isRecord(warning) &&
      isText(warning.id) &&
      (warning.level === "warning" || warning.level === "critical") &&
      isText(warning.title) &&
      isText(warning.since),
  ) &&
  Array.isArray(value.undetermined) &&
  value.undetermined.every(isText) &&
  isWarningChannels(value.warningChannels);

export const storageQuery = () =>
  queryOptions({
    queryKey: ["settings", "storage"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings/storage", { signal }), isReport),
  });

/** Chooses the channels that get storage warnings; none sends them nowhere. */
export async function updateWarningChannels(channelIds: string[]): Promise<WarningChannels> {
  const body = await apiRequest("/api/settings/storage", {
    method: "PATCH",
    body: { warningChannelIds: channelIds },
  });
  return expectShape(
    body,
    (value): value is { warningChannels: WarningChannels } =>
      isRecord(value) && isWarningChannels(value.warningChannels),
  ).warningChannels;
}
