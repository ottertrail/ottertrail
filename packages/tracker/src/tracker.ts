import type { ErrorDetails } from "./errors.ts";
import { byteLength, type Properties, sanitizeName, sanitizeProperties } from "./sanitize.ts";
import type { SendOutcome, Transport } from "./transport.ts";

/** Matches the API: at most 50 events per batch. */
export const MAX_EVENTS_PER_BATCH = 50;
/**
 * Largest request body, in bytes, including the JSON envelope ({"v":1,
 * "key":…,"sentAt":…,"events":[…]}). The API accepts 64 KiB; the rest is
 * a safety margin. A single event larger than this is still sent on its own.
 */
export const MAX_BATCH_BYTES = 60_000;
/** Events kept while the API cannot be reached; the oldest go first. */
export const MAX_QUEUE = 200;
/** How long new events wait so they can share one request. */
export const FLUSH_DELAY_MS = 1000;
/** Failed sends of the same batch before it is given up. */
export const MAX_ATTEMPTS = 8;
export const MAX_BACKOFF_MS = 60_000;

export interface Page {
  /** Cleaned page URL (see cleanPageUrl). "" when the URL is too long: events on it are dropped. */
  url: string;
  referrer?: string;
}

export interface QueuedEvent {
  id: string;
  name: string;
  occurredAt: number;
  url: string;
  referrer?: string;
  properties?: Properties;
  /** The site's ID for the signed-in user, when the site named one. */
  userId?: string;
  /** The site server's signature for userId, when the site gave one. */
  userSignature?: string;
  /** For an "error" event: what went wrong. */
  error?: ErrorDetails;
}

export interface TrackerOptions {
  key: string;
  transport: Transport;
  randomId: () => string;
  /**
   * The device has a touchscreen. Sent with each batch only when true: an
   * iPad presents itself as a Mac, and Macs have no touchscreen, so this
   * tells the API which "Macs" are iPads.
   */
  touch?: boolean;
  /** Where the site runs, such as "staging"; the API counts events as "production" without it. */
  environment?: string;
  /** The site's version, such as "1.4.2". */
  release?: string;
}

/** A signed-in user: the site's ID, and its server's signature for it when it gave one. */
export interface SignedUser {
  userId: string;
  signature?: string | undefined;
}

export interface Tracker {
  /**
   * Queues an event, with the signed-in user (setUser), or `extra.user`
   * when given: the user when the page was viewed, for its engagement
   * report. `extra.error` goes with an "error" event. Never throws.
   */
  track(
    name: unknown,
    page: Page,
    properties?: unknown,
    extra?: { user?: SignedUser | undefined; error?: ErrorDetails },
  ): void;
  /** Sends one batch now unless a send is in flight. Never rejects. */
  flush(): Promise<void>;
  /** The page is being hidden or closed: hand every queued event to the browser. */
  flushOnExit(): void;
  /** Number of queued events, for tests and debugging. */
  queued(): number;
  /**
   * The signed-in user, already checked (cleanUserId, cleanSignature), whom
   * events tracked from now on belong to; undefined for an anonymous
   * visitor. Kept in memory only: nothing is stored on the device.
   */
  setUser(user: SignedUser | undefined): void;
}

