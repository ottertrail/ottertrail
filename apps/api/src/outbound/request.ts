import type { Buffer } from "node:buffer";
import http, { type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { TLSSocket } from "node:tls";

import type { CheckCause } from "../db/schema.ts";
import { AddressNotAllowedError, NoAddressError, type ResolvedAddress } from "./addresses.ts";

/**
 * Share pinned requests between uptime checks (uptime/request.ts) and webhooks
 * (notifications/webhook.ts). Callers must first use resolveTarget to check the address
 * (addresses.ts).
 */

export type FailureCause = Exclude<CheckCause, "status" | "word" | "redirects">;

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

export const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";

export function classifyRequestError(error: unknown): { cause: FailureCause; detail: string } {
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
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
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

export interface PinnedRequest {
  method: string;
  /** The checked address (resolveTarget): the only one the connection may use. */
  target: ResolvedAddress;
  signal: AbortSignal;
  headers: OutgoingHttpHeaders;
  body?: string | Buffer | undefined;
  /** Certificates to trust besides the system's: tests trust their own. */
  ca?: string | Buffer | undefined;
}

/**
 * Pin the connection to the checked address while retaining the hostname for Host, SNI, and
 * certificate validation. Resolve on headers; callers decide whether to follow redirects.
 */
export function pinnedRequest(
  url: URL,
  { method, target, signal, headers, body, ca }: PinnedRequest,
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
        // Use a fresh connection so it cannot reuse another address.
        agent: false,
        lookup: pinned,
        signal,
        headers,
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
    request.end(body);
  });
}
