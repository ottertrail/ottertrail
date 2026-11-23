import { AI_CALLS_TABLE } from "../clickhouse/migrations.ts";
import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  dateOfNs,
  listChartBuckets,
  type TelemetryRange,
} from "../telemetry/dashboard-query.ts";
import { BUNDLED_BOOK, type PriceBook, pricedColumns } from "./prices.ts";

/**
 * Project-first parameterized reads use dashboard limits (DASHBOARD_SETTINGS; docs/ai-usage.md,
 * "The report"). t-digest percentiles bound memory across up to 366 days. Aggregates omit FINAL,
 * so retries count until merged; latest calls use FINAL. Costs are computed on read
 * (ai/prices.ts).
 */

/** Remaining models fold into "Other". */
export const MAX_LISTED_MODELS = 2000;
/** Remaining features fold into "Other". */
export const MAX_LISTED_FEATURES = 500;
/** Keeps users with the highest cost. */
export const MAX_LISTED_USERS = 50;
export const MAX_FAILURE_TYPES = 100;
export const RECENT_CALLS = 50;
/** Keeps highest-cost lines; folds the rest into "Other". */
export const CHART_SERIES = 10;
export const MAX_NO_PRICE_MODELS = 20;
/** These finish reasons indicate token-limit truncation. */
export const CUT_OFF_REASONS = ["length", "max_tokens"] as const;

export interface AiScope {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
  /** Restricts to an AI cost rule's open hours (alerts/ai-cost-hours.ts). Empty means no calls. */
  ranges?: readonly { from: Date; to: Date }[] | undefined;
  /** Defaults to bundled prices (custom-prices.ts, readPriceBook). */
  prices?: PriceBook | undefined;
}

/** Filters match stored values exactly; "" feature means unlabeled. */
export interface AiFilters {
  service?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  feature?: string | undefined;
  /** Routes require users-area access for this filter. */
  user?: string | undefined;
}

export const SPLITS = ["model", "feature"] as const;
export type AiSplit = (typeof SPLITS)[number];

function conditions(params: QueryParams, scope: AiScope, filters: AiFilters): string {
  const ranges = scope.ranges ?? [{ from: scope.from, to: scope.to }];
  const times = ranges.map(
    (range) => `(timestamp >= ${params.time(range.from)} AND timestamp < ${params.time(range.to)})`,
  );
  const parts = [
    `project_id = ${params.add(scope.projectId, "UUID")}`,
    times.length === 0 ? "0" : `(${times.join(" OR ")})`,
    `environment = ${params.add(scope.environment, "String")}`,
  ];
  for (const column of ["service", "provider", "model", "feature"] as const) {
    const value = filters[column];
    if (value !== undefined) parts.push(`${column} = ${params.add(value, "String")}`);
  }
  if (filters.user !== undefined) parts.push(`user_id = ${params.add(filters.user, "String")}`);
  return parts.join(" AND ");
}

/** Shared cost calculation for aggregates and call lists (call-list.ts). */
export function pricedCalls(
  params: QueryParams,
  scope: AiScope,
  filters: AiFilters,
  { final = false, extra = "" }: { final?: boolean; extra?: string } = {},
): string {
  return `SELECT *, ${pricedColumns(params, scope.prices ?? BUNDLED_BOOK)}
          FROM ${AI_CALLS_TABLE}${final ? " FINAL" : ""}
          WHERE ${conditions(params, scope, filters)} ${extra}`;
}

const count = (value: unknown) => Number(value ?? 0);
/** Nanoseconds to milliseconds; null without reported values. */
const ms = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number / 1e6 : null;
};
const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export interface AiTotals {
  calls: number;
  /** Includes cached tokens (all_input_tokens). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Estimated USD; unpriced models add nothing. */
  costUsd: number;
  /** 0 to 1; null without input. */
  cacheReadShare: number | null;
  /** Null without calls. */
  p95Ms: number | null;
  failed: number;
  /** 0 to 1; null without calls. */
  failedShare: number | null;
  /** Calls excluded from costUsd because no price is available. */
  noPriceCalls: number;
  noPriceModels: string[];
}

/**
 * Sum inclusive input and output counts so cache/reasoning conventions do not change totals
 * (all_input_tokens, all_output_tokens; prices.ts).
 */
const SUMS = `count() AS calls,
  sum(all_input_tokens) AS all_input, sum(all_output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
  sum(reasoning_tokens) AS reasoning_tokens, sum(cost) AS cost,
  countIf(failed) AS failed, countIf(NOT priced) AS no_price`;

interface SumsRow {
  calls: string;
  /** Includes cached tokens. */
  all_input: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  reasoning_tokens: string;
  cost: number;
  failed: string;
  no_price: string;
}

