import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

import type { CheckCause } from "../db/schema.ts";
import {
  type AddressPolicy,
  AddressNotAllowedError,
  type Lookup,
  resolveTarget,
  systemLookup,
} from "../outbound/addresses.ts";
import { classifyRequestError, pinnedRequest, untilAborted } from "../outbound/request.ts";
import { type StatusRange, statusMatches } from "./statuses.ts";

/**
 * Pin requests to checked addresses and recheck every redirect (outbound/;
 * docs/uptime-alerts.md). One timeout covers DNS, connections, redirects, and body reads. Read
 * up to MAX_BODY_BYTES for word checks.
 */

export const MAX_REDIRECTS = 5;

/** Read at most 1 MB when checking body text. */
export const MAX_BODY_BYTES = 1024 * 1024;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Says what is asking, so a site can tell checks from visitors in its logs. */
const USER_AGENT = "Ottertrail-Uptime/1";

export interface CheckRequest {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
  expected: readonly StatusRange[];
  /** A word the body must hold, or must not; null for none. */
  word: string | null;
  wordMode: "present" | "absent";
}

export interface CheckOutcome {
  up: boolean;
  /** The last answer's status; null when nothing answered. */
  statusCode: number | null;
  /** From the start to the last answer's headers, redirects included; to the failure when none came. */
  responseMs: number;
  cause: CheckCause | null;
  detail: string;
  /** When the certificate of the first HTTPS answer expires; null without one. */
  tlsExpiresAt: Date | null;
  /**
   * The address that was refused, and its kind, for the server's log
   * only: `detail` does not name an address a host name resolved to.
   */
  refused?: { host: string; address: string; kind: string } | undefined;
}

export interface RequestOptions {
  policy: AddressPolicy;
  lookup?: Lookup | undefined;
  /** Certificates to trust besides the system's: tests trust their own. */
  ca?: string | Buffer | undefined;
}

class CheckFailure extends Error {
  readonly cause: CheckCause;
  readonly statusCode: number | null;
  constructor(cause: CheckCause, message: string, statusCode: number | null = null) {
    super(message);
    this.cause = cause;
    this.statusCode = statusCode;
  }
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

export function classify(error: unknown): { cause: CheckCause; detail: string } {
  if (error instanceof CheckFailure) return { cause: error.cause, detail: error.message };
  return classifyRequestError(error);
}

const HEADERS = { "user-agent": USER_AGENT, accept: "*/*", connection: "close" };

/** The body's first `limit` bytes as text; the rest is never read. */
function readBody(response: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      response.off("data", onData);
      const body = Buffer.concat(chunks).subarray(0, limit);
      resolve(new TextDecoder().decode(body));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) {
        // Settle before destroying the response so the resulting truncation is not reported as
        // failure.
        done();
        response.destroy();
      }
    };
    response.on("data", onData);
    response.once("end", done);
    response.once("error", reject);
    response.once("aborted", () => reject(new Error("The answer was cut off.")));
  });
}

export async function runRequest(
  check: CheckRequest,
  { policy, lookup = systemLookup, ca }: RequestOptions,
): Promise<CheckOutcome> {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TimeoutError("timed out")),
    Math.max(1, check.timeoutMs),
  );
  const { signal } = controller;
  let tlsExpiresAt: Date | null = null;
  let response: IncomingMessage | undefined;
  try {
    let url = new URL(check.url);
    let method: string = check.method;
    for (let redirects = 0; ; redirects += 1) {
      const target = await untilAborted(resolveTarget(url, { lookup, policy, signal }), signal);
      const sent = await pinnedRequest(url, { method, target, signal, headers: HEADERS, ca });
      response = sent.response;
      if (url.protocol === "https:" && tlsExpiresAt === null) tlsExpiresAt = sent.certificateExpiry;
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && location !== undefined) {
        response.destroy();
        if (redirects >= MAX_REDIRECTS) {
          throw new CheckFailure(
            "redirects",
            `More than ${MAX_REDIRECTS} redirects. The last response was ${status}.`,
            status,
          );
        }
        const next = URL.parse(location, url);
        if (next === null || (next.protocol !== "http:" && next.protocol !== "https:")) {
          throw new CheckFailure(
            "redirects",
            `A redirect (${status}) points to an address that is not http or https.`,
            status,
          );
        }
        if (status === 303 && method !== "HEAD") method = "GET";
        url = next;
        continue;
      }
      const responseMs = elapsed();
      if (!statusMatches(status, check.expected)) {
        response.destroy();
        return {
          up: false,
          statusCode: status,
          responseMs,
          cause: "status",
          detail: `It answered ${status}, which does not count as up.`,
          tlsExpiresAt,
        };
      }
      if (check.word !== null && check.method === "GET") {
        const body = await readBody(response, MAX_BODY_BYTES);
        const found = body.includes(check.word);
        if (found !== (check.wordMode === "present")) {
          return {
            up: false,
            statusCode: status,
            responseMs,
            cause: "word",
            detail: found
              ? `The body holds "${check.word}", which it must not.`
              : `The body does not hold "${check.word}" in its first megabyte.`,
            tlsExpiresAt,
          };
        }
      } else {
        response.destroy();
      }
      return { up: true, statusCode: status, responseMs, cause: null, detail: "", tlsExpiresAt };
    }
  } catch (error) {
    response?.destroy();
    const failed =
      signal.aborted && signal.reason instanceof TimeoutError
        ? {
            cause: "timeout" as const,
            detail: `No complete answer within ${check.timeoutMs / 1000} seconds.`,
          }
        : classify(error);
    return {
      up: false,
      statusCode: error instanceof CheckFailure ? error.statusCode : null,
      ...(error instanceof AddressNotAllowedError
        ? { refused: { host: error.host, address: error.address, kind: error.kind } }
        : {}),
      responseMs: elapsed(),
      ...failed,
      tlsExpiresAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
