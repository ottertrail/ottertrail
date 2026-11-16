import { byteLength, type Properties, sanitizeName, sanitizeProperties } from "./sanitize.ts";
import type { SendOutcome, Transport } from "./transport.ts";

/** Matches the API: at most 50 events per batch. */
export const MAX_EVENTS_PER_BATCH = 50;
/** The API accepts 64 KB; this leaves room for the rest of the request. */
export const MAX_BATCH_BYTES = 60_000;
/** Events kept while the API cannot be reached; the oldest go first. */
export const MAX_QUEUE = 200;
/** How long new events wait so they can share one request. */
export const FLUSH_DELAY_MS = 1000;
/** Failed sends of the same batch before it is given up. */
export const MAX_ATTEMPTS = 8;
export const MAX_BACKOFF_MS = 60_000;

export interface Page {
  /** Cleaned page URL (see cleanPageUrl). */
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
}

export interface TrackerOptions {
  key: string;
  transport: Transport;
  randomId: () => string;
}

export interface Tracker {
  /** Queues an event. Never throws. */
  track(name: unknown, page: Page, properties?: unknown): void;
  /** Sends one batch now unless a send is in flight. Never rejects. */
  flush(): Promise<void>;
  /** The page is being hidden or closed: hand every queued event to the browser. */
  flushOnExit(): void;
  /** Number of queued events, for tests and debugging. */
  queued(): number;
}

/** Exponential backoff with ±20% jitter: about 1, 2, 4, 8 … seconds, capped at 60. */
export function backoffMs(failures: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function createTracker({ key, transport, randomId }: TrackerOptions): Tracker {
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  /** Consecutive failed sends of the batch at the front of the queue. */
  let failures = 0;

  function schedule(delayMs: number) {
    timer ??= setTimeout(() => {
      timer = undefined;
      void flush();
    }, delayMs);
  }

  function cancelTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /** The oldest events that fit in one request: 50 events and 60 KB at most. */
  function nextBatch(): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    for (const event of queue) {
      const size = byteLength(JSON.stringify(event));
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
    return JSON.stringify({ v: 1, key, sentAt: Date.now(), events });
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
        schedule(outcome.retryAfterMs ?? backoffMs(failures));
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
    track(name, page, properties) {
      try {
        const cleanName = sanitizeName(name);
        if (cleanName === "") {
          return;
        }
        const cleanProperties = sanitizeProperties(properties);
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
        });
        if (queue.length >= MAX_EVENTS_PER_BATCH && failures === 0) {
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
  };
}
