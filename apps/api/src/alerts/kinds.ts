import { ENVIRONMENT_PATTERN } from "../collection/environment.ts";
import { FINGERPRINT_PATTERN } from "../errors/fingerprint.ts";
import type { EventType } from "../notifications/events.ts";
import type { Problem } from "../outbound/url.ts";

/**
 * The kinds of alert rule (docs/uptime-alerts.md, "Alerts"), each with its
 * settings and the notifications it sends. Step 4's telemetry rules join
 * this one list; everything else (the API's schema, the rule's checks,
 * the dashboard's labels) reads it.
 */
export const RULE_KINDS = [
  "check_down",
  "certificate_expiring",
  "error_new",
  "error_regressed",
  "error_spike",
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export const isRuleKind = (value: unknown): value is RuleKind =>
  RULE_KINDS.some((kind) => kind === value);

/** What each kind is called, what feeds it, and what it sends on firing and resolving. */
export const KIND_INFO: Record<
  RuleKind,
  {
    label: string;
    /** Where it is evaluated: from the checker (checks), or from the error list's data each minute. */
    source: "checks" | "errors";
    fires: EventType;
    /** null: the kind fires once per subject and never resolves. */
    resolves: EventType | null;
  }
> = {
  check_down: { label: "Check down", source: "checks", fires: "check.down", resolves: "check.up" },
  certificate_expiring: {
    label: "Certificate expiring",
    source: "checks",
    fires: "certificate.expiring",
    resolves: "certificate.renewed",
  },
  error_new: { label: "New error", source: "errors", fires: "error.new", resolves: null },
  error_regressed: {
    label: "Regressed error",
    source: "errors",
    fires: "error.regressed",
    resolves: null,
  },
  error_spike: {
    label: "Error spike",
    source: "errors",
    fires: "error.spike",
    resolves: "error.spike_resolved",
  },
};

/** Rules a project may have. */
export const MAX_RULES = 50;
export const MAX_RULE_NAME = 100;
/** Channels a rule sends to at most: as many as an instance may have. */
export const MAX_RULE_CHANNELS = 20;
export const DEFAULT_CERTIFICATE_DAYS = 14;
export const MAX_CERTIFICATE_DAYS = 90;
export const MIN_WINDOW_MINUTES = 5;
export const MAX_WINDOW_MINUTES = 60;
export const DEFAULT_WINDOW_MINUTES = 10;
export const DEFAULT_THRESHOLD = 10;
export const MAX_THRESHOLD = 1_000_000;

/** Each kind's settings, as stored and answered. null: all (checks, environments, groups). */
export interface CheckDownSettings {
  checkId: string | null;
}
export interface CertificateSettings {
  checkId: string | null;
  days: number;
}
export interface NewErrorSettings {
  environment: string | null;
}
export type RegressedErrorSettings = Record<string, never>;
export interface SpikeSettings {
  environment: string | null;
  fingerprint: string | null;
  windowMinutes: number;
  threshold: number;
}

export type RuleSettings =
  | CheckDownSettings
  | CertificateSettings
  | NewErrorSettings
  | RegressedErrorSettings
  | SpikeSettings;

/** What the API takes as settings: every kind's fields, each optional. */
export interface SettingsInput {
  checkId?: string | null | undefined;
  days?: number | undefined;
  environment?: string | null | undefined;
  fingerprint?: string | null | undefined;
  windowMinutes?: number | undefined;
  threshold?: number | undefined;
}

/** The fields Fastify's schema takes in `settings`, for every kind; settingsOf checks each kind's. */
export const SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    checkId: {
      type: ["string", "null"],
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    },
    days: { type: "integer", minimum: 1, maximum: MAX_CERTIFICATE_DAYS },
    environment: { type: ["string", "null"], pattern: ENVIRONMENT_PATTERN },
    fingerprint: { type: ["string", "null"], pattern: FINGERPRINT_PATTERN },
    windowMinutes: { type: "integer", minimum: MIN_WINDOW_MINUTES, maximum: MAX_WINDOW_MINUTES },
    threshold: { type: "integer", minimum: 1, maximum: MAX_THRESHOLD },
  },
} as const;

