import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/**
 * A project's alert rules (docs/uptime-alerts.md, "Alerts";
 * apps/api/src/alerts): what each watches, the channels it sends to,
 * whether it fires now, and the alerts it sent.
 */

/** The kinds of rule, in the order the form offers them; step 4 adds telemetry ones. */
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

export const KIND_LABEL: Record<RuleKind, string> = {
  check_down: "Check down",
  certificate_expiring: "Certificate expiring",
  error_new: "New error",
  error_regressed: "Regressed error",
  error_spike: "Error spike",
};

export const MAX_RULE_NAME = 100;
export const DEFAULT_CERTIFICATE_DAYS = 14;
export const MAX_CERTIFICATE_DAYS = 90;
export const MIN_WINDOW_MINUTES = 5;
export const MAX_WINDOW_MINUTES = 60;
export const DEFAULT_WINDOW_MINUTES = 10;
export const DEFAULT_THRESHOLD = 10;
export const MAX_THRESHOLD = 1_000_000;

/** Every kind's settings; each kind uses its own (null: all checks, environments, or groups). */
export interface RuleSettings {
  checkId?: string | null;
  days?: number;
  environment?: string | null;
  fingerprint?: string | null;
  windowMinutes?: number;
  threshold?: number;
}

export interface Rule {
  id: string;
  name: string;
  kind: RuleKind;
  settings: RuleSettings;
  channelIds: string[];
  enabled: boolean;
  /** Why the server turned it off, such as its check being deleted. */
  disabledReason: string | null;
  /** Subjects it fires for now. */
  firing: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/projects/:id/alert-rules */
export interface RuleList {
  timeZone: string;
  maxRules: number;
  hourlyCap: number;
  rules: Rule[];
}

export interface HistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  kind: string;
  subject: string;
  subjectName: string;
  firedAt: string;
  resolvedAt: string | null;
  message: string;
  /** false when the rule's hourly cap held its notification back. */
  notified: boolean;
}

/** A page of a project's (or a rule's) alerts: `next` asks for the following one. */
export interface HistoryPage {
  timeZone: string;
  retentionDays: number;
  alerts: HistoryEntry[];
  next: string | null;
}

export interface FiringAlert {
  ruleId: string;
  ruleName: string;
  kind: string;
  subject: string;
  subjectName: string;
  since: string;
  message: string;
}

/** What the form sends. */
export interface RuleFields {
  name: string;
  kind: RuleKind;
  settings: RuleSettings;
  channelIds: string[];
  enabled?: boolean;
}

const isNullableText = (value: unknown) => value === undefined || isTextOrNull(value);
const isOptionalNumber = (value: unknown) => value === undefined || isNumber(value);

const isSettings = (value: unknown): value is RuleSettings =>
  isRecord(value) &&
  isNullableText(value.checkId) &&
  isOptionalNumber(value.days) &&
  isNullableText(value.environment) &&
  isNullableText(value.fingerprint) &&
  isOptionalNumber(value.windowMinutes) &&
  isOptionalNumber(value.threshold);

export const isRule = (value: unknown): value is Rule =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isRuleKind(value.kind) &&
  isSettings(value.settings) &&
  isListOf(value.channelIds, isText) &&
  typeof value.enabled === "boolean" &&
  isTextOrNull(value.disabledReason) &&
  isNumber(value.firing) &&
  isTextOrNull(value.lastFiredAt) &&
  isText(value.createdAt) &&
  isText(value.updatedAt);

const isRuleList = (value: unknown): value is RuleList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isNumber(value.maxRules) &&
  isNumber(value.hourlyCap) &&
  isListOf(value.rules, isRule);

const isHistoryEntry = (value: unknown): value is HistoryEntry =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.ruleId) &&
  isText(value.ruleName) &&
  isText(value.kind) &&
  isText(value.subject) &&
  isText(value.subjectName) &&
  isText(value.firedAt) &&
  isTextOrNull(value.resolvedAt) &&
  isText(value.message) &&
  typeof value.notified === "boolean";

const isHistoryPage = (value: unknown): value is HistoryPage =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isNumber(value.retentionDays) &&
  isListOf(value.alerts, isHistoryEntry) &&
  isTextOrNull(value.next);

const isFiring = (value: unknown): value is FiringAlert =>
  isRecord(value) &&
  isText(value.ruleId) &&
  isText(value.ruleName) &&
  isText(value.kind) &&
  isText(value.subject) &&
  isText(value.subjectName) &&
  isText(value.since) &&
  isText(value.message);

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const rulesPath = (projectId: string) => `${projectPath(projectId)}/alert-rules`;
const rulePath = (projectId: string, ruleId: string) =>
  `${rulesPath(projectId)}/${encodeURIComponent(ruleId)}`;

/** The project's rules; read again every 30 seconds, as whether each fires changes. */
export const rulesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["alerts", projectId, "rules"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest(rulesPath(projectId), { signal }), isRuleList),
    refetchInterval: 30_000,
  });

export const firingQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["alerts", projectId, "firing"],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${projectPath(projectId)}/alerts/firing`, { signal }),
        (value): value is { timeZone: string; alerts: FiringAlert[] } =>
          isRecord(value) && isText(value.timeZone) && isListOf(value.alerts, isFiring),
      ),
    refetchInterval: 30_000,
  });

/** The project's alerts, newest first, 20 at a time. */
export const historyQuery = (projectId: string) =>
  infiniteQueryOptions({
    queryKey: ["alerts", projectId, "history"],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) =>
      expectShape(
        await apiRequest(
          `${projectPath(projectId)}/alerts${pageParam === "" ? "" : `?before=${encodeURIComponent(pageParam)}`}`,
          { signal },
        ),
        isHistoryPage,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: 30_000,
  });

const ruleBody = (value: unknown): value is { rule: Rule } => isRecord(value) && isRule(value.rule);

export async function createRule(projectId: string, fields: RuleFields): Promise<Rule> {
  return expectShape(
    await apiRequest(rulesPath(projectId), { method: "POST", body: fields }),
    ruleBody,
  ).rule;
}

export async function updateRule(
  projectId: string,
  ruleId: string,
  changes: Partial<RuleFields>,
): Promise<Rule> {
  return expectShape(
    await apiRequest(rulePath(projectId, ruleId), { method: "PATCH", body: changes }),
    ruleBody,
  ).rule;
}

export async function deleteRule(projectId: string, ruleId: string): Promise<void> {
  await apiRequest(rulePath(projectId, ruleId), { method: "DELETE" });
}

/** Whether a rule watches this check: it names it, or watches all the project's checks. */
export function watchesCheck(rule: Rule, checkId: string): boolean {
  if (rule.kind !== "check_down" && rule.kind !== "certificate_expiring") return false;
  const watched = rule.settings.checkId ?? null;
  return watched === null || watched === checkId;
}

/**
 * Whether a rule watches this error group in this environment: a
 * regressed-error rule watches every group; a spike rule its group or all,
 * in its environment or all. A new-error rule watches groups not seen yet,
 * so never one that has a page.
 */
export function watchesError(rule: Rule, fingerprint: string, environment: string): boolean {
  if (rule.kind === "error_regressed") return true;
  if (rule.kind !== "error_spike") return false;
  const { fingerprint: group = null, environment: env = null } = rule.settings;
  return (group === null || group === fingerprint) && (env === null || env === environment);
}
