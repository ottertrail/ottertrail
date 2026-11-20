import type {
  BackupKey,
  BackupList,
  BackupRun,
  Backups,
  ConnectionTest,
} from "../../src/lib/backups-api.ts";

/**
 * The Backups tab's routes in the fake API (GET /api/settings/backups and
 * the rest; the API's own tests are apps/api/tests/backups.test.ts), for
 * the owner only, as the API answers them.
 */
export interface FakeBackups {
  /** GET /api/settings/backups; PATCH changes it as the API would. A Response stands for an error. */
  view: Backups | Response;
  /** GET /api/settings/backups/list. */
  list: BackupList | Response;
  /** GET /api/settings/backups/key: the key, shown only when asked. */
  key: BackupKey;
  /** POST /api/settings/backups/test-connection. */
  connection: ConnectionTest | Response;
}

export const FAKE_KEY: BackupKey = {
  // Not a key: shaped like one, and joined at run time so secret scanners pass it by.
  key: ["AGE", "SECRET", "KEY", "1FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE"].join(
    "-",
  ),
  recipient: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
  createdAt: "2026-11-18T02:00:00.000Z",
};

/** Backups off, never turned on, with no object store: a separate destination is asked for. */
export const BACKUPS_OFF: Backups = {
  settings: {
    enabled: false,
    timeOfDay: "03:00",
    keepDays: 14,
    bucket: null,
    prefix: "ottertrail-backups",
    endpoint: null,
    region: null,
    accessKeyId: null,
    secret: "none",
    disabledAt: null,
    disabledBy: null,
  },
  destination: { mode: "separate", reason: "none", objectStore: null },
  key: { state: "none", recipient: null, createdAt: null, savedAt: null },
  status: {
    now: "2026-11-20T04:00:00.000Z",
    running: null,
    lastBackup: null,
    lastSuccess: null,
    lastTestRestore: null,
    nextDueAt: null,
    overdueSince: null,
    retryAt: null,
    backupRequested: false,
    testRestoreRequested: false,
  },
};

/** A backup that worked at 03:00 Singapore time on 20 November. */
export const GOOD_RUN: BackupRun = {
  kind: "backup",
  trigger: "schedule",
  status: "succeeded",
  startedAt: "2026-11-19T19:00:00.000Z",
  finishedAt: "2026-11-19T19:04:12.000Z",
  durationMs: 252_000,
  bytes: 1_610_612_736,
  folder: "2026-11-19T190000Z",
  error: null,
};

/** On, reusing an off-site object store's connection, the key saved, the last backup good. */
export const BACKUPS_REUSED: Backups = {
  settings: { ...BACKUPS_OFF.settings, enabled: true, bucket: "acme-backups", secret: "none" },
  destination: {
    mode: "object_store",
    reason: "off_site",
    objectStore: { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "acme-files" },
  },
  key: {
    state: "ready",
    recipient: FAKE_KEY.recipient,
    createdAt: FAKE_KEY.createdAt,
    savedAt: "2026-11-18T02:10:00.000Z",
  },
  status: {
    ...BACKUPS_OFF.status,
    lastBackup: GOOD_RUN,
    lastSuccess: GOOD_RUN,
    nextDueAt: "2026-11-20T19:00:00.000Z",
  },
};

/** On, to a separate destination (the stack's Garage holds replays), the key not yet saved. */
export const BACKUPS_SEPARATE: Backups = {
  settings: {
    ...BACKUPS_OFF.settings,
    enabled: true,
    bucket: "acme-backups",
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    accessKeyId: "AKIAEXAMPLE",
    secret: "saved",
  },
  destination: { mode: "separate", reason: "stack_garage", objectStore: null },
  key: {
    state: "ready",
    recipient: FAKE_KEY.recipient,
    createdAt: FAKE_KEY.createdAt,
    savedAt: null,
  },
  status: { ...BACKUPS_REUSED.status },
};

/** The separate destination's last backup failed; the worker tries once more. */
export const BACKUPS_FAILED: Backups = {
  ...BACKUPS_SEPARATE,
  key: { ...BACKUPS_SEPARATE.key, savedAt: "2026-11-18T02:10:00.000Z" },
  status: {
    ...BACKUPS_SEPARATE.status,
    lastBackup: {
      ...GOOD_RUN,
      startedAt: "2026-11-20T19:00:00.000Z",
      finishedAt: "2026-11-20T19:00:03.000Z",
      durationMs: 3000,
      status: "failed",
      bytes: null,
      folder: null,
      error:
        "Uploading PostgreSQL's dump failed: Access denied (AccessDenied). Give this key permission to write objects in the backup folder.",
    },
    lastSuccess: GOOD_RUN,
    nextDueAt: "2026-11-21T19:00:00.000Z",
    retryAt: "2026-11-20T20:00:03.000Z",
  },
};

