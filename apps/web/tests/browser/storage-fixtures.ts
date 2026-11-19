import type { StorageReport, StorageWarning } from "../../src/lib/storage-api.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/**
 * GET /api/settings/storage on an instance with the stack's Garage and its
 * admin token: a 100 GiB disk, 60 GiB free, no warnings, two channels to
 * choose from and none chosen.
 */
export const STORAGE: StorageReport = {
  measuredAt: "2026-11-19T04:00:00.000Z",
  objectStore: "garage",
  disk: { ok: true, totalBytes: 100 * GiB, freeBytes: 60 * GiB, readOnly: false, broken: false },
  budgets: {
    ok: true,
    replays: { usedBytes: 512 * MiB, limitBytes: 2 * GiB },
    sourceMaps: { usedBytes: 100 * MiB, limitBytes: 1 * GiB },
  },
  clickhouse: {
    ok: true,
    tables: [
      {
        name: "events",
        bytes: 20 * GiB,
        rows: 90_000_000,
        retention: { kind: "projects", keptForever: 1 },
      },
      { name: "spans", bytes: 6 * GiB, rows: 40_000_000, retention: { kind: "days", days: 30 } },
      {
        name: "check_results",
        bytes: 200 * MiB,
        rows: 300_000,
        retention: { kind: "days", days: 90 },
      },
    ],
    totalBytes: 26 * GiB + 200 * MiB,
    largestPartition: { table: "events", partition: "202611", bytes: 4 * GiB },
  },
  postgres: {
    ok: true,
    databaseBytes: 3 * GiB,
    tables: [
      { name: "replay_chunks", bytes: 2 * GiB },
      { name: "notification_deliveries", bytes: 300 * MiB },
    ],
  },
  garage: {
    state: "ok",
    bucket: { objects: 1234, bytes: 620 * MiB, quotaBytes: Math.ceil(3 * GiB * 1.1) },
    dataPartition: { availableBytes: 60 * GiB, totalBytes: 100 * GiB },
    plannedQuotaBytes: Math.ceil(3 * GiB * 1.1),
    quotaAboveBudgets: false,
  },
  warnings: [],
  held: [],
  undetermined: [],
  warningChannels: {
    channelIds: [],
    channels: [
      { id: "channel-ops", name: "Ops email", kind: "email" },
      { id: "channel-hook", name: "Pager webhook", kind: "webhook" },
    ],
  },
};

export const DISK_WARNING: StorageWarning = {
  id: "disk_used",
  level: "critical",
  title: "The disk is 93% full",
  text: "7 GB of 100 GB is free. When the disk is full, ClickHouse refuses events (collection answers 503) and PostgreSQL can stop, which takes the whole instance down.",
};

export const BUDGET_WARNING: StorageWarning = {
  id: "replay_budget",
  level: "warning",
  title: "Session replays use 95% of their budget",
  text: "Replays take 1.9 GB of the 2 GB REPLAY_STORAGE_BYTES allows.",
};