function sumsOf(row: SumsRow | undefined) {
  const calls = count(row?.calls);
  const inputTokens = count(row?.all_input);
  const cacheReadTokens = count(row?.cache_read_tokens);
  const failed = count(row?.failed);
  return {
    calls,
    inputTokens,
    outputTokens: count(row?.output_tokens),
    cacheReadTokens,
    cacheWriteTokens: count(row?.cache_write_tokens),
    reasoningTokens: count(row?.reasoning_tokens),
    costUsd: calls === 0 ? 0 : (row?.cost ?? 0),
    cacheReadShare: inputTokens === 0 ? null : Math.min(1, cacheReadTokens / inputTokens),
    failed,
    failedShare: share(failed, calls),
    noPriceCalls: count(row?.no_price),
  };
}

export async function aiTotals(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<AiTotals> {
  const params = new QueryParams();
  const [row] = await queryRows<SumsRow & { p95: number | null; no_price_models: string[] }>(
    reader,
    `SELECT ${SUMS}, quantileTDigest(0.95)(duration_ns) AS p95,
            groupUniqArrayIf(${MAX_NO_PRICE_MODELS})(model, NOT priced) AS no_price_models
     FROM (${pricedCalls(params, scope, filters)})
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  const sums = sumsOf(row);
  return {
    ...sums,
    p95Ms: sums.calls === 0 ? null : ms(row?.p95),
    noPriceModels: (row?.no_price_models ?? []).toSorted(),
  };
}

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
  /** Median among calls reporting first-chunk time; null if none. */
  firstChunkP50Ms: number | null;
  /** Finish reason length or max_tokens. */
  cutOff: number;
  cutOffShare: number | null;
}

export interface ModelRow extends AiFigures {
  /** "" if absent or for the Other row. */
  model: string;
  /** Most common provider; "" for Other. */
  provider: string;
  /** Models outside the top MAX_LISTED_MODELS by call count. */
  other: boolean;
  /** False for Other. */
  priced: boolean;
}

export interface FeatureRow extends AiFigures {
  /** "" for unlabeled calls and Other. */
  feature: string;
  /** Features outside the top MAX_LISTED_FEATURES by call count. */
  other: boolean;
}

interface BreakdownRow extends SumsRow {
  listed: number | boolean;
  group_key: string;
  provider: string;
  p50: number | null;
  p95: number | null;
  first_chunk: number | null;
  cut_off: string;
}

const CUT_OFF = `hasAny(finish_reasons, ['${CUT_OFF_REASONS.join("', '")}'])`;

const FIGURES = `${SUMS},
  quantilesTDigest(0.5, 0.95)(duration_ns) AS durations,
  durations[1] AS p50,
  durations[2] AS p95,
  quantileTDigest(0.5)(first_chunk_ns) AS first_chunk,
  countIf(${CUT_OFF}) AS cut_off`;

function figuresOf(row: BreakdownRow): AiFigures {
  const sums = sumsOf(row);
  const cutOff = count(row.cut_off);
  return {
    ...sums,
    p50Ms: ms(row.p50),
    p95Ms: ms(row.p95),
    firstChunkP50Ms: ms(row.first_chunk),
    cutOff,
    cutOffShare: share(cutOff, sums.calls),
  };
}

const listedOf = (value: number | boolean) => value === true || value === 1;

/** Keeps the most frequent values, folds the rest into Other, then sorts by cost and call count. */
async function breakdown(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
  column: AiSplit,
  limit: number,
): Promise<BreakdownRow[]> {
  const params = new QueryParams();
  const top = `SELECT ${column} FROM ${AI_CALLS_TABLE}
               WHERE ${conditions(params, scope, filters)}
               GROUP BY ${column} ORDER BY count() DESC, ${column} LIMIT ${limit}`;
  return queryRows<BreakdownRow>(
    reader,
    `SELECT listed, if(listed, ${column}, '') AS group_key, topK(1)(provider)[1] AS provider, ${FIGURES}
     FROM (SELECT *, ${column} IN (${top}) AS listed
           FROM (${pricedCalls(params, scope, filters)}))
     GROUP BY listed, group_key
     ORDER BY cost DESC, calls DESC, group_key
     LIMIT ${limit + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
}

/** Models outside the top MAX_LISTED_MODELS by calls fold into Other. */
export async function aiModels(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<ModelRow[]> {
  const rows = await breakdown(reader, scope, filters, "model", MAX_LISTED_MODELS);
  return rows.map((row) => {
    const other = !listedOf(row.listed);
    const figures = figuresOf(row);
    return {
      model: other ? "" : row.group_key,
      provider: other ? "" : row.provider,
      other,
      priced: !other && figures.noPriceCalls === 0,
      ...figures,
    };
  });
}

/** Features outside the top MAX_LISTED_FEATURES by calls fold into Other. */
export async function aiFeatures(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<FeatureRow[]> {
  const rows = await breakdown(reader, scope, filters, "feature", MAX_LISTED_FEATURES);
  return rows.map((row) => {
    const other = !listedOf(row.listed);
    return { feature: other ? "" : row.group_key, other, ...figuresOf(row) };
  });
}

export interface UserRow {
  userId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failed: number;
  noPriceCalls: number;
}

/** Excludes calls without a user; ranks users by cost. */
export async function aiUsers(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<UserRow[]> {
  const params = new QueryParams();
  const rows = await queryRows<SumsRow & { user_id: string }>(
    reader,
    `SELECT user_id, ${SUMS}
     FROM (${pricedCalls(params, scope, filters, { extra: "AND user_id != ''" })})
     GROUP BY user_id
     ORDER BY cost DESC, calls DESC, user_id
     LIMIT ${MAX_LISTED_USERS}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.map((row) => {
    const sums = sumsOf(row);
    return {
      userId: row.user_id,
      calls: sums.calls,
      inputTokens: sums.inputTokens,
      outputTokens: sums.outputTokens,
      costUsd: sums.costUsd,
      failed: sums.failed,
      noPriceCalls: sums.noPriceCalls,
    };
  });
}

export interface FailureRow {
  /** "" for failures without error.type. */
  errorType: string;
  calls: number;
  lastAt: Date;
}

export async function aiFailures(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<FailureRow[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ error_type: string; calls: string; last_ns: string }>(
    reader,
    `SELECT error_type, count() AS calls,
            toString(toUnixTimestamp64Nano(max(timestamp))) AS last_ns
     FROM ${AI_CALLS_TABLE}
     WHERE ${conditions(params, scope, filters)} AND failed
     GROUP BY error_type
     ORDER BY calls DESC, error_type
     LIMIT ${MAX_FAILURE_TYPES}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.map((row) => ({
    errorType: row.error_type,
    calls: count(row.calls),
    lastAt: dateOfNs(row.last_ns),
  }));
}

export interface RecentCall {
  traceId: string;
  spanId: string;
  /** Nanoseconds since 1970 for span lookup (GET …/traces/:traceId/spans/:spanId?start=). */
  startNs: string;
  at: Date;
  service: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  feature: string;
  /** Null without users-area access or a call user. */
  userId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Estimated; null without a price. */
  costUsd: number | null;
  durationMs: number;
  firstChunkMs: number | null;
  failed: boolean;
  errorType: string;
  finishReasons: string[];
}

/** Read the last day first because FINAL merges every row in its range. */
const RECENT_FIRST_MS = 86_400_000;

/**
 * Reads the last day with FINAL first, expanding to the full range only if fewer than RECENT_CALLS
 * were found.
 */
export async function recentAiCalls(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
  { withUsers }: { withUsers: boolean },
): Promise<RecentCall[]> {
  const lastDay = new Date(Math.max(scope.from.getTime(), scope.to.getTime() - RECENT_FIRST_MS));
  let rows = await recentRows(reader, { ...scope, from: lastDay }, filters);
  if (rows.length < RECENT_CALLS && lastDay > scope.from) {
    rows = await recentRows(reader, scope, filters);
  }
  return rows.map((row) => ({
    traceId: row.trace_id,
    spanId: row.span_id,
    startNs: row.start_ns,
    at: dateOfNs(row.start_ns),
    service: row.service,
    release: row.release,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    feature: row.feature,
    userId: withUsers && row.user_id !== "" ? row.user_id : null,
    inputTokens: count(row.input_tokens),
    outputTokens: count(row.output_tokens),
    cacheReadTokens: count(row.cache_read_tokens),
    cacheWriteTokens: count(row.cache_write_tokens),
    reasoningTokens: count(row.reasoning_tokens),
    costUsd: listedOf(row.priced) ? row.cost : null,
    durationMs: ms(row.duration_ns) ?? 0,
    firstChunkMs: ms(row.first_chunk_ns),
    failed: listedOf(row.failed),
    errorType: row.error_type,
    finishReasons: row.finish_reasons,
  }));
}

interface RecentRow {
  trace_id: string;
  span_id: string;
  start_ns: string;
  service: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  feature: string;
  user_id: string;
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

async function recentRows(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<RecentRow[]> {
  const params = new QueryParams();
  return queryRows<RecentRow>(
    reader,
    `SELECT trace_id, span_id, toString(toUnixTimestamp64Nano(timestamp)) AS start_ns, service,
            release, provider, model, operation, feature, user_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, priced, duration_ns,
            first_chunk_ns, failed, error_type, finish_reasons
     FROM (${pricedCalls(params, scope, filters, { final: true })})
     ORDER BY timestamp DESC, id DESC
     LIMIT ${RECENT_CALLS}`,
    params,
    DASHBOARD_SETTINGS,
  );
}

export interface AiLabels {
  environments: string[];
  services: string[];
  providers: string[];
  models: string[];
  /** Capped at MAX_LISTED_FEATURES; "" means unlabeled. */
  features: string[];
}

const sorted = (values: string[] | undefined) => (values ?? []).toSorted();

/** Ignores other filters so the filter bar offers all values in range. */
export async function aiLabels(reader: Reader, scope: AiScope): Promise<AiLabels> {
  const params = new QueryParams();
  const environment = params.add(scope.environment, "String");
  const [row] = await queryRows<{
    environments: string[];
    services: string[];
    providers: string[];
    models: string[];
    features: string[];
  }>(
    reader,
    `SELECT groupUniqArray(100)(environment) AS environments,
            groupUniqArrayIf(200)(service, environment = ${environment}) AS services,
            groupUniqArrayIf(200)(provider, environment = ${environment}) AS providers,
            groupUniqArrayIf(${MAX_LISTED_MODELS})(model, environment = ${environment}) AS models,
            groupUniqArrayIf(${MAX_LISTED_FEATURES})(feature, environment = ${environment}) AS features
     FROM ${AI_CALLS_TABLE}
     WHERE project_id = ${params.add(scope.projectId, "UUID")}
       AND timestamp >= ${params.time(scope.from)} AND timestamp < ${params.time(scope.to)}
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  const environments = sorted(row?.environments);
  return {
    environments: environments.includes(scope.environment)
      ? environments
      : [...environments, scope.environment].toSorted(),
    services: sorted(row?.services),
    providers: sorted(row?.providers),
    models: sorted(row?.models),
    features: sorted(row?.features),
  };
}

/** False shows setup instructions. */
export async function hasAiCalls(reader: Reader, projectId: string): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM ${AI_CALLS_TABLE} WHERE project_id = ${params.add(projectId, "UUID")} LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.length > 0;
}

export interface AiSeries {
  costUsd: number[];
  /** Input plus output tokens. */
  tokens: number[];
  calls: number[];
  /** Null without calls. */
  p95Ms: (number | null)[];
}

export interface AiChart {
  start: Date;
  /** Bucket starts in the instance timezone (listChartBuckets). */
  bucketStarts: Date[];
  stepSeconds: number;
  buckets: number;
  split: AiSplit;
  /** Top CHART_SERIES by cost, then Other. */
  series: (AiSeries & { key: string; other: boolean })[];
  total: AiSeries;
}

interface BucketRow {
  bucket: string | number;
  calls: string;
  tokens: string;
  cost: number;
  p95: number | null;
}

/** Uses listChartBuckets. Keeps CHART_SERIES by cost then call count, folding the rest into Other. */
export async function aiChart(
  reader: Reader,
  range: TelemetryRange,
  filters: AiFilters,
  split: AiSplit,
  now: Date,
  prices: PriceBook = BUNDLED_BOOK,
): Promise<AiChart> {
  const buckets = listChartBuckets(range, now);
  const size = buckets.starts.length;
  const blank = (): AiSeries => ({
    costUsd: Array.from({ length: size }, () => 0),
    tokens: Array.from({ length: size }, () => 0),
    calls: Array.from({ length: size }, () => 0),
    p95Ms: Array.from({ length: size }, () => null),
  });
  const chart: AiChart = {
    start: new Date(buckets.starts[0] ?? range.from.getTime()),
    bucketStarts: buckets.starts.map((start) => new Date(start)),
    stepSeconds: buckets.stepSeconds,
    buckets: size,
    split,
    series: [],
    total: blank(),
  };
  if (size === 0) return chart;
  const scope: AiScope = {
    projectId: range.projectId,
    environment: range.environment,
    from: range.from,
    to: range.to,
    prices,
  };
  const place = (target: AiSeries, row: BucketRow) => {
    const index = Number(row.bucket);
    if (index < 0 || index >= size) return;
    const calls = count(row.calls);
    target.calls[index] = calls;
    target.tokens[index] = count(row.tokens);
    target.costUsd[index] = calls === 0 ? 0 : row.cost;
    target.p95Ms[index] = calls === 0 ? null : ms(row.p95);
  };
  const columns = `count() AS calls, sum(all_input_tokens + all_output_tokens) AS tokens, sum(cost) AS cost,
    quantileTDigest(0.95)(duration_ns) AS p95`;

  const totalParams = new QueryParams();
  const totals = queryRows<BucketRow>(
    reader,
    `SELECT ${buckets.bucketSql(totalParams)} AS bucket, ${columns}
     FROM (${pricedCalls(totalParams, scope, filters)})
     GROUP BY bucket ORDER BY bucket LIMIT ${size + 2}`,
    totalParams,
    DASHBOARD_SETTINGS,
  );
  const params = new QueryParams();
  const top = `SELECT ${split} FROM (${pricedCalls(params, scope, filters)})
               GROUP BY ${split} ORDER BY sum(cost) DESC, count() DESC, ${split}
               LIMIT ${CHART_SERIES}`;
  const split_rows = queryRows<BucketRow & { listed: number | boolean; group_key: string }>(
    reader,
    `SELECT ${buckets.bucketSql(params)} AS bucket, listed, if(listed, ${split}, '') AS group_key,
            ${columns}
     FROM (SELECT *, ${split} IN (${top}) AS listed FROM (${pricedCalls(params, scope, filters)}))
     GROUP BY bucket, listed, group_key
     ORDER BY bucket
     LIMIT ${(size + 2) * (CHART_SERIES + 1)}`,
    params,
    DASHBOARD_SETTINGS,
  );
  const [totalRows, splitRows] = await Promise.all([totals, split_rows]);
  for (const row of totalRows) place(chart.total, row);
  const lines = new Map<string, AiSeries & { key: string; other: boolean; cost: number }>();
  for (const row of splitRows) {
    const other = !listedOf(row.listed);
    const name = other ? "\u0000other" : row.group_key;
    let line = lines.get(name);
    if (line === undefined) {
      line = { key: other ? "" : row.group_key, other, cost: 0, ...blank() };
      lines.set(name, line);
    }
    place(line, row);
    line.cost += count(row.calls) === 0 ? 0 : row.cost;
  }
  chart.series = [...lines.values()]
    .toSorted((a, b) => Number(a.other) - Number(b.other) || b.cost - a.cost)
    .map(({ cost: _cost, ...line }) => line);
  return chart;
}

/** Alert-window figures (alerts/ai-rules.ts). */
export interface AiWindow {
  calls: number;
  failed: number;
  costUsd: number;
  noPriceCalls: number;
}

export async function aiWindow(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<AiWindow> {
  const params = new QueryParams();
  const [row] = await queryRows<SumsRow>(
    reader,
    `SELECT ${SUMS} FROM (${pricedCalls(params, scope, filters)}) LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  const sums = sumsOf(row);
  return {
    calls: sums.calls,
    failed: sums.failed,
    costUsd: sums.costUsd,
    noPriceCalls: sums.noPriceCalls,
  };
}

export async function aiLatencyWindow(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<{ calls: number; p95Ms: number | null }> {
  const params = new QueryParams();
  const [row] = await queryRows<{ calls: string; p95: number | null }>(
    reader,
    `SELECT count() AS calls, quantileTDigest(0.95)(duration_ns) AS p95
     FROM ${AI_CALLS_TABLE}
     WHERE ${conditions(params, scope, filters)}
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  const calls = count(row?.calls);
  return { calls, p95Ms: calls === 0 ? null : ms(row?.p95) };
}

/** UTC hours retained by alerts/ai-cost-hours.ts. */
export interface AiHour {
  hour: Date;
  costUsd: number;
  calls: number;
  noPriceCalls: number;
}

/** Omits hours without calls. */
export async function aiHours(
  reader: Reader,
  scope: AiScope,
  filters: AiFilters,
): Promise<AiHour[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ hour: number; calls: string; cost: number; no_price: string }>(
    reader,
    `SELECT toUnixTimestamp(toStartOfHour(timestamp)) AS hour, count() AS calls,
            sum(cost) AS cost, countIf(NOT priced) AS no_price
     FROM (${pricedCalls(params, scope, filters)})
     GROUP BY hour ORDER BY hour
     LIMIT 10000`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.map((row) => ({
    hour: new Date(row.hour * 1000),
    costUsd: row.cost,
    calls: count(row.calls),
    noPriceCalls: count(row.no_price),
  }));
}

/** A rule matching no calls may never fire. */
export async function aiSeen(reader: Reader, scope: AiScope, filters: AiFilters): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM ${AI_CALLS_TABLE} WHERE ${conditions(params, scope, filters)} LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.length > 0;
}