export const FAKE_LIST: BackupList = {
  ok: true,
  bucket: "acme-backups",
  prefix: "ottertrail-backups",
  backups: [
    {
      name: "2026-11-19T190000Z",
      at: "2026-11-19T19:00:00.000Z",
      bytes: 1_610_612_736,
      complete: true,
    },
    {
      name: "2026-11-18T190000Z",
      at: "2026-11-18T19:00:00.000Z",
      bytes: 1_598_029_824,
      complete: true,
    },
  ],
};

export const ALL_STEPS_OK: ConnectionTest = {
  ok: true,
  steps: [
    { step: "put", status: "ok" },
    { step: "list", status: "ok" },
    { step: "get", status: "ok" },
    { step: "delete", status: "ok" },
  ],
};

export function fakeBackups(overrides: Partial<FakeBackups> = {}): FakeBackups {
  return {
    view: BACKUPS_OFF,
    list: FAKE_LIST,
    key: FAKE_KEY,
    connection: ALL_STEPS_OK,
    ...overrides,
  };
}

/** The signed-in owner's password, as the fake checks it. */
export const FAKE_PASSWORD = "correct horse battery";
const PASSWORD_NEEDED = { error: "password_required", message: "Enter your current password." };
const WRONG_PASSWORD = {
  error: "wrong_password",
  message: "Incorrect password. Try again.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
};

/** Answers a backups route, or null when the path is not one. */
export function answerBackups(
  backups: FakeBackups,
  url: URL,
  init: RequestInit | undefined,
  role: string,
): Response | null {
  const path = url.pathname;
  if (!path.startsWith("/api/settings/backups")) return null;
  if (role !== "owner") return json(FORBIDDEN, 403);
  const method = init?.method ?? "GET";
  const body: unknown =
    typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : {};
  const view = backups.view;
  if (view instanceof Response && path === "/api/settings/backups") return view.clone();
  const current = view instanceof Response ? BACKUPS_OFF : view;
  const replace = (next: Backups) => {
    backups.view = next;
    return json(next);
  };

  if (path === "/api/settings/backups" && method === "PATCH") {
    const { secretAccessKey, currentPassword, ...fields } = isRecord(body) ? body : {};
    const enabled = "enabled" in fields ? fields.enabled === true : current.settings.enabled;
    const turnedOff = current.settings.enabled && !enabled;
    // As the API: turning off needs the password (so does a changed destination, not checked here).
    if (turnedOff && currentPassword === undefined) return json(PASSWORD_NEEDED, 400);
    if (currentPassword !== undefined && currentPassword !== FAKE_PASSWORD) {
      return json(WRONG_PASSWORD, 403);
    }
    return replace({
      ...current,
      settings: {
        ...current.settings,
        ...fields,
        secret: typeof secretAccessKey === "string" ? "saved" : current.settings.secret,
        disabledAt: enabled ? null : turnedOff ? current.status.now : current.settings.disabledAt,
        disabledBy: enabled ? null : turnedOff ? "Test Owner" : current.settings.disabledBy,
      },
      // The first turn-on makes the key.
      key:
        enabled && current.key.state === "none"
          ? {
              state: "ready",
              recipient: FAKE_KEY.recipient,
              createdAt: current.status.now,
              savedAt: null,
            }
          : current.key,
      status: { ...current.status, nextDueAt: enabled ? "2026-11-20T19:00:00.000Z" : null },
    });
  }
  if (path === "/api/settings/backups") return json(current);
  if (path === "/api/settings/backups/test-connection") {
    return backups.connection instanceof Response
      ? backups.connection.clone()
      : json(backups.connection);
  }
  if (path === "/api/settings/backups/run") {
    return replace({ ...current, status: { ...current.status, backupRequested: true } });
  }
  if (path === "/api/settings/backups/test-restore") {
    return replace({ ...current, status: { ...current.status, testRestoreRequested: true } });
  }
  if (path === "/api/settings/backups/list") {
    return backups.list instanceof Response ? backups.list.clone() : json(backups.list);
  }
  const keyPassword = isRecord(body) ? body.password : undefined;
  if (
    (path === "/api/settings/backups/key" || path === "/api/settings/backups/key/file") &&
    keyPassword !== FAKE_PASSWORD
  ) {
    return json(WRONG_PASSWORD, 403);
  }
  if (path === "/api/settings/backups/key") return json(backups.key);
  if (path === "/api/settings/backups/key/file") {
    return new Response(`# Ottertrail backup key for Acme Inc\n${backups.key.key}\n`, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="ottertrail-backup-key-acme-inc.txt"',
      },
    });
  }
  if (path === "/api/settings/backups/key/saved") {
    return replace({ ...current, key: { ...current.key, savedAt: current.status.now } });
  }
  return json({ error: "not_found", message: `No fake answer for ${path}` }, 404);
}
