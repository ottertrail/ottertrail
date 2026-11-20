/** A failed API request, with the API's own message when it sent one. */
export class ApiError extends Error {
  override name = "ApiError";
  /** HTTP status; 0 when the API could not be reached or answered something unexpected. */
  readonly status: number;
  /** The API's error code, such as "invalid_hostname". */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The code of an ApiError for a request that got no answer at all (a network failure). */
export const UNREACHABLE = "unreachable";

/**
 * The statuses a proxy in front of the API answers when the API is down
 * or restarting: Vite's dev proxy, or the reverse proxy in production.
 */
const PROXY_FAILURES = new Set([502, 503, 504]);

/** Whether the API could not be reached: no answer at all, or a proxy's failure. */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.code === UNREACHABLE || PROXY_FAILURES.has(error.status))
  );
}

/** Narrows a response body, or throws when the API answered something unexpected. */
export function expectShape<T>(value: unknown, isShape: (value: unknown) => value is T): T {
  if (!isShape(value)) {
    throw new ApiError(0, "The API sent an unexpected response.");
  }
  return value;
}

/**
 * Calls the API on this origin. The session cookie goes along automatically,
 * and the browser adds the Origin header the API checks on changes.
 * Throws ApiError for anything but a 2xx response. The body comes back
 * unchecked; callers narrow it with expectShape.
 */
export async function apiRequest(
  path: string,
  {
    method = "GET",
    body,
    raw,
    signal,
  }: {
    method?: string;
    body?: unknown;
    /** Bytes sent as they are, with their type (an avatar's PNG), in place of `body`. */
    raw?: { data: Blob; type: string };
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(raw !== undefined
          ? { "content-type": raw.type }
          : body === undefined
            ? {}
            : { "content-type": "application/json" }),
      },
      ...(raw !== undefined
        ? { body: raw.data }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new ApiError(
      0,
      "Could not reach the API. Check that it is running, then try again.",
      UNREACHABLE,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = typeof payload === "object" && payload !== null ? payload : {};
    const message =
      "message" in record && typeof record.message === "string"
        ? record.message
        : `The request failed (HTTP ${response.status}).`;
    const code = "error" in record && typeof record.error === "string" ? record.error : undefined;
    throw new ApiError(response.status, message, code);
  }
  return payload;
}
