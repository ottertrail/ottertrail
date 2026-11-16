import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  createTracker,
  FLUSH_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_BATCH_BYTES,
  MAX_QUEUE,
  type QueuedEvent,
} from "../src/tracker.ts";
import type { SendOutcome, Transport } from "../src/transport.ts";

interface SentBatch {
  v: number;
  key: string;
  sentAt: number;
  events: QueuedEvent[];
}

/** A transport that records every batch and answers with scripted outcomes. */
function fakeTransport(outcomes: SendOutcome[] = []) {
  const sent: SentBatch[] = [];
  const beacons: SentBatch[] = [];
  let beaconAccepted = true;
  const transport: Transport = {
    send: (body) => {
      sent.push(JSON.parse(body) as SentBatch);
      return Promise.resolve(outcomes.shift() ?? { type: "sent" });
    },
    beacon: (body) => {
      if (beaconAccepted) beacons.push(JSON.parse(body) as SentBatch);
      return beaconAccepted;
    },
  };
  return {
    transport,
    sent,
    beacons,
    refuseBeacons: () => {
      beaconAccepted = false;
    },
  };
}

const bodyBytes = (batch: SentBatch) => new TextEncoder().encode(JSON.stringify(batch)).length;

/** 15 properties of 500 characters, but the last one `pad` characters long. */
const properties = (pad: number) =>
  Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [`p${i}`, "x".repeat(i === 14 ? pad : 500)]),
  );

let nextId = 0;
const randomId = () => `id-${(nextId += 1)}`;
const page = { url: "https://example.com/pricing", referrer: "https://news.ycombinator.com/" };

/**
 * Eight large events whose request, envelope and commas included, is
 * exactly MAX_BATCH_BYTES + extra bytes long when sent together.
 */
function eightEvents(extra: number) {
  const envelope = { v: 1, key: "pk_test", sentAt: Date.now() + FLUSH_DELAY_MS };
  const event = (n: number, pad: number) => ({
    id: `id-${n}`,
    name: "big",
    occurredAt: Date.now(),
    url: page.url,
    referrer: page.referrer,
    properties: properties(pad),
  });
  const events = Array.from({ length: 8 }, (_, i) => event(i + 1, 200));
  const size = bodyBytes({ ...envelope, events });
  const lastPad = 200 + MAX_BATCH_BYTES + extra - size;
  expect(lastPad).toBeGreaterThan(0);
  expect(lastPad).toBeLessThanOrEqual(500);
  return [...events.slice(0, 7).map((e) => e.properties), properties(lastPad)];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T10:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5); // No jitter: backoff is exactly 1, 2, 4 … s.
  nextId = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("batching", () => {
  test("waits briefly so events share one request", async () => {
    const { transport, sent } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(500);
    tracker.track("signup", page, { plan: "free" });
    expect(sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      v: 1,
      key: "pk_test",
      sentAt: Date.parse("2026-11-16T10:00:01.000Z"),
      events: [
        {
          id: "id-1",
          name: "pageview",
          occurredAt: Date.parse("2026-11-16T10:00:00.000Z"),
          url: page.url,
          referrer: page.referrer,
        },
        {
          id: "id-2",
          name: "signup",
          occurredAt: Date.parse("2026-11-16T10:00:00.500Z"),
          url: page.url,
          referrer: page.referrer,
          properties: { plan: "free" },
        },
      ],
    });
    expect(tracker.queued()).toBe(0);
  });

  test("sends at once when 50 events are waiting, at most 50 per request", async () => {
    const { transport, sent } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    for (let i = 0; i < 120; i += 1) tracker.track("click", page);
    // The 50th event sends a batch right away; the rest of a backlog follows
    // immediately, without waiting the usual second.
    expect(sent.map((batch) => batch.events.length)).toEqual([50]);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.map((batch) => batch.events.length)).toEqual([50, 50, 20]);
    expect(tracker.queued()).toBe(0);
  });

  describe(`keeps each request body, JSON envelope included, within ${MAX_BATCH_BYTES} bytes`, () => {
    test("a body of exactly the budget goes in one request", async () => {
      const { transport, sent } = fakeTransport();
      const tracker = createTracker({ key: "pk_test", transport, randomId });
      for (const props of eightEvents(0)) tracker.track("big", page, props);
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(sent).toHaveLength(1);
      expect(bodyBytes(sent[0]!)).toBe(MAX_BATCH_BYTES);
    });

    test("one byte more is split in two", async () => {
      const { transport, sent } = fakeTransport();
      const tracker = createTracker({ key: "pk_test", transport, randomId });
      for (const props of eightEvents(1)) tracker.track("big", page, props);
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);

      expect(sent.map((batch) => batch.events.length)).toEqual([7, 1]);
      for (const batch of sent) expect(bodyBytes(batch)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    });
  });

  test("keeps at most 200 events, dropping the oldest", async () => {
    const { transport, sent, beacons } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });
    // Make every send fail so nothing leaves the queue.
    transport.send = () => Promise.resolve({ type: "retry" });

    for (let i = 0; i < MAX_QUEUE + 25; i += 1) tracker.track("click", page);
    expect(tracker.queued()).toBe(MAX_QUEUE);

    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    tracker.flushOnExit();
    const ids = beacons.flatMap((batch) => batch.events.map((event) => event.id));
    expect(ids).toEqual(Array.from({ length: MAX_QUEUE }, (_, i) => `id-${i + 26}`));
  });

  test('drops an event whose page URL was too long (""), and keeps the rest', async () => {
    const { transport, sent } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", { url: "" });
    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((event) => event.url)).toEqual([page.url]);
  });
});

