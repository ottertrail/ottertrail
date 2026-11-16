/**
 * What happened to a batch:
 * - sent: stored (202).
 * - drop: rejected for good (400, 403, 413, 415); sending it again would fail again.
 * - retry: worth sending again later (429, 5xx, or no response at all).
 */
export type SendOutcome =
  | { type: "sent" }
  | { type: "drop" }
  | { type: "retry"; retryAfterMs?: number };

export interface Transport {
  /** Sends a batch and reports what happened. Never rejects. */
  send: (body: string) => Promise<SendOutcome>;
  /**
   * Hands a batch to the browser to deliver even if the page is closing.
   * Returns false if the browser refused it. There is no way to see the
   * response, so the outcome is unknown.
   */
  beacon: (body: string) => boolean;
}

/** Retry-After as milliseconds, when the server sent a number of seconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return undefined;
  }
  return Number(header.trim()) * 1000;
}

export function outcomeForStatus(status: number, retryAfter: string | null): SendOutcome {
  if (status >= 200 && status < 300) {
    return { type: "sent" };
  }
  if (status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    return retryAfterMs === undefined ? { type: "retry" } : { type: "retry", retryAfterMs };
  }
  return { type: "drop" };
}

/**
 * Sends batches with fetch and sendBeacon as text/plain, a "simple"
 * cross-site request that needs no preflight. `keepalive` lets a fetch
 * finish even if the page closes while it is in flight. No cookies are sent.
 */
export function browserTransport(endpoint: string): Transport {
  return {
    async send(body) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          body,
          headers: { "content-type": "text/plain" },
          keepalive: true,
          credentials: "omit",
        });
        return outcomeForStatus(response.status, response.headers.get("retry-after"));
      } catch {
        // Offline, DNS failure, server down, or a response the browser hid.
        return { type: "retry" };
      }
    },
    beacon(body) {
      try {
        return navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }));
      } catch {
        return false;
      }
    },
  };
}
