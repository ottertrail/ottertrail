import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { NotificationPayload } from "../src/notifications/events.ts";
import { sendWebhook, signature, USER_AGENT } from "../src/notifications/webhook.ts";
import type { Lookup } from "../src/outbound/addresses.ts";
import { OTTERTRAIL_VERSION } from "../src/version.ts";
import { testLookup } from "./helpers/uptime-servers.ts";
import { startWebhookReceiver, type WebhookReceiver } from "./helpers/webhook-receiver.ts";

/**
 * Verifies a webhook as docs/webhooks.md shows a receiver doing it: the
 * same code, so the documented example is known to work.
 */
const TOLERANCE_SECONDS = 300;

function verifyOttertrailWebhook(
  secret: string,
  headers: IncomingHttpHeaders,
  rawBody: string,
  now = Date.now(),
): boolean {
  const timestamp = headers["ottertrail-timestamp"];
  const header = headers["ottertrail-signature"];
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) return false;
  if (typeof header !== "string" || !header.startsWith("v1=")) return false;
  // Refuse a request sent long ago: a replay of one that was overheard.
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(header.slice(3), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A secret like the server's, made at run time so no scanner mistakes it for a real one. */
const SECRET = Buffer.from("a webhook secret only these tests use!").toString("base64url");

let receiver: WebhookReceiver;

beforeAll(async () => {
  receiver = await startWebhookReceiver();
});

afterAll(async () => {
  await receiver?.close();
});

beforeEach(() => {
  receiver.requests.length = 0;
  receiver.answer.status = 200;
  receiver.answer.location = undefined;
});

const payload: NotificationPayload = {
  version: 1,
  id: "6b1f3c1e-6f0c-4b65-8f15-0a5a7b0a4b10",
  type: "check.down",
  time: "2026-11-18T06:30:00.000Z",
  project: { id: "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e", name: "Shop" },
  subject: { type: "check", id: "c0ffee00-0000-4000-8000-000000000001", name: "API health" },
  message: "API health is down: it answered 503.",
  url: "https://ottertrail.example.com/projects/0d6e5f80/uptime/c0ffee00",
};

/** The receiver's address, by a host name the test resolver sends to 127.0.0.1. */
const hookUrl = (path = "/hook") => `http://hooks.test:${receiver.port}${path}`;

function send(
  path = "/hook",
  more: { lookup?: Lookup; allowPrivate?: boolean; timeoutMs?: number; now?: () => Date } = {},
) {
  return sendWebhook({ url: hookUrl(path), secret: SECRET, deliveryId: "delivery-1" }, payload, {
    // The receiver is on loopback.
    policy: { allowPrivate: more.allowPrivate ?? true },
    lookup: more.lookup ?? testLookup({ "hooks.test": ["127.0.0.1"] }),
    ...(more.timeoutMs === undefined ? {} : { timeoutMs: more.timeoutMs }),
    ...(more.now === undefined ? {} : { now: more.now }),
  });
}

describe("a webhook's request", () => {
  test("is a JSON POST with Ottertrail's headers and the body, version 1", async () => {
    const at = new Date("2026-11-18T06:30:05.000Z");
    expect(await send("/hook", { now: () => at })).toEqual({ ok: true, status: 200 });
    expect(receiver.requests).toHaveLength(1);
    const [request] = receiver.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/hook");
    expect(request?.headers).toMatchObject({
      host: `hooks.test:${receiver.port}`,
      "content-type": "application/json",
      "user-agent": `Ottertrail/${OTTERTRAIL_VERSION} (webhooks)`,
      "ottertrail-event": "check.down",
      "ottertrail-delivery": "delivery-1",
      "ottertrail-timestamp": "1794983405",
    });
    expect(USER_AGENT).toContain("Ottertrail/");
    expect(JSON.parse(request?.body ?? "")).toEqual(payload);
    // The keys in the documented order.
    expect(Object.keys(JSON.parse(request?.body ?? "{}"))).toEqual([
      "version",
      "id",
      "type",
      "time",
      "project",
      "subject",
      "message",
      "url",
    ]);
  });

  test("is signed so the documented check accepts it, and refuses anything changed", async () => {
    await send();
    const [request] = receiver.requests;
    if (request === undefined) throw new Error("no request");
    expect(request.headers["ottertrail-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(request.headers["ottertrail-signature"]).toBe(
      `v1=${signature(SECRET, Number(request.headers["ottertrail-timestamp"]), request.body)}`,
    );
    expect(verifyOttertrailWebhook(SECRET, request.headers, request.body)).toBe(true);

    // Another secret, another body, another time, or a replay much later: refused.
    expect(verifyOttertrailWebhook(`${SECRET}x`, request.headers, request.body)).toBe(false);
    expect(
      verifyOttertrailWebhook(SECRET, request.headers, request.body.replace("503", "200")),
    ).toBe(false);
    expect(
      verifyOttertrailWebhook(
        SECRET,
        {
          ...request.headers,
          "ottertrail-timestamp": String(Number(request.headers["ottertrail-timestamp"]) + 1),
        },
        request.body,
      ),
    ).toBe(false);
    expect(
      verifyOttertrailWebhook(SECRET, request.headers, request.body, Date.now() + 10 * 60 * 1000),
    ).toBe(false);
    expect(
      verifyOttertrailWebhook(
        SECRET,
        { ...request.headers, "ottertrail-signature": "v1=00" },
        request.body,
      ),
    ).toBe(false);
  });

  test("counts any 2xx as delivered", async () => {
    for (const status of [200, 201, 202, 204, 299]) {
      receiver.answer.status = status;
      expect(await send()).toEqual({ ok: true, status });
    }
  });

  test("does not follow a redirect", async () => {
    receiver.answer.status = 302;
    receiver.answer.location = "/elsewhere";
    expect(await send()).toEqual({
      ok: false,
      status: 302,
      error: "It answered 302, a redirect, which webhooks do not follow: use the final URL.",
    });
    expect(receiver.requests.map((request) => request.path)).toEqual(["/hook"]);
  });

  test("fails on 4xx and 5xx, saying what it answered", async () => {
    for (const status of [400, 401, 404, 410, 500, 503]) {
      receiver.answer.status = status;
      expect(await send()).toEqual({
        ok: false,
        status,
        error: `It answered ${status}; a webhook must answer 2xx.`,
      });
    }
  });

  test("times out", async () => {
    const started = Date.now();
    expect(await send("/slow", { timeoutMs: 300 })).toEqual({
      ok: false,
      error: "No answer within 0.3 seconds.",
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("refuses an address the rules refuse, before any request, and says which for the log", async () => {
    expect(await send("/hook", { allowPrivate: false })).toEqual({
      ok: false,
      error: "hooks.test resolves to an address webhooks may not reach.",
      refused: { host: "hooks.test", address: "127.0.0.1", kind: "loopback" },
    });
    const metadata = testLookup({ "hooks.test": ["169.254.169.254"] });
    expect(await send("/hook", { lookup: metadata })).toMatchObject({
      ok: false,
      refused: { kind: "metadata" },
    });
    expect(receiver.requests).toEqual([]);
  });

  test("connects to the address it checked, resolving once", async () => {
    let calls = 0;
    const rebinding: Lookup = async () => {
      calls += 1;
      return [{ address: calls === 1 ? "127.0.0.1" : "198.51.100.1", family: 4 }];
    };
    expect(await send("/hook", { lookup: rebinding })).toEqual({ ok: true, status: 200 });
    expect(calls).toBe(1);
  });

  test("fails when the host does not resolve or nothing listens", async () => {
    expect(await send("/hook", { lookup: testLookup() })).toEqual({
      ok: false,
      error: "The host could not be resolved (ENOTFOUND).",
    });
    const closed = await startWebhookReceiver();
    await closed.close();
    expect(
      await sendWebhook(
        { url: `http://hooks.test:${closed.port}/hook`, secret: SECRET, deliveryId: randomUUID() },
        payload,
        { policy: { allowPrivate: true }, lookup: testLookup({ "hooks.test": ["127.0.0.1"] }) },
      ),
    ).toEqual({ ok: false, error: "The connection was refused." });
  });
});
