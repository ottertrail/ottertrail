import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * Scheduled backups (GET /api/settings/backups and its routes;
 * docs/deployment.md, "Backups"), for the owner only. The destination's
 * secret is never in an answer; the backup key only from its own route,
 * fetched when the owner asks to see it, and never cached.
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
  bucket: string | null;
  prefix: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  /** Whether a secret is saved, and whether the server can still read it; never the secret. */
  secret: "none" | "saved" | "unreadable";
  /** Since when, and by whom, backups are off; null while on, or never turned on. */
  disabledAt: string | null;
  disabledBy: string | null;
}

export interface Backups {
  settings: BackupSettings;
  destination:
    | {
        mode: "object_store";
        reason: "off_site";
        objectStore: { endpoint: string; bucket: string };
      }
    | { mode: "separate"; reason: "stack_garage" | "none"; objectStore: null };
  key: {
    state: "none" | "ready" | "unreadable";
    recipient: string | null;
    createdAt: string | null;
    /** When the owner said they saved the key; null while the reminder stays. */
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
    /** When a failed backup is tried once more. */
    retryAt: string | null;
    backupRequested: boolean;
    testRestoreRequested: boolean;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";
const isNumberOrNull = (value: unknown) => value === null || typeof value === "number";

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
  const { settings, destination, key, status } = value;
  return (
    isRecord(settings) &&
    typeof settings.enabled === "boolean" &&
    isText(settings.timeOfDay) &&
    typeof settings.keepDays === "number" &&
    isTextOrNull(settings.bucket) &&
    isText(settings.prefix) &&
    isTextOrNull(settings.endpoint) &&
    isTextOrNull(settings.region) &&
    isTextOrNull(settings.accessKeyId) &&
    (settings.secret === "none" ||
      settings.secret === "saved" ||
      settings.secret === "unreadable") &&
    isTextOrNull(settings.disabledAt) &&
    isTextOrNull(settings.disabledBy) &&
    isRecord(destination) &&
    (destination.mode === "object_store" || destination.mode === "separate") &&
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
    typeof status.testRestoreRequested === "boolean"
  );
};

export const backupsQuery = () =>
  queryOptions({
    queryKey: ["settings", "backups"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings/backups", { signal }), isBackups),
  });

/** What the form saves: a separate destination's fields only when it has one. */
export interface BackupChanges {
  enabled?: boolean;
  timeOfDay?: string;
  keepDays?: number;
  bucket?: string | null;
  prefix?: string;
  endpoint?: string | null;
  region?: string | null;
  accessKeyId?: string | null;
  /** Only when typed: left out, the saved one stays. */
  secretAccessKey?: string;
  /** Needed to change the destination or turn backups off. */
  currentPassword?: string;
}

export async function updateBackups(changes: BackupChanges): Promise<Backups> {
  return expectShape(
    await apiRequest("/api/settings/backups", { method: "PATCH", body: changes }),
    isBackups,
  );
}

export interface ConnectionStep {
  step: "put" | "list" | "get" | "delete";
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface ConnectionTest {
  ok: boolean;
  steps: ConnectionStep[];
}

const isConnectionTest = (value: unknown): value is ConnectionTest =>
  isRecord(value) &&
  typeof value.ok === "boolean" &&
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

/** Test connection, with the form's values (saved or not); the secret only when typed. */
export async function testConnection(
  fields: Omit<BackupChanges, "enabled" | "timeOfDay" | "keepDays">,
): Promise<ConnectionTest> {
  return expectShape(
    await apiRequest("/api/settings/backups/test-connection", { method: "POST", body: fields }),
    isConnectionTest,
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

export type BackupList =
  | { ok: true; bucket: string; prefix: string; backups: ListedBackup[] }
  | { ok: false; error: string };

const isList = (value: unknown): value is BackupList =>
  isRecord(value) &&
  ((value.ok === false && isText(value.error)) ||
    (value.ok === true &&
      isText(value.bucket) &&
      isText(value.prefix) &&
      Array.isArray(value.backups) &&
      value.backups.every(
        (item) =>
          isRecord(item) &&
          isText(item.name) &&
          isText(item.at) &&
          typeof item.bytes === "number" &&
          typeof item.complete === "boolean",
      )));

export const backupListQuery = () =>
  queryOptions({
    queryKey: ["settings", "backups", "list"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings/backups/list", { signal }), isList),
  });
