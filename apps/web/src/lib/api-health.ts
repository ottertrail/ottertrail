export type ApiHealth = { state: "ok" } | { state: "unreachable"; reason: string };

const HEALTH_TIMEOUT_MS = 5_000;

function isHealthBody(value: unknown): value is { status: "ok" } {
  return typeof value === "object" && value !== null && "status" in value && value.status === "ok";
}

/**
 * Calls the API liveness route. Resolves with "unreachable" for network
 * errors, timeouts, and unexpected responses. Rejects only when the caller's
 * signal aborts the request.
 */
export async function fetchApiHealth(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiHealth> {
  const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const response = await fetchImpl("/api/health", {
      headers: { accept: "application/json" },
      signal: requestSignal,
    });
    if (!response.ok) {
      return { state: "unreachable", reason: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    return isHealthBody(body)
      ? { state: "ok" }
      : { state: "unreachable", reason: "Unexpected response" };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (timeout.aborted) {
      return { state: "unreachable", reason: "Timed out" };
    }
    return {
      state: "unreachable",
      reason: error instanceof Error ? error.message : "Network error",
    };
  }
}
