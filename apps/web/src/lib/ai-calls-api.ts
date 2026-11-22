import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import type { AiFilters } from "./ai-api";
import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, telemetryRetry } from "./telemetry-shapes";

/**
 * The AI calls list and its conversations (docs/ai-usage.md, "The calls
 * list"; apps/api/src/ai/call-routes.ts): the calls one page at a time,
 * one call with its price's source, the period's conversations, and one
 * conversation's calls. No prompt or completion is ever stored, so none
 * is here: only names, token counts, and times.
 */

/** The list's filters: the AI page's, and a user, a conversation, and the failed calls only. */
export interface AiCallFilters extends AiFilters {
  user?: string | undefined;
  conversation?: string | undefined;
  failed?: boolean | undefined;
}

/** The longest conversation ID the API stores and filters by. */
export const MAX_CONVERSATION_ID = 200;

export interface AiListedCall {
  id: string;
  /** "" for a call sent over HTTP without one. */
  traceId: string;
  spanId: string;
  startNs: string;
  at: string;
  service: string;
  environment: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  feature: string;
  /** null without the Users area, or for a call that names none. */
  userId: string | null;
  /** "" for none. */
  conversationId: string;
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

export interface AiCallTotals {
  calls: number;
  costUsd: number;
  failed: number;
  failedShare: number | null;
  noPriceCalls: number;
}

/** What the filter bar offers, as the AI page's report answers it. */
interface ListLabels {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  environments: string[];
  services: string[];
  filterOptions: { services: string[]; providers: string[]; models: string[]; features: string[] };
  /** Whether the project has any AI call at all. */
  received: boolean;
  usersHidden: boolean;
}

/** GET /api/projects/:id/ai/call-list */
export interface AiCallPage extends ListLabels {
  pageSize: number;
  /** The period's calls with the filters, counted whole. */
  totals: AiCallTotals;
  calls: AiListedCall[];
  next: string | null;
}

export interface AiCallPrice {
  source: "built_in" | "custom" | "price_as";
  /** US dollars per million tokens; a null cache price is charged as input. */
  rates: { input: number; output: number; cacheRead: number | null; cacheWrite: number | null };
  /** A built-in price's day it was read, "YYYY-MM-DD". */
  checked: string | null;
  /** A custom row's model, when another ID of the same entry; price as: the model it takes. */
  model: string | null;
  effectiveFrom: string | null;
}

/** GET /api/projects/:id/ai/calls/:callId */
export interface AiCallDetail {
  timeZone: string;
  usersHidden: boolean;
  traceRetentionDays: number;
  /** Whether its trace's spans are still kept: false past the spans' retention. */
  traceKept: boolean;
  call: AiListedCall;
  price: AiCallPrice | null;
}

export interface AiConversationFigures {
  startedAt: string;
  lastAt: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  noPriceCalls: number;
  durationMs: number;
  failed: number;
}

export interface AiConversationRow extends AiConversationFigures {
  conversationId: string;
  userId: string | null;
  features: string[];
  models: string[];
}

/** GET /api/projects/:id/ai/conversations */
export interface AiConversationList extends ListLabels {
  limit: number;
  /** More conversations than `limit` had calls in the period: the oldest are left out. */
  more: boolean;
  conversations: AiConversationRow[];
}

/** GET /api/projects/:id/ai/conversations/:conversationId */
export interface AiConversationDetail {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  conversationId: string;
  usersHidden: boolean;
  limit: number;
  more: boolean;
  /** null: no call of it in the period with the filters. */
  figures: AiConversationFigures | null;
  calls: AiListedCall[];
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isTexts = (value: unknown): value is string[] => isListOf(value, isText);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isCall = (value: unknown): value is AiListedCall =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.traceId) &&
  isText(value.spanId) &&
  isText(value.startNs) &&
  isText(value.at) &&
  isText(value.service) &&
  isText(value.environment) &&
  isText(value.release) &&
  isText(value.provider) &&
  isText(value.model) &&
  isText(value.operation) &&
  isText(value.feature) &&
  isTextOrNull(value.userId) &&
  isText(value.conversationId) &&
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

const isAnswered = (value: Record<string, unknown>) =>
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay);

const hasLabels = (value: Record<string, unknown>) =>
  isAnswered(value) &&
  isTexts(value.environments) &&
  isTexts(value.services) &&
  isRecord(value.filterOptions) &&
  isTexts(value.filterOptions.services) &&
  isTexts(value.filterOptions.providers) &&
  isTexts(value.filterOptions.models) &&
  isTexts(value.filterOptions.features) &&
  isBoolean(value.received) &&
  isBoolean(value.usersHidden);

const isTotals = (value: unknown): value is AiCallTotals =>
  isRecord(value) &&
  isNumber(value.calls) &&
  isNumber(value.costUsd) &&
  isNumber(value.failed) &&
  isNumberOrNull(value.failedShare) &&
  isNumber(value.noPriceCalls);

const isPage = (value: unknown): value is AiCallPage =>
  isRecord(value) &&
  hasLabels(value) &&
  isNumber(value.pageSize) &&
  isTotals(value.totals) &&
  isListOf(value.calls, isCall) &&
  isTextOrNull(value.next);