/** Exponential backoff with ±20% jitter: about 1, 2, 4, 8 … seconds, capped at 60. */
export function backoffMs(failures: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function createTracker({
  key,
  transport,
  randomId,
  touch = false,
  environment,
  release,
}: TrackerOptions): Tracker {
  let queue: QueuedEvent[] = [];
  let user: SignedUser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  /** Consecutive failed sends of the batch at the front of the queue. */
  let failures = 0;
  /**
   * After a failed send, nothing is sent before this time (Date.now()), so
   * events tracked meanwhile cannot cut the server's backoff short.
   */
  let retryAt = 0;

  /** Sends after delayMs, or once the retry wait is over if that is later. */
  function schedule(delayMs: number) {
    timer ??= setTimeout(
      () => {
        timer = undefined;
        void flush();
      },
      Math.max(delayMs, retryAt - Date.now()),
    );
  }

  function cancelTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /** The oldest events that fit in one request: 50 events and MAX_BATCH_BYTES at most. */
  function nextBatch(): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    let bytes = byteLength(requestBody([]));
    for (const event of queue) {
      // Every event after the first also needs a comma.
      const size = byteLength(JSON.stringify(event)) + (batch.length > 0 ? 1 : 0);
      if (
        batch.length === MAX_EVENTS_PER_BATCH ||
        (batch.length > 0 && bytes + size > MAX_BATCH_BYTES)
      ) {
        break;
      }
      batch.push(event);
      bytes += size;
    }
    return batch;
  }

  /** sentAt is read at each attempt, so the API's clock correction stays right on retries. */
  function requestBody(events: QueuedEvent[]): string {
    return JSON.stringify({
      v: 1,
      key,
      sentAt: Date.now(),
      ...(touch ? { touch } : {}),
      ...(environment === undefined ? {} : { environment }),
      ...(release === undefined ? {} : { release }),
      events,
    });
  }

  function remove(events: QueuedEvent[]) {
    const ids = new Set(events.map((event) => event.id));
    queue = queue.filter((event) => !ids.has(event.id));
  }

  async function flush(): Promise<void> {
    if (sending || queue.length === 0) {
      return;
    }
    cancelTimer();
    const batch = nextBatch();
    sending = true;
    let outcome: SendOutcome;
    try {
      outcome = await transport.send(requestBody(batch));
    } catch {
      outcome = { type: "retry" };
    }
    sending = false;

    if (outcome.type === "retry") {
      failures += 1;
      if (failures < MAX_ATTEMPTS) {
        // The same events, with the same IDs, go again later: the API stores
        // each ID once, so a retry can never count an event twice.
        const waitMs = outcome.retryAfterMs ?? backoffMs(failures);
        retryAt = Date.now() + waitMs;
        // A batching timer set while the send was in flight must not win.
        cancelTimer();
        schedule(waitMs);
        return;
      }
    }
    // Stored, rejected for good, or out of attempts: these events are done.
    failures = 0;
    remove(batch);
    if (queue.length > 0) {
      schedule(0);
    }
  }

  return {
    track(name, page, properties, extra) {
      try {
        const cleanName = sanitizeName(name);
        if (cleanName === "" || page.url === "") {
          return;
        }
        const cleanProperties = sanitizeProperties(properties);
        const owner = extra !== undefined && "user" in extra ? extra.user : user;
        if (queue.length >= MAX_QUEUE) {
          queue.shift(); // Bounded memory: drop the oldest event.
        }
        queue.push({
          id: randomId(),
          name: cleanName,
          occurredAt: Date.now(),
          url: page.url,
          ...(page.referrer === undefined ? {} : { referrer: page.referrer }),
          ...(cleanProperties === undefined ? {} : { properties: cleanProperties }),
          ...(owner === undefined ? {} : { userId: owner.userId }),
          ...(owner?.signature === undefined ? {} : { userSignature: owner.signature }),
          ...(extra?.error === undefined ? {} : { error: extra.error }),
        });
        if (queue.length >= MAX_EVENTS_PER_BATCH && Date.now() >= retryAt) {
          void flush();
        } else {
          schedule(FLUSH_DELAY_MS);
        }
      } catch {
        // Never break the page the tracker runs on.
      }
    },

    flush,

    flushOnExit() {
      try {
        cancelTimer();
        while (queue.length > 0) {
          const batch = nextBatch();
          const body = requestBody(batch);
          // If the browser refuses the beacon, a keepalive fetch may still finish.
          if (!transport.beacon(body)) {
            void transport.send(body);
          }
          remove(batch);
        }
        failures = 0;
      } catch {
        // Never break the page the tracker runs on.
      }
    },

    queued: () => queue.length,

    setUser(next) {
      user = next;
    },
  };
}
