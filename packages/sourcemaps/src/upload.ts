import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import type { SourceMapFile } from "./find.ts";

const gzip = promisify(gzipCallback);

/** The server refuses maps larger than this once unpacked. */
export const MAX_SOURCE_MAP_BYTES = 25 * 1024 * 1024;
export const MAX_ATTEMPTS = 4;
/** Count 429/503 Retry-After waits separately; large builds routinely hit server limits. */
export const MAX_WAITS = 30;
const MAX_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
/** Answers worth another try: rate limits, and a server or proxy briefly unable to answer. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** Stop new uploads when every file would fail for the same reason. */
const FATAL_ERRORS = new Set(["unauthorized", "unknown_key", "not_configured", "storage_limit"]);

export type UploadOutcome =
  | { status: "stored" | "replaced" }
  | { status: "failed"; message: string; fatal: boolean };

export interface UploadContext {
  endpoint: URL;
  release: string;
  secretKey: string;
  fetch: typeof globalThis.fetch;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Retry-After as milliseconds: seconds, or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/u.test(text)) return Math.min(Number(text) * 1000, MAX_WAIT_MS);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - now, 0), MAX_WAIT_MS);
}

/** 1 s, 2 s, 4 s: the wait before attempt `attempt + 1` when the server named none. */
const backoff = (attempt: number) => 1000 * 2 ** (attempt - 1);

async function readProblem(response: Response): Promise<{ error: string; message: string }> {
  const text = await response.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error, message } = body as { error: unknown; message?: unknown };
      return {
        error: String(error),
        message: typeof message === "string" ? message : "",
      };
    }
  } catch {
    // A proxy may return a non-JSON error page.
  }
  return { error: `HTTP ${response.status}`, message: response.statusText };
}

function networkMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "the server did not answer in time";
    const cause = error.cause;
    if (cause instanceof Error) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

/** Gzip and upload a map, retrying network failures and server waits. */
export async function uploadSourceMap(
  file: SourceMapFile,
  context: UploadContext,
): Promise<UploadOutcome> {
  const raw = await readFile(file.mapPath);
  if (raw.length > MAX_SOURCE_MAP_BYTES) {
    return {
      status: "failed",
      message: "larger than 25 MiB, the most the server accepts",
      fatal: false,
    };
  }
  const body = await gzip(raw);
  const url = new URL(context.endpoint);
  url.searchParams.set("release", context.release);
  url.searchParams.set("path", file.urlPath);

  let waits = 0;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await context.fetch(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${context.secretKey}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await context.sleep(backoff(attempt));
        continue;
      }
      return {
        status: "failed",
        message: `could not reach the server after ${MAX_ATTEMPTS} attempts: ${networkMessage(error)}`,
        fatal: false,
      };
    }

    if (response.status === 201 || response.status === 200) {
      await response.body?.cancel();
      return { status: response.status === 201 ? "stored" : "replaced" };
    }
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const problem = await readProblem(response);
    const fatal = FATAL_ERRORS.has(problem.error);
    const asksToWait =
      (response.status === 429 || response.status === 503) && retryAfter !== null && !fatal;
    if (asksToWait && waits < MAX_WAITS) {
      waits += 1;
      // A wait the server asked for is not a failed attempt.
      attempt -= 1;
      await context.sleep(retryAfter);
      continue;
    }
    if (RETRY_STATUSES.has(response.status) && !fatal && attempt < MAX_ATTEMPTS) {
      await context.sleep(retryAfter ?? backoff(attempt));
      continue;
    }
    const detail = problem.message === "" ? "" : `: ${problem.message}`;
    const tries = attempt > 1 ? ` (after ${attempt} attempts)` : "";
    return {
      status: "failed",
      message: `${response.status} ${problem.error}${detail}${tries}`,
      fatal,
    };
  }
}
