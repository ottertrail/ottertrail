import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * Owner-only backups (GET /api/settings/backups; docs/deployment.md, "Backups").
 * Destination details come from the worker, excluding BACKUP_S3_* secrets.
 * Fetch the backup key only on request through its own route; never cache it.
 */

export interface BackupRun {
  kind: "backup" | "test_restore";
  trigger: "schedule" | "manual" | "retry";
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Encrypted bytes uploaded (a backup) or checked (a test restore). */
  bytes: number | null;
  /** The backup's folder name, its UTC time. */
  folder: string | null;
  error: string | null;
}

export interface BackupSettings {
  enabled: boolean;
  /** "HH:MM" in the instance's timezone. */
  timeOfDay: string;
  keepDays: number;
  /** Since when, and by whom, backups are off; null while on, or never turned on. */
  disabledAt: string | null;
  disabledBy: string | null;
}

/** The destination's parts the worker reports: never its secret. */
export interface DestinationConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
}

export interface ConnectionStep {
  step: "put" | "list" | "get" | "delete";
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface ConnectionTest {
  ok: boolean;
  steps: ConnectionStep[];
  /** Why no step ran: no destination, or a problem with it. */
  error?: string;
}

export interface Backups {
  settings: BackupSettings;
  /** What the worker last reported of its BACKUP_S3_*, and when; all null before it has. */
  destination: {
    reportedAt: string | null;
    config: DestinationConfig | null;
    problem: string | null;
    /** Over two hours old: the worker reports hourly, so it may be stopped. */
    stale: boolean;
  };
  /** Test connection: asked for and not yet run, and the last result. */
  connectionTest: {
    requested: boolean;
    /** Asked for, and no worker took it within a few minutes: a new request replaces it. */
    untaken: boolean;
    testedAt: string | null;
    result: ConnectionTest | null;
  };
  key: {
    state: "none" | "ready" | "unreadable";
    recipient: string | null;
    createdAt: string | null;
    /** Null until the owner confirms saving the key; controls the reminder. */
    savedAt: string | null;
  };
  status: {
    now: string;
    running: BackupRun | null;
    lastBackup: BackupRun | null;
    lastSuccess: BackupRun | null;
    lastTestRestore: BackupRun | null;
    nextDueAt: string | null;
    /** The daily time since which no backup worked, three hours on. */
    overdueSince: string | null;
    retryAt: string | null;
    backupRequested: boolean;
    testRestoreRequested: boolean;
    listedAt: string | null;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";
const isNumberOrNull = (value: unknown) => value === null || typeof value === "number";

const isDestinationConfig = (value: unknown): value is DestinationConfig | null =>
  value === null ||
  (isRecord(value) &&
    isText(value.endpoint) &&
    isText(value.region) &&
    isText(value.bucket) &&
    isText(value.prefix) &&
    isText(value.accessKeyId));

const isConnectionTest = (value: unknown): value is ConnectionTest =>
  isRecord(value) &&
  typeof value.ok === "boolean" &&
  (value.error === undefined || isText(value.error)) &&
  Array.isArray(value.steps) &&
  value.steps.every(
    (step) =>
      isRecord(step) &&
      (step.step === "put" ||
        step.step === "list" ||
        step.step === "get" ||
        step.step === "delete") &&
      (step.status === "ok" || step.status === "failed" || step.status === "skipped"),
  );

const isRun = (value: unknown): value is BackupRun | null =>
  value === null ||
  (isRecord(value) &&
    (value.kind === "backup" || value.kind === "test_restore") &&
    (value.trigger === "schedule" || value.trigger === "manual" || value.trigger === "retry") &&
    (value.status === "running" || value.status === "succeeded" || value.status === "failed") &&
    isText(value.startedAt) &&
    isTextOrNull(value.finishedAt) &&
    isNumberOrNull(value.durationMs) &&
    isNumberOrNull(value.bytes) &&
    isTextOrNull(value.folder) &&
    isTextOrNull(value.error));

const isBackups = (value: unknown): value is Backups => {
  if (!isRecord(value)) return false;
  const { settings, destination, connectionTest, key, status } = value;
  return (
    isRecord(settings) &&
    typeof settings.enabled === "boolean" &&
    isText(settings.timeOfDay) &&
    typeof settings.keepDays === "number" &&
    isTextOrNull(settings.disabledAt) &&
    isTextOrNull(settings.disabledBy) &&
    isRecord(destination) &&
    isTextOrNull(destination.reportedAt) &&
    isDestinationConfig(destination.config) &&
    isTextOrNull(destination.problem) &&
    typeof destination.stale === "boolean" &&
    isRecord(connectionTest) &&
    typeof connectionTest.requested === "boolean" &&
    typeof connectionTest.untaken === "boolean" &&
    isTextOrNull(connectionTest.testedAt) &&
    (connectionTest.result === null || isConnectionTest(connectionTest.result)) &&
    isRecord(key) &&
    (key.state === "none" || key.state === "ready" || key.state === "unreadable") &&
    isTextOrNull(key.recipient) &&
    isTextOrNull(key.createdAt) &&
    isTextOrNull(key.savedAt) &&
    isRecord(status) &&
    isText(status.now) &&
    isRun(status.running) &&
    isRun(status.lastBackup) &&
    isRun(status.lastSuccess) &&
    isRun(status.lastTestRestore) &&
    isTextOrNull(status.nextDueAt) &&
    isTextOrNull(status.overdueSince) &&
    isTextOrNull(status.retryAt) &&
    typeof status.backupRequested === "boolean" &&
    typeof status.testRestoreRequested === "boolean" &&
    isTextOrNull(status.listedAt)
  );
};

export const backupsQuery = () =>
  queryOptions({
    queryKey: ["settings", "backups"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings/backups", { signal }), isBackups),
  });

export interface BackupChanges {
  enabled?: boolean;
  timeOfDay?: string;
  keepDays?: number;
  /** Needed to turn backups off. */
  currentPassword?: string;
}

export async function updateBackups(changes: BackupChanges): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups", { method: "PATCH", body: changes }),
    isBackups,
  );
}

/** Test connection: the worker runs it on its next tick, with its own variables. */
export async function testConnection(): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups/test-connection", { method: "POST", body: {} }),
    isBackups,
  );
}

