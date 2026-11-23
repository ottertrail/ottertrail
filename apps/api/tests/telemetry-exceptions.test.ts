import { describe, expect, test } from "vite-plus/test";

import { fingerprint } from "../src/errors/fingerprint.ts";
import {
  exceptionEventId,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_ERROR_STACK_CHARS,
  MAX_EXCEPTIONS_PER_SPAN,
} from "../src/telemetry/exceptions.ts";
import { normalizeLogs, normalizeTraces } from "../src/telemetry/normalize.ts";
import { keyValues } from "./helpers/telemetry.ts";

const PROJECT = "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11";
const OTHER_PROJECT = "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e";
/** 18 November 2026, 12:00 UTC. */
const NOW = 1_795_003_200_000_000_000n;
const SECOND = 1_000_000_000n;
const context = { projectId: PROJECT, receivedAtNs: NOW, retentionDays: 30 };
const msOf = (ns: bigint) => new Date(Number(ns / 1_000_000n));

const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const SPAN_ID = "eee19b7ec3c1b174";
const START = NOW - 10n * SECOND;

const STACK = `Traceback (most recent call last):
  File "/srv/shop/payments/gateway.py", line 88, in charge
    raise CardDeclined(reason)
payments.gateway.CardDeclined: card declined`;

const RESOURCE = keyValues({
  "service.name": "payments",
  "service.version": "1.4.2",
  "deployment.environment.name": "Staging",
});

function exceptionEvent(attributes: Record<string, string>, time = START + SECOND) {
  return { name: "exception", timeUnixNano: String(time), attributes: keyValues(attributes) };
}

function span(overrides: Record<string, unknown> = {}) {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: "POST /orders/{id}/charge",
    kind: 2,
    startTimeUnixNano: String(START),
    endTimeUnixNano: String(START + 2n * SECOND),
    attributes: keyValues({ "http.route": "/orders/{id}/charge", "user.id": "ada" }),
    status: { code: 2 },
    events: [
      exceptionEvent({
        "exception.type": "payments.gateway.CardDeclined",
        "exception.message": "card declined",
        "exception.stacktrace": STACK,
      }),
    ],
    ...overrides,
  };
}

function traces(spans: object[], projectId = PROJECT) {
  return normalizeTraces(
    { resourceSpans: [{ resource: { attributes: RESOURCE }, scopeSpans: [{ spans }] }] },
    { ...context, projectId },
  );
}

function logRecord(overrides: Record<string, unknown> = {}) {
  return {
    timeUnixNano: String(START),
    severityNumber: 17,
    body: { stringValue: "charge failed" },
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    attributes: keyValues({
      "exception.type": "TimeoutError",
      "exception.message": "gateway timed out after 30s",
      "exception.stacktrace": STACK,
      "enduser.id": "grace",
    }),
    ...overrides,
  };
}

function logs(records: object[]) {
  return normalizeLogs(
    {
      resourceLogs: [{ resource: { attributes: RESOURCE }, scopeLogs: [{ logRecords: records }] }],
    },
    context,
  );
}

/** Whether a span's exception counts as handled, with this status. */
const spanHandled = (status: object | undefined) =>
  traces([span({ status })]).errors[0]?.error?.handled;

/** When a span's one exception, at `time`, is said to have happened. */
const exceptionAt = (time: bigint) =>
  traces([span({ events: [exceptionEvent({ "exception.type": "E" }, time)] })]).errors[0]
    ?.occurredAt;

/** Whether a log record's exception at this severity counts as handled. */
const logHandled = (severityNumber: number) =>
  logs([logRecord({ severityNumber })]).errors[0]?.error?.handled;

