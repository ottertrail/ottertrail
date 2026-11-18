import { createHash } from "node:crypto";

import type { NewEvent } from "../collection/event-store.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import { MAX_PATH_LENGTH } from "../collection/normalize.ts";
import { fingerprint } from "../errors/fingerprint.ts";
import { ERROR } from "../visits/visits.ts";

/**
 * A server's exceptions, received over OTLP, as error events: the rows the
 * browser's errors are (docs/telemetry.md, "Exceptions join the error
 * list"; docs/errors.md). normalize.ts finds them, on spans (events named
 * "exception") and in log records (with exception.type or
 * exception.message), and this builds each one's event.
 */

/** At most this many of a span's exception events become errors: the first. */
export const MAX_EXCEPTIONS_PER_SPAN = 10;

/**
 * The limits the API holds a browser's error to (collection/routes.ts), so
 * a server's fits what a browser's may hold.
 */
export const MAX_ERROR_TYPE_CHARS = 200;
export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_ERROR_STACK_CHARS = 16_000;

/** The attributes OpenTelemetry's semantic conventions give an exception. */
export const EXCEPTION_TYPE = "exception.type";
export const EXCEPTION_MESSAGE = "exception.message";
export const EXCEPTION_STACKTRACE = "exception.stacktrace";

/** An exception's attributes as sent, before they are cut. */
export interface ExceptionAttributes {
  type?: string;
  message?: string;
  stacktrace?: string;
}

/** What one exception's event is made of. */
export interface ExceptionSource {
  projectId: string;
  /** The resource's, as the telemetry rows have them (normalize.ts). */
  service: string;
  environment: string;
  /** "" for none. */
  release: string;
  /** The span's or log record's attributes: its route and its user. */
  attributes: Record<string, string>;
  exception: ExceptionAttributes;
  /** When it happened, in nanoseconds since 1970. */
  occurredAtNs: bigint;
  handled: boolean;
  /** In hex, as the spans table has them; "" for none. */
  traceId: string;
  spanId: string;
  /** What tells this exception from every other of the project: its ID is made from them. */
  identity: string[];
}

const USER_ID = new RegExp(USER_ID_PATTERN);
/** Control characters: none in a type, a path, or a user ID. */
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/** As in a browser's message and stack: tabs and line feeds stay. */
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Text cut to `max` UTF-16 units, with no unpaired surrogate. */
function cut(value: string, max: number): string {
  return (value.length <= max ? value : value.slice(0, max)).toWellFormed();
}

/**
 * A value without the characters `remove` matches, cut to `max`: cut to
 * four times that first, as values come uncut, up to a request's size.
 */
function cleaned(value: string | undefined, remove: RegExp, max: number): string {
  return cut(cut(value ?? "", max * 4).replace(remove, ""), max);
}

/** Whether the attributes make an exception: a type or a message, as the conventions require. */
export function isException(exception: ExceptionAttributes): boolean {
  return (exception.type ?? "") !== "" || (exception.message ?? "") !== "";
}

/**
 * A UUID from a SHA-256 of the project and the exception's identity, with
 * the version nibble 8 and the RFC 4122 variant bits: a retried request makes
 * the same ID, so the events table keeps the event once.
 */
export function exceptionEventId(projectId: string, identity: readonly string[]): string {
  const bytes = createHash("sha256")
    .update([projectId, ...identity].join("\n"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The user's ID: `user.id`, else the older `enduser.id`, when it is one a browser could send. */
function userIdOf(attributes: Record<string, string>): string | undefined {
  const sent = attributes["user.id"] ?? attributes["enduser.id"];
  return sent !== undefined && USER_ID.test(sent) ? sent : undefined;
}

/** One exception's error event. */
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
