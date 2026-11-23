import { ApiError } from "./api";

/**
 * Retry network failures once. API errors, including busy-query 503s, require manual Retry
 * to avoid adding load.
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
