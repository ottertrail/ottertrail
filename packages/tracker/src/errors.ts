/**
 * Browser errors: uncaught exceptions, unhandled promise rejections, and
 * errors the site reports itself with captureError(). Each one becomes an
 * "error" event, cut to fit the API's limits.
 */
import { cleanText } from "./sanitize.ts";

/** The event errors are sent as. Reserved: pages cannot send it with track(). */
export const ERROR = "error";
/** Errors sent per page load, at most, so a broken page cannot flood the project. */
export const MAX_ERRORS = 25;
export const MAX_TYPE_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_STACK_LENGTH = 16_000;

export interface ErrorDetails {
  type: string;
  message: string;
  stack?: string;
  /** True only when the site reported it with captureError(). */
  handled: boolean;
  /** The session replay recorded around this error, when one will be sent (replay-recorder.ts). */
  replayId?: string;
}

export interface ErrorCapture {
  /** A window "error" event: only ErrorEvents count, not failed images or scripts. */
  uncaught: (event: Event) => void;
  /** The reason of a window "unhandledrejection" event. */
  rejected: (reason: unknown) => void;
  /** captureError(): an error the site caught and reports itself. */
  handled: (error: unknown, properties?: unknown) => void;
}

const EXTENSION = /^(?:chrome|moz|safari|safari-web)-extension:\/\//;
/**
 * The URL of the first stack frame that names one: V8's "    at fn (url:1:2)"
 * or "    at url:1:2", Firefox's and Safari's "fn@url:1:2".
 */
const FRAME_URL = /^(?:\s+at (?:.*?\()?|[^@\n]*@)([a-z][\w+.-]*:\/\/[^\s)]*)/im;
/** A cross-origin script loaded without CORS: the browser hides every detail. */
const SCRIPT_ERROR = /^Script error\.?$/;

/** A value that is not an Error, as text: JSON for a plain object. */
function describe(value: unknown): string {
  try {
    const prototype: unknown = typeof value === "object" && value && Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return JSON.stringify(value);
    }
    return String(value);
  } catch {
    return ""; // A cycle, a BigInt, or a toString() that throws.
  }
}

/** What a thrown or rejected value says about itself; `type` names a value that is not an Error. */
export function errorDetails(value: unknown, type: string, handled: boolean): ErrorDetails {
  const error = value instanceof Error ? value : undefined;
  const stack =
    typeof error?.stack === "string" ? cleanText(error.stack, MAX_STACK_LENGTH, true) : "";
  return {
    type: (error && cleanText(error.name, MAX_TYPE_LENGTH)) || type,
    message: cleanText(error ? error.message : describe(value), MAX_MESSAGE_LENGTH, true),
    ...(stack === "" ? {} : { stack }),
    handled,
  };
}

/**
 * Sends each error through `send`, skipping noise (hidden cross-origin
 * errors, browser extensions) and floods: an identical error goes once per
 * page load, and MAX_ERRORS in all. Never throws, so an error here cannot
 * start a loop of captures.
 */
export function createErrorCapture(
  send: (error: ErrorDetails, properties?: unknown) => void,
): ErrorCapture {
  const seen = new Set<string>();

  const report = (error: ErrorDetails, properties?: unknown, filename = "") => {
    const key = `${error.type}\n${error.message}\n${error.stack}`;
    if (
      seen.size >= MAX_ERRORS ||
      seen.has(key) ||
      (error.stack === undefined && SCRIPT_ERROR.test(error.message)) ||
      EXTENSION.test(filename) ||
      EXTENSION.test(FRAME_URL.exec(error.stack ?? "")?.[1] ?? "")
    ) {
      return;
    }
    seen.add(key);
    send(error, properties);
  };

  return {
    uncaught: (event) => {
      try {
        if (event instanceof ErrorEvent) {
          const details = errorDetails(event.error, "Error", false);
          if (!(event.error instanceof Error)) {
            // A thrown string or other value: the browser's message names it.
            details.message = cleanText(event.message, MAX_MESSAGE_LENGTH, true);
          }
          report(details, undefined, event.filename);
        }
      } catch {
        // Never break the page the tracker runs on.
      }
    },
    rejected: (reason) => {
      try {
        report(errorDetails(reason, "UnhandledRejection", false));
      } catch {
        // Never break the page the tracker runs on.
      }
    },
    handled: (error, properties) => {
      try {
        report(errorDetails(error, "Error", true), properties);
      } catch {
        // Never break the page the tracker runs on.
      }
    },
  };
}
