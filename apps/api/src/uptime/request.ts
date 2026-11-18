import { Buffer } from "node:buffer";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { TLSSocket } from "node:tls";

import type { CheckCause } from "../db/schema.ts";
import {
  type AddressPolicy,
  AddressNotAllowedError,
  type Lookup,
  NoAddressError,
  type ResolvedAddress,
  resolveTarget,
  systemLookup,
} from "./addresses.ts";
import { type StatusRange, statusMatches } from "./statuses.ts";

/**
 * One uptime check's request (docs/uptime-alerts.md): the URL's host is
 * resolved and its addresses checked (addresses.ts), the request connects
 * to the checked address without resolving again, each redirect is
 * checked the same way, at most MAX_REDIRECTS of them, and the body is
 * read up to MAX_BODY_BYTES when a word is looked for. One timeout covers
 * it all: resolving, connecting, redirects, and the body.
 */

/** Redirects followed before the check fails. */
export const MAX_REDIRECTS = 5;

/** The most of a body read to look for the word: 1 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Says what is asking, so a site can tell checks from visitors in its logs. */
const USER_AGENT = "Ottertrail-Uptime/1";

/** What a check asks for and expects. */
export interface CheckRequest {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
  expected: readonly StatusRange[];
  /** A word the body must hold, or must not; null for none. */
  word: string | null;
  wordMode: "present" | "absent";
}

/** What the request found. */
export interface CheckOutcome {
  up: boolean;
  /** The last answer's status; null when nothing answered. */
  statusCode: number | null;
  /** From the start to the last answer's headers, redirects included; to the failure when none came. */
  responseMs: number;
  /** Why it failed; null when up. */
  cause: CheckCause | null;
  /** A short sentence on what happened, shown with a failure. */
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

/** A failure the request itself found, with its cause. */
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

const DNS_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NODATA",
  "EAI_NONAME",
  "ENODATA",
  "ESERVFAIL",
  "ENOTIMP",
  "EREFUSED",
  "ETIMEOUT",
]);

/** Node's and OpenSSL's codes for a certificate or handshake that failed. */
function isTlsCode(code: string): boolean {
  return (
    code === "EPROTO" ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_") ||
    code.startsWith("UNABLE_TO_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "HOSTNAME_MISMATCH"
  );
}

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";

/** The cause and sentence of an error the request threw. */
export function classify(error: unknown): { cause: CheckCause; detail: string } {
  if (error instanceof CheckFailure) return { cause: error.cause, detail: error.message };
  if (error instanceof AddressNotAllowedError) return { cause: "address", detail: error.message };
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  // c-ares's errors name the query (queryA, queryAaaa), whatever their code.
  const syscall =
    typeof error === "object" && error !== null && "syscall" in error ? String(error.syscall) : "";
  if (error instanceof NoAddressError || DNS_CODES.has(code) || syscall.startsWith("query")) {
    return { cause: "dns", detail: `The host could not be resolved (${code || "no address"}).` };
  }
  if (code === "ECONNREFUSED") return { cause: "refused", detail: "The connection was refused." };
  if (isTlsCode(code)) return { cause: "tls", detail: `TLS failed: ${message}` };
  return {
    cause: "connection",
    detail: `The connection failed: ${message}${code === "" || message.includes(code) ? "" : ` (${code})`}`,
  };
}

/** Rejects when `signal` fires, so a step that cannot be aborted (a DNS lookup) still ends on time. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

/**
 * Sends one request to `target`, the checked address: the host name stays
 * in the URL, so the Host header and TLS's server name (SNI) and
 * certificate check use it, while the connection's lookup answers with the
 * checked address and nothing else.
 */
function send(
  url: URL,
  method: string,
  target: ResolvedAddress,
  signal: AbortSignal,
  ca: RequestOptions["ca"],
): Promise<{ response: IncomingMessage; certificateExpiry: Date | null }> {
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [target]);
    } else {
      callback(null, target.address, target.family);
    }
  };
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method,
        // A connection of its own each time: never one opened to another address.
        agent: false,
        lookup: pinned,
        signal,
        headers: { "user-agent": USER_AGENT, accept: "*/*", connection: "close" },
        ...(ca === undefined ? {} : { ca }),
      },
      (response) => {
        let certificateExpiry: Date | null = null;
        if (response.socket instanceof TLSSocket) {
          const certificate = response.socket.getPeerCertificate();
          const expiry = new Date(certificate.valid_to);
          if (!Number.isNaN(expiry.getTime())) certificateExpiry = expiry;
        }
        resolve({ response, certificateExpiry });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

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
        // Settled first: destroying the answer then reports it cut off, which is no failure here.
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

/** Runs one check's request and says whether it was up, and if not, why. */
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
      const sent = await send(url, method, target, signal, ca);
      response = sent.response;
      if (url.protocol === "https:" && tlsExpiresAt === null) tlsExpiresAt = sent.certificateExpiry;
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && location !== undefined) {
        response.destroy();
        if (redirects >= MAX_REDIRECTS) {
          throw new CheckFailure(
            "redirects",
            `More than ${MAX_REDIRECTS} redirects; the last answered ${status}.`,
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