const isPrice = (value: unknown): value is AiCallPrice =>
  isRecord(value) &&
  (value.source === "built_in" || value.source === "custom" || value.source === "price_as") &&
  isRecord(value.rates) &&
  isNumber(value.rates.input) &&
  isNumber(value.rates.output) &&
  isNumberOrNull(value.rates.cacheRead) &&
  isNumberOrNull(value.rates.cacheWrite) &&
  isTextOrNull(value.checked) &&
  isTextOrNull(value.model) &&
  isTextOrNull(value.effectiveFrom);

const isDetail = (value: unknown): value is AiCallDetail =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isBoolean(value.usersHidden) &&
  isNumber(value.traceRetentionDays) &&
  isBoolean(value.traceKept) &&
  isCall(value.call) &&
  (value.price === null || isPrice(value.price));

const hasFigures = (value: Record<string, unknown>) =>
  isText(value.startedAt) &&
  isText(value.lastAt) &&
  isNumber(value.calls) &&
  isNumber(value.inputTokens) &&
  isNumber(value.outputTokens) &&
  isNumber(value.costUsd) &&
  isNumber(value.noPriceCalls) &&
  isNumber(value.durationMs) &&
  isNumber(value.failed);

const isConversationRow = (value: unknown): value is AiConversationRow =>
  isRecord(value) &&
  hasFigures(value) &&
  isText(value.conversationId) &&
  isTextOrNull(value.userId) &&
  isTexts(value.features) &&
  isTexts(value.models);

const isConversationList = (value: unknown): value is AiConversationList =>
  isRecord(value) &&
  hasLabels(value) &&
  isNumber(value.limit) &&
  isBoolean(value.more) &&
  isListOf(value.conversations, isConversationRow);

const isConversationDetail = (value: unknown): value is AiConversationDetail =>
  isRecord(value) &&
  isAnswered(value) &&
  isText(value.conversationId) &&
  isBoolean(value.usersHidden) &&
  isNumber(value.limit) &&
  isBoolean(value.more) &&
  (value.figures === null || (isRecord(value.figures) && hasFigures(value.figures))) &&
  isListOf(value.calls, isCall);

/** The query string the routes share: the period, environment, and filters. */
function listParams(range: PageRange, environment: string, filters: AiCallFilters) {
  return new URLSearchParams({
    ...rangeParams(range),
    ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
    ...(filters.service === undefined ? {} : { service: filters.service }),
    ...(filters.provider === undefined ? {} : { provider: filters.provider }),
    ...(filters.model === undefined ? {} : { model: filters.model }),
    ...(filters.feature === undefined ? {} : { feature: filters.feature }),
    ...(filters.user === undefined ? {} : { user: filters.user }),
    ...(filters.conversation === undefined ? {} : { conversation: filters.conversation }),
    ...(filters.failed === true ? { status: "failed" } : {}),
  });
}

const aiPath = (projectId: string, rest: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/ai${rest}`;

/** The filters as a query key: undefined ones left out, so equal filters share a cache entry. */
const filterKey = (filters: AiCallFilters) => ({
  service: filters.service,
  provider: filters.provider,
  model: filters.model,
  feature: filters.feature,
  user: filters.user,
  conversation: filters.conversation,
  failed: filters.failed === true,
});

/** The calls, newest first, a page at a time, and the period's totals. */
export const aiCallListQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: AiCallFilters,
) =>
  infiniteQueryOptions({
    queryKey: ["ai", projectId, "call-list", range, environment, filterKey(filters)],
    retry: telemetryRetry,
    queryFn: async ({ pageParam, signal }) => {
      const query = listParams(range, environment, filters);
      if (pageParam !== null) query.set("before", pageParam);
      return expectShape(
        await apiRequest(`${aiPath(projectId, "/call-list")}?${query.toString()}`, { signal }),
        isPage,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });

/** One call; `at`, its start when known, narrows where it is looked for. */
export const aiCallQuery = (projectId: string, callId: string, at: string | undefined) =>
  queryOptions({
    queryKey: ["ai", projectId, "call", callId, at],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = at === undefined ? "" : `?${new URLSearchParams({ at }).toString()}`;
      return expectShape(
        await apiRequest(`${aiPath(projectId, `/calls/${encodeURIComponent(callId)}`)}${query}`, {
          signal,
        }),
        isDetail,
      );
    },
  });

/** The conversation filter is the selection in the Conversations view: not part of its list. */
const conversationsFilters = (filters: AiCallFilters) => ({ ...filters, conversation: undefined });

/** The period's conversations, by their last call. */
export const aiConversationsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: AiCallFilters,
) => {
  const listed = conversationsFilters(filters);
  return queryOptions({
    queryKey: ["ai", projectId, "conversations", range, environment, filterKey(listed)],
    retry: telemetryRetry,
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `${aiPath(projectId, "/conversations")}?${listParams(range, environment, listed).toString()}`,
          { signal },
        ),
        isConversationList,
      ),
    placeholderData: keepPreviousData,
  });
};

/** One conversation's calls in the period, in order, with its figures. */
export const aiConversationQuery = (
  projectId: string,
  conversationId: string,
  range: PageRange,
  environment: string,
  filters: AiCallFilters,
) => {
  const listed = conversationsFilters(filters);
  return queryOptions({
    queryKey: [
      "ai",
      projectId,
      "conversation",
      conversationId,
      range,
      environment,
      filterKey(listed),
    ],
    retry: telemetryRetry,
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `${aiPath(projectId, `/conversations/${encodeURIComponent(conversationId)}`)}?${listParams(range, environment, listed).toString()}`,
          { signal },
        ),
        isConversationDetail,
      ),
  });
};
