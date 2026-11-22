import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, telemetryRetry } from "./telemetry-shapes";

/**
 * The AI page's report (docs/ai-usage.md, "The report"; apps/api/src/ai):
 * the LLM calls in a project's traces, with tokens, estimated cost,
 * latency, and failures by model, feature, and user.
 */

/** The report's filters, each exactly as stored. `feature: ""` is the calls with no feature. */
export interface AiFilters {
  service?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  feature?: string | undefined;
  /** One end user's calls (the user page's AI section); the API needs the Users area for it. */
  user?: string | undefined;
}

/** The longest model, provider, or feature the API stores and filters by. */
export const MAX_AI_LABEL = 100;

export interface AiTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Estimated, in US dollars: calls of models without a price add nothing. */
  costUsd: number;
  /** 0 to 1; null without input tokens. */
  cacheReadShare: number | null;
  p95Ms: number | null;
  failed: number;
  failedShare: number | null;
  /** Calls of models the price table lacks: their cost is not in costUsd. */
  noPriceCalls: number;
  /** Up to 20 of those models. */
  noPriceModels: string[];
}

/** A breakdown row's figures. */
export interface AiFigures {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  cacheReadShare: number | null;
  failed: number;
  failedShare: number | null;
  noPriceCalls: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** The median time to the first chunk, of the calls that report one. */
  firstChunkP50Ms: number | null;
  /** Calls cut off at their token limit. */
  cutOff: number;
  cutOffShare: number | null;
}

export interface AiModelRow extends AiFigures {
  /** "" when the spans named none, and for the Other row. */
  model: string;
  provider: string;
  other: boolean;
  priced: boolean;
}

export interface AiFeatureRow extends AiFigures {
  /** "" for calls with no feature ("Unlabeled"), and for the Other row. */
  feature: string;
  other: boolean;
}

export interface AiUserRow {
  userId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failed: number;
  noPriceCalls: number;
}

export interface AiFailureRow {
  /** "" for failed calls that sent no error.type. */
  errorType: string;
  calls: number;
  lastAt: string;
}

/** GET /api/projects/:id/ai */
export interface AiReport {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  environments: string[];
  services: string[];
  filterOptions: { services: string[]; providers: string[]; models: string[]; features: string[] };
  /** Whether the project has any AI call at all. */
  received: boolean;
  totals: AiTotals;
  previous: { firstDay: string; lastDay: string; until: string | null; totals: AiTotals };
  models: AiModelRow[];
  features: AiFeatureRow[];
  /** null without the Users area: `usersHidden`. */
  users: AiUserRow[] | null;
  usersHidden: boolean;
  failures: AiFailureRow[];
  limits: { models: number; features: number; users: number };
}

export interface AiSeries {
  costUsd: number[];
  tokens: number[];
  calls: number[];
  p95Ms: (number | null)[];
}

export const AI_SPLITS = ["model", "feature"] as const;
export type AiSplit = (typeof AI_SPLITS)[number];

/** GET /api/projects/:id/ai/chart */
export interface AiChart {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  start: string;
  bucketStarts: string[];
  stepSeconds: number;
  buckets: number;
  split: AiSplit;
  total: AiSeries;
  /** The 10 that cost the most, then Other. */
  series: (AiSeries & { key: string; other: boolean })[];
}

export interface AiCall {
  traceId: string;
  spanId: string;
  startNs: string;
  at: string;
  service: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  feature: string;
  userId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Estimated; null when its model has no price. */
  costUsd: number | null;
  durationMs: number;
  firstChunkMs: number | null;
  failed: boolean;
  errorType: string;
  finishReasons: string[];
}

/** GET /api/projects/:id/ai/calls */
export interface AiCalls {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  limit: number;
  usersHidden: boolean;
  calls: AiCall[];
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);
const isTexts = (value: unknown): value is string[] => isListOf(value, isText);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const hasSums = (value: Record<string, unknown>) =>
  isNumber(value.calls) &&
  isNumber(value.inputTokens) &&
  isNumber(value.outputTokens) &&
  isNumber(value.cacheReadTokens) &&
  isNumber(value.cacheWriteTokens) &&
  isNumber(value.reasoningTokens) &&
  isNumber(value.costUsd) &&
  isNumberOrNull(value.cacheReadShare) &&
  isNumber(value.failed) &&
  isNumberOrNull(value.failedShare) &&
  isNumber(value.noPriceCalls);

const isTotals = (value: unknown): value is AiTotals =>
  isRecord(value) && hasSums(value) && isNumberOrNull(value.p95Ms) && isTexts(value.noPriceModels);

const hasFigures = (value: Record<string, unknown>) =>
  hasSums(value) &&
  isNumberOrNull(value.p50Ms) &&
  isNumberOrNull(value.p95Ms) &&
  isNumberOrNull(value.firstChunkP50Ms) &&
  isNumber(value.cutOff) &&
  isNumberOrNull(value.cutOffShare);

const isModelRow = (value: unknown): value is AiModelRow =>
  isRecord(value) &&
  hasFigures(value) &&
  isText(value.model) &&
  isText(value.provider) &&
  isBoolean(value.other) &&
  isBoolean(value.priced);

const isFeatureRow = (value: unknown): value is AiFeatureRow =>
  isRecord(value) && hasFigures(value) && isText(value.feature) && isBoolean(value.other);

const isUserRow = (value: unknown): value is AiUserRow =>
  isRecord(value) &&
  isText(value.userId) &&
  isNumber(value.calls) &&
  isNumber(value.inputTokens) &&
  isNumber(value.outputTokens) &&
  isNumber(value.costUsd) &&
  isNumber(value.failed) &&
  isNumber(value.noPriceCalls);

