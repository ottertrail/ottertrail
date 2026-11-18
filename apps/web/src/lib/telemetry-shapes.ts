import { ApiError } from "./api";

/** Shape checks and settings the telemetry clients share (traces-api.ts, logs-api.ts, …). */

/**
 * Retries of a telemetry page's request: none after an answer from the
 * API. A 503 says ClickHouse or the instance's queries are busy, and an
 * automatic retry would only add to them; the page offers Retry instead.
 * A request that never reached the API is retried once.
 */
export const telemetryRetry = (failures: number, error: Error) =>
  !(error instanceof ApiError && error.status !== 0) && failures < 1;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isText = (value: unknown): value is string => typeof value === "string";
export const isTextOrNull = (value: unknown): value is string | null =>
  value === null || isText(value);
export const isNumber = (value: unknown): value is number => typeof value === "number";
export const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);
/** Attributes as stored: every value is text. */
export const isTextMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isText);
