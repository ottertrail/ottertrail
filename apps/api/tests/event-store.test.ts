import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import { countEvents } from "./helpers/events.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";

let testClickHouse: TestClickHouse | undefined;

beforeAll(async () => {
  testClickHouse = await createTestClickHouse();
});

afterAll(async () => {
  await testClickHouse?.destroy();
});

function clickhouse() {
  if (testClickHouse === undefined) throw new Error("The test ClickHouse was not created");
  return testClickHouse.client;
}

function pageview(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date("2026-11-16T09:14:03.000Z"),
    path: "/lessons/closures",
    ...overrides,
  };
}

/** A project's rows as ClickHouse holds them, every one, merged or not. */
async function rows(projectId: string) {
  const result = await clickhouse().query({
    query: "SELECT * FROM events WHERE project_id = {project:UUID} ORDER BY occurred_at, event_id",
    query_params: { project: projectId },
    format: "JSONEachRow",
  });
  return result.json<Record<string, unknown>>();
}

describe("storeEvents", () => {
  test("keeps one row per project, day, and event ID, whatever the time within the day", async () => {
    const projectId = randomUUID();
    const eventId = randomUUID();
    const at = (time: string) => pageview({ eventId, occurredAt: new Date(time) });
    // A retry whose corrected time came out 4 seconds later: the same row.
    await storeEvents(clickhouse(), projectId, [at("2026-11-16T12:00:00.000Z")]);
    await storeEvents(clickhouse(), projectId, [at("2026-11-16T12:00:04.000Z")]);
    expect(await countEvents(clickhouse(), projectId)).toBe(1);

    // Either side of midnight UTC: two rows, the one case a retry still counts twice.
    const late = randomUUID();
    await storeEvents(clickhouse(), projectId, [
      pageview({ eventId: late, occurredAt: new Date("2026-11-16T23:59:59.900Z") }),
    ]);
    await storeEvents(clickhouse(), projectId, [
      pageview({ eventId: late, occurredAt: new Date("2026-11-17T00:00:00.100Z") }),
    ]);
    expect(await countEvents(clickhouse(), projectId)).toBe(3);
  });

  test("stores every column, with both timestamps", async () => {
    const projectId = randomUUID();
    const event = pageview({
      occurredAt: new Date("2026-11-16T12:00:00.123Z"),
      path: "/pricing",
      referrer: "https://news.ycombinator.com/",
      utm: {
        source: "newsletter",
        medium: "email",
        campaign: "launch",
        term: "otters",
        content: "a",
      },
      properties: { plan: "free", seats: 3 },
      client: { browser: "Firefox", browserVersion: "142", os: "Linux", deviceType: "desktop" },
      location: { country: "DE", region: "Bavaria", city: "Munich" },
      visitorId: "-4611686018427387904",
      environment: "staging",
      release: "1.4.2",
      userId: "user-42",
    });

    await storeEvents(clickhouse(), projectId, [event], {
      receivedAt: new Date("2026-11-16T12:00:01.500Z"),
    });

    expect(await rows(projectId)).toEqual([
      {
        project_id: projectId,
        event_id: event.eventId,
        name: "pageview",
        occurred_at: "2026-11-16 12:00:00.123",
        received_at: "2026-11-16 12:00:01.500",
        path: "/pricing",
        referrer: "https://news.ycombinator.com/",
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
        utm_term: "otters",
        utm_content: "a",
        properties: '{"plan":"free","seats":3}',
        browser: "Firefox",
        browser_version: "142",
        os: "Linux",
        device_type: "desktop",
        country: "DE",
        region: "Bavaria",
        city: "Munich",
        visitor_id: "-4611686018427387904",
        environment: "staging",
        release: "1.4.2",
        user_id: "user-42",
        // Only an error has these.
        error_type: "",
        error_message: "",
        error_stack: "",
        error_handled: false,
        error_fingerprint: "",
        replay_id: null,
        error_requests: [],
        // A server's exception has these, and a page load's events the last two.
        service: "",
        trace_id: "",
        span_id: "",
      },
    ]);
  });

  test("stores what was left out as none: no page, production, no visitor", async () => {
    const projectId = randomUUID();
    await storeEvents(clickhouse(), projectId, [
      pageview({ name: "invoice_paid", path: undefined }),
    ]);
    expect(await rows(projectId)).toMatchObject([
      {
        path: "",
        referrer: null,
        properties: "{}",
        visitor_id: null,
        environment: "production",
        release: null,
        user_id: null,
      },
    ]);
  });

  test("stores an error's details, and an error without a stack", async () => {
    const projectId = randomUUID();
    const replayId = randomUUID();
    const withStack = pageview({
      name: "error",
      occurredAt: new Date("2026-11-16T12:00:00.000Z"),
      error: {
        type: "TypeError",
        message: "x is undefined",
        stack: "TypeError: x is undefined\n    at f (https://a.example/app.js:1:2)",
        handled: false,
        fingerprint: "1-0123456789abcdef0123",
        replayId,
      },
    });
    const withoutStack = pageview({
      name: "error",
      occurredAt: new Date("2026-11-16T12:00:01.000Z"),
      error: {
        type: "Error",
        message: "Declined",
        handled: true,
        fingerprint: "1-abcdefabcdefabcdefab",
      },
    });
    await storeEvents(clickhouse(), projectId, [withStack, withoutStack]);

    expect(await rows(projectId)).toMatchObject([
      {
        name: "error",
        error_type: "TypeError",
        error_message: "x is undefined",
        error_stack: "TypeError: x is undefined\n    at f (https://a.example/app.js:1:2)",
        error_handled: false,
        error_fingerprint: "1-0123456789abcdef0123",
        replay_id: replayId,
      },
      { error_type: "Error", error_stack: "", error_handled: true, replay_id: null },
    ]);
  });

  test("counts a retried event once: it is the same row", async () => {
    const projectId = randomUUID();
    const event = pageview();

    await storeEvents(clickhouse(), projectId, [event]);
    // The sender never heard back, so it sends the same event again, which
    // arrives later.
    await storeEvents(clickhouse(), projectId, [event], {
      receivedAt: new Date(Date.now() + 5000),
    });

    // Two rows until ClickHouse merges them; reads with FINAL see one.
    expect(await rows(projectId)).toHaveLength(2);
    expect(await countEvents(clickhouse(), projectId)).toBe(1);
  });

  test("counts a repeated event once within one batch", async () => {
    const projectId = randomUUID();
    const event = pageview();
    await storeEvents(clickhouse(), projectId, [event, event, pageview()]);
    expect(await countEvents(clickhouse(), projectId)).toBe(2);
  });

  test("keeps projects apart: the same event ID can exist in two projects", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const event = pageview();

    await storeEvents(clickhouse(), first, [event]);
    await storeEvents(clickhouse(), second, [event]);

    expect(await countEvents(clickhouse(), first)).toBe(1);
    expect(await countEvents(clickhouse(), second)).toBe(1);
  });

  test("saves all of a batch or none of it", async () => {
    const projectId = randomUUID();
    const broken = pageview({ visitorId: "not a number" });

    await expect(storeEvents(clickhouse(), projectId, [pageview(), broken])).rejects.toThrow(
      /Cannot parse input/,
    );

    expect(await countEvents(clickhouse(), projectId)).toBe(0);
  });

  test("does nothing for an empty batch", async () => {
    await expect(storeEvents(clickhouse(), randomUUID(), [])).resolves.toBeUndefined();
  });
});