describe("retries", () => {
  test("resends the same events, with the same IDs, after a growing delay", async () => {
    const { transport, sent } = fakeTransport([
      { type: "retry" },
      { type: "retry" },
      { type: "sent" },
    ]);
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS); // Attempt 1 fails.
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // 1 s later, attempt 2 fails.
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000); // 2 s later, attempt 3 succeeds.

    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((batch) => batch.events[0]?.id))).toEqual(new Set(["id-1"]));
    // sentAt is fresh on each attempt, so the API's clock correction stays right.
    expect(sent.map((batch) => batch.sentAt - sent[0]!.sentAt)).toEqual([0, 1000, 3000]);
    expect(tracker.queued()).toBe(0);
  });

  test("waits as long as the server's Retry-After says", async () => {
    const { transport, sent } = fakeTransport([{ type: "retry", retryAfterMs: 30_000 }]);
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  test("does not let events tracked after the failure cut the wait short", async () => {
    const { transport, sent } = fakeTransport([{ type: "retry", retryAfterMs: 10_000 }]);
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    for (let i = 0; i < 60; i += 1) tracker.track("click", page);
    await vi.advanceTimersByTimeAsync(9999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  test("keeps the wait after the tab was hidden and shown again during it", async () => {
    const { transport, sent, beacons } = fakeTransport([{ type: "retry", retryAfterMs: 30_000 }]);
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS); // Attempt 1 fails at 1 s.
    await vi.advanceTimersByTimeAsync(5000);
    tracker.flushOnExit(); // Hidden: the queue goes out by beacon, the timer is cancelled.
    expect(beacons).toHaveLength(1);
    tracker.track("click", page); // Shown again.
    await vi.advanceTimersByTimeAsync(24_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((batch) => batch.events.map((event) => event.id))).toEqual([
      ["id-1"],
      ["id-2"],
    ]);
  });

  test("does not let events tracked while the send is in flight cut the wait short", async () => {
    const { transport, sent } = fakeTransport();
    const realSend = transport.send;
    let answer: ((outcome: SendOutcome) => void) | undefined;
    transport.send = (body) => {
      void realSend(body);
      // The first response arrives only when the test says so.
      return sent.length === 1
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve({ type: "sent" });
    };
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS); // Attempt 1 is in flight.
    tracker.track("click", page); // Sets the usual one-second timer.
    await vi.advanceTimersByTimeAsync(500);
    answer?.({ type: "retry", retryAfterMs: 30_000 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((batch) => batch.events.map((event) => event.id))).toEqual([
      ["id-1"],
      ["id-1", "id-2"],
    ]);

    // Once the wait is over, events are batched as usual again.
    tracker.track("signup", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3);
    expect(tracker.queued()).toBe(0);
  });

  test(`gives a batch up after ${MAX_ATTEMPTS} failed attempts`, async () => {
    const { transport, sent } = fakeTransport(
      Array.from({ length: 20 }, () => ({ type: "retry" as const })),
    );
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(sent).toHaveLength(MAX_ATTEMPTS);
    expect(tracker.queued()).toBe(0);
  });

  test("never resends a batch the server rejected for good", async () => {
    const { transport, sent } = fakeTransport([{ type: "drop" }]);
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent).toHaveLength(1);
    expect(tracker.queued()).toBe(0);
  });

  test("treats a transport that throws as a failed attempt, never as a page error", async () => {
    const { transport, sent } = fakeTransport();
    const realSend = transport.send;
    let calls = 0;
    transport.send = (body) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return realSend(body);
    };
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("pageview", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 1000);

    expect(sent).toHaveLength(1);
    expect(tracker.queued()).toBe(0);
  });
});

describe("leaving the page", () => {
  test("hands every queued event to the browser in beacons of at most 50", () => {
    const { transport, sent, beacons } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });
    transport.send = () => Promise.resolve({ type: "retry" });
    for (let i = 0; i < 49; i += 1) tracker.track("click", page);
    tracker.track("pageview", page);
    for (let i = 0; i < 10; i += 1) tracker.track("click", page);

    tracker.flushOnExit();

    expect(beacons.map((batch) => batch.events.length)).toEqual([50, 10]);
    expect(sent).toHaveLength(0);
    expect(tracker.queued()).toBe(0);
  });

  test("falls back to a keepalive fetch when the browser refuses a beacon", () => {
    const { transport, sent, refuseBeacons } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });
    refuseBeacons();
    tracker.track("pageview", page);

    tracker.flushOnExit();

    expect(sent).toHaveLength(1);
    expect(tracker.queued()).toBe(0);
  });

  test("cancels the pending timer, so nothing is sent twice", async () => {
    const { transport, sent, beacons } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });
    tracker.track("pageview", page);

    tracker.flushOnExit();
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 5);

    expect(beacons).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });
});

describe("input from the page", () => {
  test("cleans names and properties instead of letting one bad call sink a batch", async () => {
    const { transport, sent } = fakeTransport();
    const tracker = createTracker({ key: "pk_test", transport, randomId });

    tracker.track("sign\nup", page, { plan: "free", user: { id: 1 }, tags: ["a"], fn: () => 1 });
    tracker.track("", page);
    tracker.track("\n\t", page);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events[0]).toMatchObject({ name: "signup", properties: { plan: "free" } });
  });
});
