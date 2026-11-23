import { AI_CALLS_TABLE } from "../clickhouse/migrations.ts";
import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  belowCursor,
  type Cursor,
  cursorText,
  DASHBOARD_SETTINGS,
  dateOfNs,
  MAX_NS,
} from "../telemetry/dashboard-query.ts";
import { BUNDLED_BOOK, type PriceBook, priceAt, pricedColumns, type Rates } from "./prices.ts";
import { type AiFilters, type AiScope, pricedCalls } from "./report.ts";

/**
 * Read individual calls with FINAL so retries appear once; totals use the AI report's
 * aggregation without FINAL. Filter by project and time, and parameterize values. Compute costs
 * at read time (report.ts; docs/ai-usage.md, "The calls list").
 */

export const CALLS_PAGE_SIZE = 100;
/** Conversations the Conversations view lists: the ones with the latest calls. */
export const MAX_CONVERSATIONS = 1000;
export const MAX_CONVERSATION_CALLS = 500;
const MAX_NAMES = 5;
/** How far back a page is looked for first: FINAL reads every row of its range. */
const FIRST_WINDOW_MS = 86_400_000;
/** A call's time from the address is to the millisecond: it is looked for this far either side. */
const AROUND_MS = 60_000;

/** The list's filters: the AI page's, and a user, a conversation, and the failed calls only. */
export interface AiCallFilters extends AiFilters {
  /** One user's calls (needs the users area: call-routes.ts). */
  user?: string | undefined;
  conversation?: string | undefined;
  /** Only the failed calls; in the Conversations view, the conversations with a failed call. */
  failed?: boolean | undefined;
}

/** A row ID: a span's trace and span IDs (48 hex digits), or a call sent over HTTP's UUID. */
export const CALL_ID_PATTERN =
  "^([0-9a-f]{48}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$";
/** Where a page ends: "<nanoseconds>-<row ID>". */
export const CALL_CURSOR_PATTERN =
  "^[0-9]{1,19}-([0-9a-f]{48}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$";

/** A cursor the dashboard sent back (CALL_CURSOR_PATTERN); null when its time is out of range. */
export function callCursorOf(text: string | undefined): Cursor | undefined | null {
  if (text === undefined) return undefined;
  const dash = text.indexOf("-");
  const ns = BigInt(text.slice(0, dash));
  return ns > MAX_NS ? null : { ns, id: text.slice(dash + 1) };
}

function extraOf(
  params: QueryParams,
  filters: AiCallFilters,
  { failed = true }: { failed?: boolean } = {},
): string {
  const parts: string[] = [];
  if (filters.user !== undefined) parts.push(`user_id = ${params.add(filters.user, "String")}`);
  if (filters.conversation !== undefined) {
    parts.push(`conversation_id = ${params.add(filters.conversation, "String")}`);
  }
  if (failed && filters.failed === true) parts.push("failed");
  return parts.map((part) => `AND ${part}`).join(" ");
}

const count = (value: unknown) => Number(value ?? 0);
const ms = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number / 1e6 : null;
};
const isTrue = (value: number | boolean) => value === true || value === 1;

