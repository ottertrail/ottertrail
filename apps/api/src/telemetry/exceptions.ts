import { createHash } from "node:crypto";

import type { NewEvent } from "../collection/event-store.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import { MAX_PATH_LENGTH } from "../collection/normalize.ts";
import { fingerprint } from "../errors/fingerprint.ts";
import { ERROR } from "../visits/visits.ts";

/**
 * Converts OTLP span exception events and logs with exception.type or exception.message to error
 * events (docs/telemetry.md, "Exceptions join the error list"; docs/errors.md).
 */

/** Only the first exceptions become error events. */
export const MAX_EXCEPTIONS_PER_SPAN = 10;

/** Matches browser error limits (collection/routes.ts). */
export const MAX_ERROR_TYPE_CHARS = 200;
export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_ERROR_STACK_CHARS = 16_000;

export const EXCEPTION_TYPE = "exception.type";
export const EXCEPTION_MESSAGE = "exception.message";
export const EXCEPTION_STACKTRACE = "exception.stacktrace";

/** Uncut attributes as sent. */
export interface ExceptionAttributes {
  type?: string;
  message?: string;
  stacktrace?: string;
}

export interface ExceptionSource {
  projectId: string;
  service: string;
  environment: string;
  /** "" for none. */
  release: string;
  attributes: Record<string, string>;
  exception: ExceptionAttributes;
  /** When it happened, in nanoseconds since 1970. */
  occurredAtNs: bigint;
  handled: boolean;
  /** In hex, as the spans table has them; "" for none. */
  traceId: string;
  spanId: string;
  /** Project-scoped identity used to derive a stable event ID. */
  identity: string[];
}

const USER_ID = new RegExp(USER_ID_PATTERN);
/** Types, paths, and user IDs cannot contain control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/** Preserves tabs and line feeds, as browser messages and stacks do. */
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Cuts at UTF-16 boundaries without leaving an unpaired surrogate. */
function cut(value: string, max: number): string {
  return (value.length <= max ? value : value.slice(0, max)).toWellFormed();
}

/** Bounds regex work by cutting untrusted input to four times `max` first. */
function cleaned(value: string | undefined, remove: RegExp, max: number): string {
  return cut(cut(value ?? "", max * 4).replace(remove, ""), max);
}

/** OpenTelemetry requires a type or message. */
export function isException(exception: ExceptionAttributes): boolean {
  return (exception.type ?? "") !== "" || (exception.message ?? "") !== "";
}

/** Hashes project and identity into a UUID (version 8, RFC 4122 variant) so retries deduplicate. */
export function exceptionEventId(projectId: string, identity: readonly string[]): string {
  const bytes = createHash("sha256")
    .update([projectId, ...identity].join("\n"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

/**
 * Uses user.id, then enduser.id, with browser user ID limits. AI calls use the same rule
 * (ai/calls.ts).
 */
export function userIdOf(attributes: Record<string, string>): string | undefined {
  const sent = attributes["user.id"] ?? attributes["enduser.id"];
  return sent !== undefined && USER_ID.test(sent) ? sent : undefined;
}

export function exceptionEvent(source: ExceptionSource): NewEvent {
  const type = cleaned(source.exception.type, CONTROL, MAX_ERROR_TYPE_CHARS).trim() || "Error";
  const message = cleaned(source.exception.message, CONTROL_BUT_LINES, MAX_ERROR_MESSAGE_CHARS);
  const stack = cleaned(source.exception.stacktrace, CONTROL_BUT_LINES, MAX_ERROR_STACK_CHARS);
  const route = cut((source.attributes["http.route"] ?? "").replace(CONTROL, ""), MAX_PATH_LENGTH);
  const userId = userIdOf(source.attributes);
  const error = { type, message, ...(stack === "" ? {} : { stack }) };
  return {
    eventId: exceptionEventId(source.projectId, source.identity),
    name: ERROR,
    occurredAt: new Date(Number(source.occurredAtNs / 1_000_000n)),
    path: route,
    properties: {},
    environment: source.environment,
    ...(source.release === "" ? {} : { release: source.release }),
    ...(userId === undefined ? {} : { userId }),
    error: {
      ...error,
      handled: source.handled,
      fingerprint: fingerprint(error, { server: true }),
    },
    server: { service: source.service, traceId: source.traceId, spanId: source.spanId },
  };
}