describe("exceptions on spans", () => {
  test("become error events with the span's route, user, trace, and the resource's labels", () => {
    const { errors } = traces([span()]);
    const error = {
      type: "payments.gateway.CardDeclined",
      message: "card declined",
      stack: STACK,
    };
    expect(errors).toEqual([
      {
        eventId: exceptionEventId(PROJECT, [
          "span",
          TRACE_ID,
          SPAN_ID,
          "0",
          String(START + SECOND),
          error.type,
          error.message,
        ]),
        name: "error",
        occurredAt: msOf(START + SECOND),
        path: "/orders/{id}/charge",
        properties: {},
        environment: "staging",
        release: "1.4.2",
        userId: "ada",
        error: { ...error, handled: false, fingerprint: fingerprint(error, { server: true }) },
        server: { service: "payments", traceId: TRACE_ID, spanId: SPAN_ID },
      },
    ]);
  });

  test("are handled unless the span failed", () => {
    expect(spanHandled({ code: 2 })).toBe(false);
    expect(spanHandled({ code: 1 })).toBe(true);
    expect(spanHandled({ code: 0 })).toBe(true);
    expect(spanHandled(undefined)).toBe(true);
  });

  test("take the span's start when the event has no time, or one a span could not have", () => {
    expect(exceptionAt(0n)).toEqual(msOf(START));
    expect(exceptionAt(NOW + 7200n * SECOND)).toEqual(msOf(START));
    expect(exceptionAt(START + 3n * SECOND)).toEqual(msOf(START + 3n * SECOND));
  });

  test(`at most the first ${MAX_EXCEPTIONS_PER_SPAN} of a span; other events and empty exceptions are not errors`, () => {
    const events = [
      { name: "retry", timeUnixNano: String(START) },
      exceptionEvent({ "exception.stacktrace": STACK }),
      ...Array.from({ length: 12 }, (_, i) =>
        exceptionEvent({ "exception.message": `failure ${i}` }, START + BigInt(i)),
      ),
    ];
    const { errors } = traces([span({ events })]);
    expect(errors.map((event) => event.error?.message)).toEqual(
      Array.from({ length: MAX_EXCEPTIONS_PER_SPAN }, (_, i) => `failure ${i}`),
    );
    // A message alone gives the type "Error".
    expect(errors[0]?.error?.type).toBe("Error");
  });

  test("take their time from the span alone, the same on every attempt", () => {
    const request = {
      resourceSpans: [
        {
          resource: { attributes: RESOURCE },
          scopeSpans: [
            // An hour after the span's end: not one of its times.
            {
              spans: [
                span({
                  events: [exceptionEvent({ "exception.type": "E" }, START + 3600n * SECOND)],
                }),
              ],
            },
          ],
        },
      ],
    };
    const first = normalizeTraces(request, context).errors[0];
    const retry = normalizeTraces(request, { ...context, receivedAtNs: NOW + 3000n * SECOND })
      .errors[0];
    expect(first?.occurredAt).toEqual(msOf(START));
    expect(retry?.occurredAt).toEqual(first?.occurredAt);
    expect(retry?.eventId).toBe(first?.eventId);
    // Within a minute after the span's end, its own time.
    expect(exceptionAt(START + 2n * SECOND + 30n * SECOND)).toEqual(msOf(START + 32n * SECOND));
  });

  test("two alike on one span stay two", () => {
    const alike = exceptionEvent(
      { "exception.type": "E", "exception.message": "retry failed" },
      0n,
    );
    const { errors } = traces([span({ events: [alike, alike] })]);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.eventId).not.toBe(errors[1]?.eventId);
  });

  test("only from the events a span's row keeps", () => {
    const events = [
      ...Array.from({ length: 128 }, () => ({ name: "retry", timeUnixNano: String(START) })),
      exceptionEvent({ "exception.type": "E" }),
    ];
    expect(traces([span({ events })]).errors).toEqual([]);
  });

  test("none from a refused span", () => {
    const result = traces([span({ startTimeUnixNano: String(NOW + 7200n * SECOND) })]);
    expect(result.refused).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("cut to what a browser's error may hold; no route or user leaves them out", () => {
    const [event] = traces([
      span({
        attributes: keyValues({ "user.id": "x".repeat(201) }),
        events: [
          exceptionEvent({
            "exception.type": `Bad\u0000Type${"T".repeat(300)}`,
            "exception.message": `m\r\n${"é".repeat(3000)}`,
            "exception.stacktrace": "s".repeat(20_000),
          }),
        ],
      }),
    ]).errors;
    expect(event?.error?.type).toHaveLength(200);
    expect(event?.error?.type.startsWith("BadType")).toBe(true);
    expect(event?.error?.message).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
    expect(event?.error?.message.startsWith("m\n")).toBe(true);
    expect(event?.error?.stack).toHaveLength(MAX_ERROR_STACK_CHARS);
    expect(event?.path).toBe("");
    // Over 200 characters: not a user ID a browser could send.
    expect(event).not.toHaveProperty("userId");
  });

  test("the same exception always has the same ID; another project's, another", () => {
    const [first] = traces([span()]).errors;
    const [again] = traces([span()]).errors;
    const [elsewhere] = traces([span()], OTHER_PROJECT).errors;
    expect(first?.eventId).toBe(again?.eventId);
    expect(first?.eventId).not.toBe(elsewhere?.eventId);
    expect(first?.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const [other] = traces([
      span({ events: [exceptionEvent({ "exception.message": "card declined twice" })] }),
    ]).errors;
    expect(other?.eventId).not.toBe(first?.eventId);
  });

  test("an ID never changes for the same input, so retries stay one event", () => {
    const identity = [
      "span",
      "0af7651916cd43dd8448eb211c80319c",
      "b7ad6b7169203331",
      "0",
      "1700000000000000000",
      "TypeError",
      "boom",
    ];
    expect(exceptionEventId("11111111-2222-3333-4444-555555555555", identity)).toBe(
      "60320fb8-0510-866a-812d-925d1ba6f551",
    );
    expect(exceptionEventId("p", [])).toBe("148de9c5-a7a4-8d19-a56c-d9ae1a554bf6");
  });
});

describe("exceptions in log records", () => {
  test("become error events with the record's time, trace, and user", () => {
    const { errors } = logs([logRecord()]);
    const error = { type: "TimeoutError", message: "gateway timed out after 30s", stack: STACK };
    expect(errors).toEqual([
      {
        // Made from the record as sent (the next tests check it is stable).
        eventId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        name: "error",
        occurredAt: msOf(START),
        path: "",
        properties: {},
        environment: "staging",
        release: "1.4.2",
        // The older attribute, when user.id is not there.
        userId: "grace",
        error: { ...error, handled: false, fingerprint: fingerprint(error, { server: true }) },
        server: { service: "payments", traceId: TRACE_ID, spanId: SPAN_ID },
      },
    ]);
  });

  test("are handled below the error severity, and not from it or with none", () => {
    expect(logHandled(1)).toBe(true);
    expect(logHandled(13)).toBe(true);
    expect(logHandled(16)).toBe(true);
    expect(logHandled(17)).toBe(false);
    expect(logHandled(24)).toBe(false);
    expect(logHandled(0)).toBe(false);
  });

  test("need a type or a message; a record without a trace has none", () => {
    const { errors } = logs([
      logRecord({ attributes: keyValues({ "exception.stacktrace": STACK }) }),
      logRecord({ attributes: [] }),
      logRecord({
        traceId: undefined,
        spanId: undefined,
        attributes: keyValues({ "exception.message": "lost", "http.route": "/health" }),
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      path: "/health",
      error: { type: "Error", message: "lost" },
      server: { service: "payments", traceId: "", spanId: "" },
    });
  });

  test("a record with no time has the same ID on every attempt", () => {
    const request = {
      resourceLogs: [
        {
          resource: { attributes: RESOURCE },
          scopeLogs: [
            { logRecords: [logRecord({ timeUnixNano: "0", observedTimeUnixNano: "0" })] },
          ],
        },
      ],
    };
    const first = normalizeLogs(request, context).errors[0];
    const retry = normalizeLogs(request, { ...context, receivedAtNs: NOW + 5n * SECOND }).errors[0];
    expect(first?.eventId).toBeDefined();
    expect(retry?.eventId).toBe(first?.eventId);
  });

  test("the same record always has the same ID; another project's, another", () => {
    const first = logs([logRecord()]).errors[0]?.eventId;
    expect(logs([logRecord()]).errors[0]?.eventId).toBe(first);
    const elsewhere = normalizeLogs(
      {
        resourceLogs: [
          { resource: { attributes: RESOURCE }, scopeLogs: [{ logRecords: [logRecord()] }] },
        ],
      },
      { ...context, projectId: OTHER_PROJECT },
    ).errors[0]?.eventId;
    expect(elsewhere).not.toBe(first);
  });
});