export interface AiCallItem {
  id: string;
  traceId: string;
  spanId: string;
  /** The start in nanoseconds since 1970, as text. */
  startNs: string;
  at: Date;
  service: string;
  environment: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  feature: string;
  /** null for a reader without the users area, or a call with no user. */
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

interface CallRow {
  id: string;
  trace_id: string;
  span_id: string;
  start_ns: string;
  service: string;
  environment: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  feature: string;
  user_id: string;
  conversation_id: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  reasoning_tokens: string;
  cost: number;
  priced: number | boolean;
  duration_ns: string;
  first_chunk_ns: string | null;
  failed: number | boolean;
  error_type: string;
  finish_reasons: string[];
}

const CALL_COLUMNS = `id, trace_id, span_id, toString(toUnixTimestamp64Nano(timestamp)) AS start_ns,
  service, environment, release, provider, model, operation, feature, user_id, conversation_id,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  cost, priced, duration_ns, first_chunk_ns, failed, error_type, finish_reasons`;

function itemOf(row: CallRow, withUsers: boolean): AiCallItem {
  return {
    id: row.id,
    traceId: row.trace_id,
    spanId: row.span_id,
    startNs: row.start_ns,
    at: dateOfNs(row.start_ns),
    service: row.service,
    environment: row.environment,
    release: row.release,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    feature: row.feature,
    userId: withUsers && row.user_id !== "" ? row.user_id : null,
    conversationId: row.conversation_id,
    inputTokens: count(row.input_tokens),
    outputTokens: count(row.output_tokens),
    cacheReadTokens: count(row.cache_read_tokens),
    cacheWriteTokens: count(row.cache_write_tokens),
    reasoningTokens: count(row.reasoning_tokens),
    costUsd: isTrue(row.priced) ? row.cost : null,
    durationMs: ms(row.duration_ns) ?? 0,
    firstChunkMs: ms(row.first_chunk_ns),
    failed: isTrue(row.failed),
    errorType: row.error_type,
    finishReasons: row.finish_reasons,
  };
}

/**
 * Read whole UTC days with FINAL because the key uses day and ID (ClickHouse migration 0012).
 * Merge copies before filtering time so retries with corrected times appear consistently across
 * pages and windows.
 */
function pageRows(
  reader: Reader,
  scope: AiScope,
  filters: AiCallFilters,
  before: Cursor | undefined,
  limit: number,
): Promise<CallRow[]> {
  const params = new QueryParams();
  const extra = `${extraOf(params, filters)} ${belowCursor(params, before)}`;
  return queryRows<CallRow>(
    reader,
    `SELECT ${CALL_COLUMNS}
     FROM (${pricedCalls(params, scope, filters, { final: true, extra })})
     ORDER BY timestamp DESC, id DESC
     LIMIT ${limit}`,
    params,
    DASHBOARD_SETTINGS,
  );
}

/**
 * Read the last day first because FINAL merges its full range. Expand to the remaining range
 * only if needed to fill CALLS_PAGE_SIZE.
 */
export async function listAiCalls(
  reader: Reader,
  scope: AiScope,
  filters: AiCallFilters,
  { before, withUsers }: { before?: Cursor | undefined; withUsers: boolean },
): Promise<{ calls: AiCallItem[]; next: string | null }> {
  const end =
    before === undefined
      ? scope.to
      : new Date(Math.min(scope.to.getTime(), Number(before.ns / 1_000_000n) + 1));
  const windowStart = new Date(Math.max(scope.from.getTime(), end.getTime() - FIRST_WINDOW_MS));
  const fetch = CALLS_PAGE_SIZE + 1;
  let rows = await pageRows(
    reader,
    { ...scope, from: windowStart, to: end },
    filters,
    before,
    fetch,
  );
  if (rows.length < fetch && windowStart > scope.from) {
    rows = await pageRows(reader, { ...scope, to: end }, filters, before, fetch);
  }
  const page = rows.slice(0, CALLS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    calls: page.map((row) => itemOf(row, withUsers)),
    next:
      rows.length > CALLS_PAGE_SIZE && last !== undefined
        ? cursorText({ ns: BigInt(last.start_ns), id: last.id })
        : null,
  };
}

export interface AiCallTotals {
  calls: number;
  /** Estimated, in US dollars: calls of models without a price add nothing. */
  costUsd: number;
  failed: number;
  /** Failed calls out of all, 0 to 1; null without calls. */
  failedShare: number | null;
  /** Calls of models without a price: their cost is not in costUsd. */
  noPriceCalls: number;
}

/** Match AI report totals by aggregating without FINAL (report.ts, aiTotals). */
export async function aiCallTotals(
  reader: Reader,
  scope: AiScope,
  filters: AiCallFilters,
): Promise<AiCallTotals> {
  const params = new QueryParams();
  const extra = extraOf(params, filters);
  const [row] = await queryRows<{ calls: string; cost: number; failed: string; no_price: string }>(
    reader,
    `SELECT count() AS calls, sum(cost) AS cost, countIf(failed) AS failed,
            countIf(NOT priced) AS no_price
     FROM (${pricedCalls(params, scope, filters, { extra })})
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  const calls = count(row?.calls);
  const failed = count(row?.failed);
  return {
    calls,
    costUsd: calls === 0 ? 0 : (row?.cost ?? 0),
    failed,
    failedShare: calls === 0 ? null : failed / calls,
    noPriceCalls: count(row?.no_price),
  };
}

export interface CallPrice {
  source: "built_in" | "custom" | "price_as";
  /** US dollars per million tokens; a null cache price is charged as input. */
  rates: Rates;
  /** Built in: the day the price was read from the provider's page, "YYYY-MM-DD". */
  checked: string | null;
  /** Custom: the model the row is on, when another ID of the same entry; price as: the model it takes. */
  model: string | null;
  /** Custom: from when the row prices calls; null for all calls. */
  effectiveFrom: Date | null;
}

export function callPriceOf(book: PriceBook, model: string, at: Date): CallPrice | null {
  const found = priceAt(book, model, at);
  if (found === null) return null;
  const { source, row } = found;
  const rates: Rates = {
    input: found.rates.input,
    output: found.rates.output,
    cacheRead: found.rates.cacheRead,
    cacheWrite: found.rates.cacheWrite,
  };
  const builtIn = row === null && "checked" in found.rates ? String(found.rates.checked) : null;
  const target =
    source === "price_as" ? (book.lookup.priceAs.get(model.toLowerCase()) ?? null) : null;
  return {
    source,
    rates,
    checked: source === "built_in" ? builtIn : null,
    model:
      source === "price_as"
        ? (target?.priceAs?.model ?? null)
        : source === "custom" && row !== null && row.model !== model.toLowerCase()
          ? row.model
          : null,
    effectiveFrom: source === "custom" ? (row?.effectiveFrom ?? null) : null,
  };
}

const DAY_MS = 86_400_000;
/** Midnight UTC of a moment's day: the table's key holds the day (ClickHouse migration 0012). */
const dayOf = (moment: number) => Math.floor(moment / DAY_MS) * DAY_MS;

/**
 * Read whole UTC days with FINAL to find the same copy as the list (ClickHouse migration 0012).
 * With `at`, search days within a minute either side; otherwise find candidate days without
 * FINAL first to avoid merging the full range. Ignore environment. Retries across midnight
 * produce two rows; take the later one.
 */
export async function aiCallById(
  reader: Reader,
  {
    projectId,
    id,
    at,
    from,
    to,
    prices = BUNDLED_BOOK,
  }: {
    projectId: string;
    id: string;
    at?: Date | undefined;
    from: Date;
    to: Date;
    prices?: PriceBook;
  },
  withUsers: boolean,
): Promise<{ call: AiCallItem; price: CallPrice | null } | null> {
  let days: { from: Date; to: Date };
  if (at === undefined) {
    const params = new QueryParams();
    const [found] = await queryRows<{ copies: string; first: string; last: string }>(
      reader,
      `SELECT count() AS copies,
              toString(toUnixTimestamp64Milli(min(timestamp))) AS first,
              toString(toUnixTimestamp64Milli(max(timestamp))) AS last
       FROM ${AI_CALLS_TABLE}
       WHERE project_id = ${params.add(projectId, "UUID")}
         AND timestamp >= ${params.time(from)} AND timestamp < ${params.time(to)}
         AND id = ${params.add(id, "String")}`,
      params,
      DASHBOARD_SETTINGS,
    );
    if (found === undefined || Number(found.copies) === 0) return null;
    days = {
      from: new Date(dayOf(Number(found.first))),
      to: new Date(dayOf(Number(found.last)) + DAY_MS),
    };
  } else {
    days = {
      from: new Date(dayOf(at.getTime() - AROUND_MS)),
      to: new Date(dayOf(at.getTime() + AROUND_MS) + DAY_MS),
    };
  }
  const params = new QueryParams();
  const [row] = await queryRows<CallRow>(
    reader,
    `SELECT ${CALL_COLUMNS}
     FROM (SELECT *, ${pricedColumns(params, prices)}
           FROM ${AI_CALLS_TABLE} FINAL
           WHERE project_id = ${params.add(projectId, "UUID")}
             AND timestamp >= ${params.time(days.from)} AND timestamp < ${params.time(days.to)}
             AND id = ${params.add(id, "String")})
     ORDER BY timestamp DESC
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  if (row === undefined) return null;
  const call = itemOf(row, withUsers);
  return { call, price: callPriceOf(prices, call.model, call.at) };
}

export interface AiConversationFigures {
  /** The first call's start and the last call's. */
  startedAt: Date;
  lastAt: Date;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated: calls of models without a price add nothing. */
  costUsd: number;
  noPriceCalls: number;
  durationMs: number;
  failed: number;
}

export interface AiConversationRow extends AiConversationFigures {
  conversationId: string;
  /** The user of most of its calls; null without the users area, or with none. */
  userId: string | null;
  /** Up to five of each, sorted; "" is the unlabeled calls. */
  features: string[];
  models: string[];
}

interface ConversationRow {
  conversation_id: string;
  first_ns: string;
  last_ns: string;
  calls: string;
  /** The input, cached tokens included, however each call counted them (report.ts). */
  all_input: string;
  output_tokens: string;
  cost: number;
  no_price: string;
  duration_ns: string;
  failed: string;
  user_id: string;
  features: string[];
  models: string[];
}

const CONVERSATION_COLUMNS = `
  toString(toUnixTimestamp64Nano(min(timestamp))) AS first_ns,
  toString(toUnixTimestamp64Nano(max(timestamp))) AS last_ns,
  count() AS calls, sum(all_input_tokens) AS all_input, sum(all_output_tokens) AS output_tokens,
  sum(cost) AS cost, countIf(NOT priced) AS no_price, sum(duration_ns) AS duration_ns,
  countIf(failed) AS failed`;

function figuresOf(row: ConversationRow): AiConversationFigures {
  const calls = count(row.calls);
  return {
    startedAt: dateOfNs(row.first_ns),
    lastAt: dateOfNs(row.last_ns),
    calls,
    inputTokens: count(row.all_input),
    outputTokens: count(row.output_tokens),
    costUsd: calls === 0 ? 0 : row.cost,
    noPriceCalls: count(row.no_price),
    durationMs: ms(row.duration_ns) ?? 0,
    failed: count(row.failed),
  };
}

/**
 * Select at most MAX_CONVERSATIONS by latest call without FINAL, then read their figures with
 * FINAL. Filters narrow each conversation; "failed" selects conversations but counts all their
 * calls. Exclude calls without a conversation ID.
 */
export async function aiConversations(
  reader: Reader,
  scope: AiScope,
  filters: AiCallFilters,
  { withUsers }: { withUsers: boolean },
): Promise<{ conversations: AiConversationRow[]; more: boolean }> {
  const params = new QueryParams();
  const having = filters.failed === true ? "HAVING countIf(failed) > 0" : "";
  // The outer query's `failed` is its count (CONVERSATION_COLUMNS).
  const outerHaving = filters.failed === true ? "HAVING failed > 0" : "";
  const narrowed = { ...filters, conversation: undefined };
  const latest = `SELECT conversation_id FROM (${pricedCalls(params, scope, narrowed, {
    extra: `${extraOf(params, narrowed, { failed: false })} AND conversation_id != ''`,
  })})
    GROUP BY conversation_id ${having}
    ORDER BY max(timestamp) DESC, conversation_id
    LIMIT ${MAX_CONVERSATIONS + 1}`;
  const rows = await queryRows<ConversationRow>(
    reader,
    `SELECT conversation_id, ${CONVERSATION_COLUMNS},
            topKIf(1)(user_id, user_id != '')[1] AS user_id,
            groupUniqArray(${MAX_NAMES})(feature) AS features,
            groupUniqArray(${MAX_NAMES})(model) AS models
     FROM (${pricedCalls(params, scope, narrowed, {
       final: true,
       extra: `${extraOf(params, narrowed, { failed: false })} AND conversation_id != ''
               AND conversation_id IN (${latest})`,
     })})
     GROUP BY conversation_id ${outerHaving}
     ORDER BY max(timestamp) DESC, conversation_id
     LIMIT ${MAX_CONVERSATIONS + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return {
    conversations: rows.slice(0, MAX_CONVERSATIONS).map((row) => ({
      conversationId: row.conversation_id,
      ...figuresOf(row),
      userId: withUsers && row.user_id !== "" ? row.user_id : null,
      features: row.features.toSorted(),
      models: row.models.toSorted(),
    })),
    more: rows.length > MAX_CONVERSATIONS,
  };
}

/**
 * List up to MAX_CONVERSATION_CALLS oldest first with FINAL; count totals over the full
 * conversation. "failed" selects conversations and still includes successful calls.
 */
export async function aiConversation(
  reader: Reader,
  scope: AiScope,
  filters: AiCallFilters,
  conversationId: string,
  { withUsers }: { withUsers: boolean },
): Promise<{ figures: AiConversationFigures | null; calls: AiCallItem[]; more: boolean }> {
  const narrowed = { ...filters, conversation: conversationId, failed: undefined };
  const callParams = new QueryParams();
  const figureParams = new QueryParams();
  const [rows, [figures]] = await Promise.all([
    queryRows<CallRow>(
      reader,
      `SELECT ${CALL_COLUMNS}
       FROM (${pricedCalls(callParams, scope, narrowed, {
         final: true,
         extra: extraOf(callParams, narrowed),
       })})
       ORDER BY timestamp, id
       LIMIT ${MAX_CONVERSATION_CALLS + 1}`,
      callParams,
      DASHBOARD_SETTINGS,
    ),
    queryRows<ConversationRow>(
      reader,
      `SELECT ${CONVERSATION_COLUMNS}
       FROM (${pricedCalls(figureParams, scope, narrowed, {
         final: true,
         extra: extraOf(figureParams, narrowed),
       })})
       LIMIT 1`,
      figureParams,
      DASHBOARD_SETTINGS,
    ),
  ]);
  return {
    figures: figures === undefined || count(figures.calls) === 0 ? null : figuresOf(figures),
    calls: rows.slice(0, MAX_CONVERSATION_CALLS).map((row) => itemOf(row, withUsers)),
    more: rows.length > MAX_CONVERSATION_CALLS,
  };
}