const environmentOf = (value: string | null | undefined) =>
  value === undefined || value === null || value === "" ? null : value.toLowerCase();

/**
 * A kind's settings from what was sent over `base` (the rule's current
 * ones, when it keeps its kind), with defaults; or the first problem.
 * Fields of other kinds are ignored. Fastify's schema has checked types
 * and bounds; this words what it cannot.
 */
export function settingsOf(
  kind: RuleKind,
  input: SettingsInput,
  base: Partial<SettingsInput> = {},
): RuleSettings | Problem {
  const pick = <K extends keyof SettingsInput>(key: K): SettingsInput[K] =>
    input[key] === undefined ? base[key] : input[key];
  const checkId = pick("checkId")?.toLowerCase() ?? null;
  if (kind === "check_down") return { checkId };
  if (kind === "certificate_expiring") {
    const days = pick("days") ?? DEFAULT_CERTIFICATE_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_CERTIFICATE_DAYS) {
      return {
        error: "invalid_days",
        message: `Warn 1 to ${MAX_CERTIFICATE_DAYS} days before a certificate expires.`,
      };
    }
    return { checkId, days };
  }
  if (kind === "error_new") return { environment: environmentOf(pick("environment")) };
  if (kind === "error_regressed") return {};
  const windowMinutes = pick("windowMinutes") ?? DEFAULT_WINDOW_MINUTES;
  if (
    !Number.isInteger(windowMinutes) ||
    windowMinutes < MIN_WINDOW_MINUTES ||
    windowMinutes > MAX_WINDOW_MINUTES
  ) {
    return {
      error: "invalid_window",
      message: `The window is ${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES} minutes.`,
    };
  }
  const threshold = pick("threshold") ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_THRESHOLD) {
    return {
      error: "invalid_threshold",
      message: `The threshold is a whole number of errors from 1 to ${MAX_THRESHOLD.toLocaleString("en")}.`,
    };
  }
  return {
    environment: environmentOf(pick("environment")),
    fingerprint: pick("fingerprint") ?? null,
    windowMinutes,
    threshold,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);
const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const storedRecord = (value: unknown) => (isRecord(value) ? value : {});

/** A stored "new error" rule's settings (the API wrote them). */
export function newErrorSettingsOf(value: unknown): NewErrorSettings {
  return { environment: textOrNull(storedRecord(value).environment) };
}

/** A stored "error spike" rule's settings (the API wrote them). */
export function spikeSettingsOf(value: unknown): SpikeSettings {
  const stored = storedRecord(value);
  return {
    environment: textOrNull(stored.environment),
    fingerprint: textOrNull(stored.fingerprint),
    windowMinutes: numberOr(stored.windowMinutes, DEFAULT_WINDOW_MINUTES),
    threshold: numberOr(stored.threshold, DEFAULT_THRESHOLD),
  };
}

/** A stored rule's settings, read back as its kind has them (the API wrote them). */
export function storedSettings(kind: RuleKind, value: unknown): RuleSettings {
  const stored = storedRecord(value);
  if (kind === "check_down") return { checkId: textOrNull(stored.checkId) };
  if (kind === "certificate_expiring") {
    return {
      checkId: textOrNull(stored.checkId),
      days: numberOr(stored.days, DEFAULT_CERTIFICATE_DAYS),
    };
  }
  if (kind === "error_new") return newErrorSettingsOf(value);
  if (kind === "error_regressed") return {};
  return spikeSettingsOf(value);
}

/** The check a rule watches, if it names one. */
export function checkIdOf(settings: RuleSettings): string | null {
  return "checkId" in settings ? settings.checkId : null;
}
