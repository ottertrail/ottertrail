import type { ErrorDetails } from "./errors.ts";
import {
  byteLength,
  cleanText,
  type Properties,
  sanitizeName,
  sanitizeProperties,
} from "./sanitize.ts";
import type { TraceRef } from "./traces.ts";
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
  /** The server's trace of the page load, on its pageview, errors, and Web Vitals (traces.ts). */
  traceId?: string;
  spanId?: string;
}

/** Room for one event in a request: the budget less the batch's own fields, release included. */
const MAX_EVENT_BYTES = MAX_BATCH_BYTES - 2_000;

/**
 * Cuts an error's stack, then its message, until its event fits in one
 * request. Their limits count characters, and a character can take up to
 * four bytes: a long stack in another script would otherwise pass the API's
 * 64 KB and lose the error. Cutting `over` characters removes at least
 * `over` bytes, so this takes a pass or two.
 */
function fitError(event: QueuedEvent): void {
  const { error } = event;
  if (error === undefined) return;
  for (const field of ["stack", "message"] as const) {
    let over = byteLength(JSON.stringify(event)) - MAX_EVENT_BYTES;
    while (over > 0 && (error[field] ?? "") !== "") {
      const text = error[field] ?? "";
      error[field] = cleanText(text, Math.max(0, text.length - over), true);
      over = byteLength(JSON.stringify(event)) - MAX_EVENT_BYTES;
    }
  }
  if (error.stack === "") delete error.stack;
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
  release?: string;
  /**
   * Start paused: events are queued as usual, but nothing leaves until
   * resume(); discard() drops them and keeps it so (the heatmap overlay).
   */
  paused?: boolean;
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
   * report. `extra.error` goes with an "error" event, `extra.trace` with
   * the page load's events. `extra.now` sends
   * at once instead of after FLUSH_DELAY_MS, as for a site's own event,
   * which often comes just before the visitor leaves the page (a click on
   * a link). Never throws.
   */
  track(
    name: unknown,
    page: Page,
    properties?: unknown,
    extra?: {
      user?: SignedUser | undefined;
      error?: ErrorDetails;
      trace?: TraceRef | undefined;
      now?: boolean;
    },
  ): void;
  /** Sends one batch now unless a send is in flight. Never rejects. */
  flush(): Promise<void>;
  /** The page is being hidden or closed: hand every queued event to the browser. */
  flushOnExit(): void;
  /** Number of queued events, for tests and debugging. */
  queued(): number;
  /** Sends what was queued while paused, and from now on as usual. */
  resume(): void;
  /** Drops what was queued while paused; nothing is sent for the rest of the page load. */
  discard(): void;
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
  paused = false,
}: TrackerOptions): Tracker {
  let queue: QueuedEvent[] = [];
  /** Nothing leaves while paused; nothing is even kept once muted. */
  let muted = false;
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
    if (paused || sending || queue.length === 0) {
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
        if (muted || cleanName === "" || page.url === "") {
          return;
        }
        const cleanProperties = sanitizeProperties(properties);
        const owner = extra !== undefined && "user" in extra ? extra.user : user;
        if (queue.length >= MAX_QUEUE) {
          // Bounded memory: drop the oldest event; while paused, the newest,
          // so the page load's first events, its pageview, are kept.
          if (paused) return;
          queue.shift();
        }
        const event: QueuedEvent = {
          id: randomId(),
          name: cleanName,
          occurredAt: Date.now(),
          url: page.url,
          ...(page.referrer === undefined ? {} : { referrer: page.referrer }),
          ...(cleanProperties === undefined ? {} : { properties: cleanProperties }),
          ...(owner === undefined ? {} : { userId: owner.userId }),
          ...(owner?.signature === undefined ? {} : { userSignature: owner.signature }),
          ...(extra?.error === undefined ? {} : { error: { ...extra.error } }),
          ...(extra?.trace === undefined
            ? {}
            : { traceId: extra.trace.traceId, spanId: extra.trace.spanId }),
        };
        fitError(event);
        queue.push(event);
        // flush() starts its request before it returns, so an event sent now is on its way
        // before a click's navigation begins. While a send is in flight, the event goes next.
        if (
          (extra?.now === true || queue.length >= MAX_EVENTS_PER_BATCH) &&
          Date.now() >= retryAt
        ) {
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
      if (paused) return;
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

    resume() {
      paused = false;
      // At once, not at the end of a batch's wait begun while paused.
      cancelTimer();
      if (queue.length > 0) schedule(0);
    },

    discard() {
      muted = true;
      queue = [];
      cancelTimer();
    },

    setUser(next) {
      user = next;
    },
  };
}
