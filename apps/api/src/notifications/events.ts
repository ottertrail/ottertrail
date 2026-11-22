/**
 * What a notification says (docs/webhooks.md): its event type and the
 * body a webhook receives, version 1. Email messages are written from the
 * same payload (email.ts).
 */

/**
 * The event types, as webhooks name them. Alert rules (step 3 of
 * docs/uptime-alerts.md, alerts/) send the check, certificate, and error
 * ones, and `alert.held_back` when a rule's hourly cap held notifications
 * back; telemetry alerts (step 4) send the route and metric ones, and AI
 * alerts (docs/ai-usage.md) the AI cost and failure ones. The
 * worker's storage check sends the storage ones, about the instance
 * rather than a project (storage/warning-job.ts); `backups.changed` says
 * the owner's backup key was shown or downloaded, where backups go
 * changed, or backups were turned off (backups/routes.ts). `test` is the
 * dashboard's test send.
 */
export const EVENT_TYPES = [
  "check.down",
  "check.up",
  "certificate.expiring",
  "certificate.renewed",
  "error.new",
  "error.regressed",
  "error.spike",
  "error.spike_resolved",
  "route.latency",
  "route.latency_resolved",
  "route.failures",
  "route.failures_resolved",
  "metric.threshold",
  "metric.threshold_resolved",
  "ai.cost",
  "ai.cost_resolved",
  "ai.failures",
  "ai.failures_resolved",
  "alert.held_back",
  "storage.low",
  "storage.recovered",
  "backups.changed",
  "test",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const isEventType = (value: unknown): value is EventType =>
  EVENT_TYPES.some((type) => type === value);

/** The body's version: a change that could break a receiver gets a new one. */
export const PAYLOAD_VERSION = 1;

/** The longest message, in characters. */
export const MAX_MESSAGE = 1000;
/** The most fields a subject has, and the longest key and text value. */
export const MAX_SUBJECT_FIELDS = 20;
export const MAX_SUBJECT_KEY = 64;
export const MAX_SUBJECT_TEXT = 2048;
export const MAX_NOTIFICATION_URL = 2048;

/** What a notification is about, such as `{ "type": "check", "id": "…", "name": "API" }`. */
export type Subject = Record<string, string | number | boolean | null>;

/** A webhook's body, version 1; also what a delivery stores. */
export interface NotificationPayload {
  version: typeof PAYLOAD_VERSION;
  /** The notification: the same for every channel it went to, and for every retry. */
  id: string;
  type: EventType;
  /** When it happened, as an ISO 8601 time in UTC. */
  time: string;
  project: { id: string; name: string } | null;
  subject: Subject;
  /** One or two sentences on what happened, as email and the dashboard show it. */
  message: string;
  /** The dashboard's page about it. */
  url: string;
}

/** What is wrong with a subject, or null when it is fine. */
export function subjectProblem(subject: unknown): string | null {
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    return "The subject is an object.";
  }
  const entries = Object.entries(subject);
  if (entries.length > MAX_SUBJECT_FIELDS) {
    return `The subject has at most ${MAX_SUBJECT_FIELDS} fields.`;
  }
  for (const [key, value] of entries) {
    if (key === "" || key.length > MAX_SUBJECT_KEY) {
      return `A subject's keys have 1 to ${MAX_SUBJECT_KEY} characters.`;
    }
    const scalar =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= MAX_SUBJECT_TEXT);
    if (!scalar) {
      return `A subject's values are numbers, true or false, null, or text of at most ${MAX_SUBJECT_TEXT} characters.`;
    }
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a stored payload is one notify wrote (it always is). */
export function isPayload(value: unknown): value is NotificationPayload {
  return (
    isRecord(value) &&
    value.version === PAYLOAD_VERSION &&
    typeof value.id === "string" &&
    isEventType(value.type) &&
    typeof value.time === "string" &&
    (value.project === null || isRecord(value.project)) &&
    isRecord(value.subject) &&
    typeof value.message === "string" &&
    typeof value.url === "string"
  );
}

/** The payload a delivery stored, read back; null when it is not one. */
export function payloadOf(value: unknown): NotificationPayload | null {
  return isPayload(value) ? value : null;
}