/** Back up now: the worker takes it within half a minute. */
export async function backUpNow(): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups/run", { method: "POST", body: {} }),
    isBackups,
  );
}

/** Test restore: the worker downloads the newest backup and checks it. */
export async function testRestore(): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups/test-restore", { method: "POST", body: {} }),
    isBackups,
  );
}

export async function confirmKeySaved(): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups/key/saved", { method: "POST", body: {} }),
    isBackups,
  );
}

export async function replaceKey(): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups/key/replace", { method: "POST", body: {} }),
    isBackups,
  );
}

export interface BackupKey {
  key: string;
  recipient: string;
  createdAt: string;
}

const isKey = (value: unknown): value is BackupKey =>
  isRecord(value) && isText(value.key) && isText(value.recipient) && isText(value.createdAt);

/** The key, to show: fetched only when asked, and kept by the section, not the query cache. */
export async function fetchBackupKey(password: string): Promise<BackupKey> {
  return expectShape(
    await apiRequest("/api/settings/backups/key", { method: "POST", body: { password } }),
    isKey,
  );
}

/** The key file's text and name, for a download made in the page. */
export async function fetchBackupKeyFile(
  password: string,
): Promise<{ text: string; fileName: string }> {
  let response: Response;
  try {
    response = await fetch("/api/settings/backups/key/file", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new Error("Could not reach the API. Check that it is running. Then try again.");
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : `The download failed (HTTP ${response.status}).`,
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "ottertrail-backup-key.txt";
  return { text: await response.text(), fileName };
}

export interface ListedBackup {
  name: string;
  at: string;
  bytes: number;
  complete: boolean;
}

/** The folder's backups as the worker last listed them, or why it couldn't; nothing before it has. */
export type BackupList =
  | { listedAt: null }
  | { listedAt: string; ok: true; bucket: string; prefix: string; backups: ListedBackup[] }
  | { listedAt: string; ok: false; bucket: string; prefix: string; error: string };

const isList = (value: unknown): value is BackupList =>
  isRecord(value) &&
  (value.listedAt === null ||
    (isText(value.listedAt) &&
      isText(value.bucket) &&
      isText(value.prefix) &&
      ((value.ok === false && isText(value.error)) ||
        (value.ok === true &&
          Array.isArray(value.backups) &&
          value.backups.every(
            (item) =>
              isRecord(item) &&
              isText(item.name) &&
              isText(item.at) &&
              typeof item.bytes === "number" &&
              typeof item.complete === "boolean",
          )))));

export const backupListQuery = () =>
  queryOptions({
    queryKey: ["settings", "backups", "list"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings/backups/list", { signal }), isList),
  });