const isFailureRow = (value: unknown): value is AiFailureRow =>
  isRecord(value) && isText(value.errorType) && isNumber(value.calls) && isText(value.lastAt);

const isAnswered = (value: Record<string, unknown>) =>
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay);

const isReport = (value: unknown): value is AiReport =>
  isRecord(value) &&
  isAnswered(value) &&
  isTexts(value.environments) &&
  isTexts(value.services) &&
  isRecord(value.filterOptions) &&
  isTexts(value.filterOptions.services) &&
  isTexts(value.filterOptions.providers) &&
  isTexts(value.filterOptions.models) &&
  isTexts(value.filterOptions.features) &&
  isBoolean(value.received) &&
  isTotals(value.totals) &&
  isRecord(value.previous) &&
  isText(value.previous.firstDay) &&
  isText(value.previous.lastDay) &&
  (value.previous.until === null || isText(value.previous.until)) &&
  isTotals(value.previous.totals) &&
  isListOf(value.models, isModelRow) &&
  isListOf(value.features, isFeatureRow) &&
  (value.users === null || isListOf(value.users, isUserRow)) &&
  isBoolean(value.usersHidden) &&
  isListOf(value.failures, isFailureRow) &&
  isRecord(value.limits) &&
  isNumber(value.limits.models) &&
  isNumber(value.limits.features) &&
  isNumber(value.limits.users);

const isSeries = (value: Record<string, unknown>) =>
  isListOf(value.costUsd, isNumber) &&
  isListOf(value.tokens, isNumber) &&
  isListOf(value.calls, isNumber) &&
  isListOf(value.p95Ms, isNumberOrNull);

const isChart = (value: unknown): value is AiChart =>
  isRecord(value) &&
  isAnswered(value) &&
  isText(value.start) &&
  isTexts(value.bucketStarts) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  (value.split === "model" || value.split === "feature") &&
  isRecord(value.total) &&
  isSeries(value.total) &&
  isListOf(
    value.series,
    (item): item is AiChart["series"][number] =>
      isRecord(item) && isText(item.key) && isBoolean(item.other) && isSeries(item),
  );

const isCall = (value: unknown): value is AiCall =>
  isRecord(value) &&
  isText(value.traceId) &&
  isText(value.spanId) &&
  isText(value.startNs) &&
  isText(value.at) &&
  isText(value.service) &&
  isText(value.release) &&
  isText(value.provider) &&
  isText(value.model) &&
  isText(value.operation) &&
  isText(value.feature) &&
  (value.userId === null || isText(value.userId)) &&
  isNumber(value.inputTokens) &&
  isNumber(value.outputTokens) &&
  isNumber(value.cacheReadTokens) &&
  isNumber(value.cacheWriteTokens) &&
  isNumber(value.reasoningTokens) &&
  isNumberOrNull(value.costUsd) &&
  isNumber(value.durationMs) &&
  isNumberOrNull(value.firstChunkMs) &&
  isBoolean(value.failed) &&
  isText(value.errorType) &&
  isTexts(value.finishReasons);

const isCalls = (value: unknown): value is AiCalls =>
  isRecord(value) &&
  isAnswered(value) &&
  isNumber(value.limit) &&
  isBoolean(value.usersHidden) &&
  isListOf(value.calls, isCall);

/** The query string the three routes share: the period, environment, and filters. */
function aiParams(range: PageRange, environment: string, filters: AiFilters) {
  return new URLSearchParams({
    ...rangeParams(range),
    ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
    ...(filters.service === undefined ? {} : { service: filters.service }),
    ...(filters.provider === undefined ? {} : { provider: filters.provider }),
    ...(filters.model === undefined ? {} : { model: filters.model }),
    ...(filters.feature === undefined ? {} : { feature: filters.feature }),
    ...(filters.user === undefined ? {} : { user: filters.user }),
  });
}

const aiPath = (projectId: string, rest = "") =>
  `/api/projects/${encodeURIComponent(projectId)}/ai${rest}`;

/** The filters as a query key: undefined ones left out, so equal filters share a cache entry. */
const filterKey = (filters: AiFilters) => ({
  service: filters.service,
  provider: filters.provider,
  model: filters.model,
  feature: filters.feature,
  user: filters.user,
});

/** The totals, the period before, and the breakdowns. */
export const aiReportQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: AiFilters,
) =>
  queryOptions({
    queryKey: ["ai", projectId, "report", range, environment, filterKey(filters)],
    retry: telemetryRetry,
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `${aiPath(projectId)}?${aiParams(range, environment, filters).toString()}`,
          { signal },
        ),
        isReport,
      ),
    placeholderData: keepPreviousData,
  });

/** Cost, tokens, calls, and the 95th percentile per bucket, split by model or feature. */
export const aiChartQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: AiFilters,
  split: AiSplit,
) =>
  queryOptions({
    queryKey: ["ai", projectId, "chart", range, environment, filterKey(filters), split],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = aiParams(range, environment, filters);
      if (split !== "model") query.set("split", split);
      return expectShape(
        await apiRequest(`${aiPath(projectId, "/chart")}?${query.toString()}`, { signal }),
        isChart,
      );
    },
    placeholderData: keepPreviousData,
  });

/** The latest 50 calls, each with its trace and span. */
export const aiCallsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: AiFilters,
) =>
  queryOptions({
    queryKey: ["ai", projectId, "calls", range, environment, filterKey(filters)],
    retry: telemetryRetry,
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `${aiPath(projectId, "/calls")}?${aiParams(range, environment, filters).toString()}`,
          { signal },
        ),
        isCalls,
      ),
    placeholderData: keepPreviousData,
  });
