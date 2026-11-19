import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { MAX_CHANNELS } from "../src/notifications/channels.ts";
import { TEST_SENDS_PER_MINUTE } from "../src/notifications/deliveries.ts";
import { DeliverySender } from "../src/notifications/sender.ts";
import type { Lookup } from "../src/outbound/addresses.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { startWebhookReceiver, type WebhookReceiver } from "./helpers/webhook-receiver.ts";

/**
 * The notification channel routes (docs/uptime-alerts.md, "Where alerts
 * go"): channels added, changed, and deleted, with the webhook address
 * rules on save and on send; secrets; test sends and their limit; and a
 * channel's deliveries, page by page.
 */

/** What each host resolves to; a test changes it, as DNS can change. */
const dns: Record<string, string[]> = {};
const lookup: Lookup = async (hostname) => {
  const found = dns[hostname];
  if (found === undefined) {
    throw Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  }
  return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
};

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let receiver: WebhookReceiver;

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: object,
  headers: Record<string, string> = { cookie: dashboard.cookie, origin: PUBLIC_URL },
) {
  return dashboard.app.inject({
    method,
    url: `/api${path}`,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({
    // The rules as a hosted instance has them: private addresses refused.
    uptime: { allowPrivateAddresses: false, denyAddresses: ["203.0.114.7"], lookup },
    notifications: { emailConfigured: false },
  });
  receiver = await startWebhookReceiver();
});

afterAll(async () => {
  await receiver?.close();
  await dashboard?.close();
});

beforeEach(async () => {
  await dashboard.db.deleteFrom("notification_channels").execute();
  for (const key of Object.keys(dns)) delete dns[key];
  Object.assign(dns, {
    "hooks.example": ["93.184.215.14"],
    "internal.example": ["10.0.0.7"],
    "mixed.example": ["93.184.215.14", "fd00::7"],
    "own.example": ["203.0.114.7"],
  });
  receiver.requests.length = 0;
});

describe("channels", () => {
  test("every route needs a signed-in user", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, path] of [
      ["GET", "/channels"],
      ["POST", "/channels"],
      ["GET", `/channels/${id}`],
      ["PATCH", `/channels/${id}`],
      ["DELETE", `/channels/${id}`],
      ["GET", `/channels/${id}/secret`],
      ["POST", `/channels/${id}/secret`],
      ["POST", `/channels/${id}/test`],
      ["GET", `/channels/${id}/deliveries`],
    ] as const) {
      const response = await call(
        method,
        path,
        method === "POST" || method === "PATCH" ? { kind: "email", name: "x" } : undefined,
        { origin: PUBLIC_URL },
      );
      expect({
        route: `${method} ${path}`,
        status: response.statusCode,
        body: response.json(),
      }).toEqual({
        route: `${method} ${path}`,
        status: 401,
        body: { error: "unauthorized", message: "Sign in to continue." },
      });
    }
  });

  test("changes need the dashboard's origin", async () => {
    const response = await call(
      "POST",
      "/channels",
      { kind: "email", addresses: ["ops@example.com"] },
      { cookie: dashboard.cookie, origin: "https://elsewhere.example" },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
  });

  test("adds, reads, changes, and deletes an email channel", async () => {
    const created = await call("POST", "/channels", {
      kind: "email",
      name: " On call ",
      addresses: [" ops@example.com", "dev@example.com", "OPS@example.com", ""],
    });
    expect(created.statusCode).toBe(201);
    const { channel } = created.json();
    expect(channel).toMatchObject({
      name: "On call",
      kind: "email",
      addresses: ["ops@example.com", "dev@example.com"],
      url: null,
      hasSecret: false,
    });

    expect((await call("GET", `/channels/${channel.id}`)).json()).toEqual({ channel });
    const list = (await call("GET", "/channels")).json();
    expect(list).toEqual({
      maxChannels: MAX_CHANNELS,
      email: { configured: false },
      channels: [channel],
    });

    const changed = await call("PATCH", `/channels/${channel.id}`, {
      addresses: ["sre@example.com"],
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().channel).toMatchObject({
      name: "On call",
      addresses: ["sre@example.com"],
    });

    expect((await call("DELETE", `/channels/${channel.id}`)).statusCode).toBe(204);
    expect((await call("GET", `/channels/${channel.id}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/channels/${channel.id}`)).json()).toEqual({
      error: "channel_not_found",
      message: "This instance has no notification channel with this ID.",
    });
  });

  test("admins manage channels too; members cannot see them", async () => {
    const erin = await signedInUser(dashboard, {
      name: "Erin",
      email: "erin@example.com",
      grants: { projects: "all", areas: { uptime_alerts: "manage" } },
    });
    for (const [method, path] of [
      ["GET", "/channels"],
      ["POST", "/channels"],
    ] as const) {
      const refused = await call(
        method,
        path,
        method === "POST" ? { kind: "email", addresses: ["e@example.com"] } : undefined,
        { cookie: erin.cookie, origin: PUBLIC_URL },
      );
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({
        error: "forbidden",
        message: "You don't have access to this.",
      });
    }

    const carol = await signedInUser(dashboard, {
      name: "Carol",
      email: "carol@example.com",
      role: "admin",
    });
    const headers = { cookie: carol.cookie, origin: PUBLIC_URL };
    const created = await call(
      "POST",
      "/channels",
      { kind: "email", addresses: ["c@example.com"] },
      headers,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().channel.name).toBe("c@example.com");
    expect(
      (await call("DELETE", `/channels/${created.json().channel.id}`, undefined, headers))
        .statusCode,
    ).toBe(204);
  });

  test.each([
    [{ kind: "email" }, "invalid_address", "Enter the addresses to send to."],
    [
      { kind: "email", addresses: [] },
      "invalid_address",
      "An email channel has 1 to 20 addresses.",
    ],
    [
      { kind: "email", addresses: ["  "] },
      "invalid_address",
      "An email channel has 1 to 20 addresses.",
    ],
    [
      {
        kind: "email",
        addresses: Array.from({ length: 21 }, (_, index) => `a${index}@example.com`),
      },
      "invalid_address",
      "An email channel has 1 to 20 addresses.",
    ],
    [
      { kind: "email", addresses: ["ops!alerts@example.com"] },
      "invalid_address",
      `"ops!alerts@example.com" is not a supported email address. Use letters, digits, and . _ ' + - before the @. Use a domain such as example.com.`,
    ],
    [
      { kind: "email", addresses: ["a@example.com"], url: "https://x.example" },
      "invalid_url",
      "An email channel has no URL.",
    ],
    [{ kind: "webhook" }, "invalid_url", "Enter the URL to send to."],
    [
      { kind: "webhook", url: "hooks.example/x" },
      "invalid_url",
      "Enter a full URL, such as https://example.com/hooks/ottertrail.",
    ],
    [
      { kind: "webhook", url: "ftp://hooks.example/x" },
      "invalid_url",
      "A webhook's URL starts with http:// or https://.",
    ],
    [
      { kind: "webhook", url: "https://user:pass@hooks.example/x" },
      "invalid_url",
      "A webhook's URL must not contain a user name or password. They would be stored as plain text.",
    ],
    [
      { kind: "webhook", url: "https://hooks.example/x", addresses: ["a@example.com"] },
      "invalid_address",
      "A webhook has no email addresses.",
    ],
    [
      { kind: "webhook", url: "https://hooks.example/x", name: "a\u0007b" },
      "invalid_name",
      "A channel's name has at most 100 characters, and no control characters.",
    ],
  ])("refuses %j", async (body, error, message) => {
    const response = await call("POST", "/channels", body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error, message });
  });

  test("bounds what it takes with its schema", async () => {
    for (const body of [
      { kind: "sms", name: "x" },
      { kind: "email", addresses: ["x".repeat(321)] },
      { kind: "webhook", url: `https://hooks.example/${"x".repeat(5000)}` },
      { kind: "email", name: "x".repeat(201), addresses: ["a@example.com"] },
    ]) {
      expect((await call("POST", "/channels", body)).statusCode).toBe(400);
    }
    const created = (
      await call("POST", "/channels", { kind: "email", addresses: ["a@example.com"] })
    ).json();
    expect((await call("PATCH", `/channels/${created.channel.id}`, {})).statusCode).toBe(400);
    const kind = await call("PATCH", `/channels/${created.channel.id}`, { kind: "webhook" });
    expect(kind.statusCode).toBe(400);
    expect(kind.json()).toEqual({
      error: "invalid_kind",
      message: "A channel's kind cannot change. Add a new channel instead.",
    });
    expect((await call("GET", "/channels/not-a-uuid")).statusCode).toBe(400);
  });

  test(`allows at most ${MAX_CHANNELS} channels`, async () => {
    for (let index = 0; index < MAX_CHANNELS; index += 1) {
      expect(
        (await call("POST", "/channels", { kind: "email", addresses: [`a${index}@example.com`] }))
          .statusCode,
      ).toBe(201);
    }
    const refused = await call("POST", "/channels", {
      kind: "email",
      addresses: ["late@example.com"],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: "too_many_channels",
      message: `An instance has at most ${MAX_CHANNELS} notification channels.`,
    });
  });
});

describe("webhooks", () => {
  test("get a secret made by the server, served only by its own route, replaced on demand", async () => {
    const created = await call("POST", "/channels", {
      kind: "webhook",
      url: "https://hooks.example/ottertrail#ignored",
    });
    expect(created.statusCode).toBe(201);
    const { channel } = created.json();
    expect(channel).toMatchObject({
      name: "hooks.example",
      kind: "webhook",
      url: "https://hooks.example/ottertrail",
      addresses: null,
      hasSecret: true,
    });
    // Neither the channel's answers nor the list carry the secret.
    expect(channel).not.toHaveProperty("secret");
    expect(created.body).not.toMatch(/secret"\s*:/u);
    const listed = await call("GET", "/channels");
    expect(listed.body).not.toMatch(/"secret"/u);
    expect((await call("GET", `/channels/${channel.id}`)).json().channel).not.toHaveProperty(
      "secret",
    );

    const shown = await call("GET", `/channels/${channel.id}/secret`);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers["cache-control"]).toBe("no-store");
    const { secret } = shown.json();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(
      (await call("GET", `/channels/${channel.id}/secret`, undefined, { origin: PUBLIC_URL }))
        .statusCode,
    ).toBe(401);

    // Rotation answers the new secret, once; the route serves it after.
    const rotated = await call("POST", `/channels/${channel.id}/secret`);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.headers["cache-control"]).toBe("no-store");
    expect(rotated.json().channel).not.toHaveProperty("secret");
    expect(rotated.json().secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(rotated.json().secret).not.toBe(secret);
    expect((await call("GET", `/channels/${channel.id}/secret`)).json()).toEqual({
      secret: rotated.json().secret,
    });
    // A change to the URL keeps the secret.
    const moved = await call("PATCH", `/channels/${channel.id}`, {
      url: "https://hooks.example/v2",
    });
    expect(moved.json().channel).not.toHaveProperty("secret");
    expect((await call("GET", `/channels/${channel.id}/secret`)).json()).toEqual({
      secret: rotated.json().secret,
    });

    const email = (
      await call("POST", "/channels", { kind: "email", addresses: ["a@example.com"] })
    ).json();
    expect(email.channel.hasSecret).toBe(false);
    for (const method of ["GET", "POST"] as const) {
      const notWebhook = await call(method, `/channels/${email.channel.id}/secret`);
      expect(notWebhook.statusCode).toBe(400);
      expect(notWebhook.json()).toEqual({
        error: "not_a_webhook",
        message: "Only a webhook has a secret.",
      });
    }
    expect(
      (await call("GET", "/channels/00000000-0000-4000-8000-000000000000/secret")).statusCode,
    ).toBe(404);
  });

  test.each([
    ["http://127.0.0.1:5432/", "127.0.0.1 is a loopback address: webhooks may not reach it."],
    ["http://[::1]/", "::1 is a loopback address: webhooks may not reach it."],
    [
      "http://169.254.169.254/latest",
      "169.254.169.254 is a cloud metadata service's address: webhooks may not reach it.",
    ],
    [
      "https://internal.example/hook",
      "internal.example resolves to an address webhooks may not reach.",
    ],
    ["https://mixed.example/hook", "mixed.example resolves to an address webhooks may not reach."],
    ["https://own.example/hook", "own.example resolves to an address webhooks may not reach."],
    [
      "http://203.0.114.7/hook",
      "203.0.114.7 is an address this instance refuses: webhooks may not reach it.",
    ],
  ])("refuses %s on save, whose address webhooks may not reach", async (url, message) => {
    const response = await call("POST", "/channels", { kind: "webhook", url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "address_not_allowed", message });

    // And on a change of URL.
    const created = (
      await call("POST", "/channels", { kind: "webhook", url: "https://hooks.example/x" })
    ).json();
    const changed = await call("PATCH", `/channels/${created.channel.id}`, { url });
    expect(changed.statusCode).toBe(400);
    expect(changed.json()).toEqual({ error: "address_not_allowed", message });
  });

  test("saves a host that does not resolve yet", async () => {
    const response = await call("POST", "/channels", {
      kind: "webhook",
      url: "https://later.example/x",
    });
    expect(response.statusCode).toBe(201);
  });

  test("are checked again when sent: a DNS change after saving does not reach a private address", async () => {
    // Saved while its host resolves to a public address.
    const created = await call("POST", "/channels", {
      kind: "webhook",
      url: `http://hooks.example:${receiver.port}/hook`,
    });
    expect(created.statusCode).toBe(201);
    const { channel } = created.json();
    // Then its DNS answers with the instance's own loopback address.
    dns["hooks.example"] = ["127.0.0.1"];
    expect((await call("POST", `/channels/${channel.id}/test`)).statusCode).toBe(202);

    const logged: Record<string, unknown>[] = [];
    const worker = new DeliverySender({
      db: dashboard.db,
      mailer: null,
      policy: { allowPrivate: false },
      lookup,
      log: (_level, msg, fields = {}) => logged.push({ msg, ...fields }),
    });
    expect(await worker.tick()).toBe(1);
    await worker.drain();
    const { deliveries } = (await call("GET", `/channels/${channel.id}/deliveries`)).json();
    expect(deliveries).toMatchObject([
      {
        type: "test",
        status: "pending",
        attempts: 1,
        lastError: "hooks.example resolves to an address webhooks may not reach.",
      },
    ]);
    expect(receiver.requests).toEqual([]);
    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: "a webhook's address was refused",
        host: "hooks.example",
        address: "127.0.0.1",
        kind: "loopback",
      }),
    );

    // With the private-address setting on, the same delivery goes out.
    await dashboard.db
      .updateTable("notification_deliveries")
      .set({ next_attempt_at: sql<Date>`now()` })
      .execute();
    const allowed = new DeliverySender({
      db: dashboard.db,
      mailer: null,
      policy: { allowPrivate: true },
      lookup,
    });
    expect(await allowed.tick()).toBe(1);
    await allowed.drain();
    expect(receiver.requests).toHaveLength(1);
    expect(JSON.parse(receiver.requests[0]?.body ?? "{}")).toMatchObject({
      version: 1,
      type: "test",
      project: null,
      subject: { type: "channel", id: channel.id, name: `hooks.example` },
      message: `A test notification for the channel "hooks.example", sent by Ada Owner from the dashboard.`,
      url: `${PUBLIC_URL}/settings`,
    });
  });
});

describe("test sends and deliveries", () => {
  test(`take at most ${TEST_SENDS_PER_MINUTE} test sends a minute per channel`, async () => {
    const one = (
      await call("POST", "/channels", { kind: "email", addresses: ["a@example.com"] })
    ).json();
    const two = (
      await call("POST", "/channels", { kind: "email", addresses: ["b@example.com"] })
    ).json();
    for (let index = 0; index < TEST_SENDS_PER_MINUTE; index += 1) {
      const sent = await call("POST", `/channels/${one.channel.id}/test`);
      expect(sent.statusCode).toBe(202);
      expect(sent.json()).toMatchObject({
        delivery: { channelId: one.channel.id, status: "pending" },
      });
    }
    const limited = await call("POST", `/channels/${one.channel.id}/test`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: "too_many_tests",
      message: `A channel takes at most ${TEST_SENDS_PER_MINUTE} test sends a minute. Wait a moment. Then try again.`,
    });
    // Another channel has its own limit; a minute later, the first takes tests again.
    expect((await call("POST", `/channels/${two.channel.id}/test`)).statusCode).toBe(202);
    await dashboard.db
      .updateTable("notification_deliveries")
      .set({ created_at: sql<Date>`now() - interval '61 seconds'` })
      .where("channel_id", "=", one.channel.id)
      .execute();
    expect((await call("POST", `/channels/${one.channel.id}/test`)).statusCode).toBe(202);
    expect(
      (await call("POST", "/channels/00000000-0000-4000-8000-000000000000/test")).statusCode,
    ).toBe(404);
  });

  test("lists a channel's deliveries of the last 30 days, newest first, page by page", async () => {
    const { channel } = (
      await call("POST", "/channels", { kind: "email", addresses: ["a@example.com"] })
    ).json();
    const { channel: other } = (
      await call("POST", "/channels", { kind: "email", addresses: ["b@example.com"] })
    ).json();
    // 25 deliveries a minute apart, and one older than 30 days, and another channel's.
    await dashboard.db
      .insertInto("notification_deliveries")
      .values([
        ...Array.from({ length: 25 }, (_, index) => ({
          notification_id: crypto.randomUUID(),
          channel_id: channel.id,
          event_type: "check.down",
          payload: JSON.stringify({ message: `Message ${index}` }),
          status: "failed" as const,
          attempts: 8,
          last_error: "It answered 500. A webhook must return 2xx.",
          created_at: new Date(Date.now() - (25 - index) * 60_000),
        })),
        {
          notification_id: crypto.randomUUID(),
          channel_id: channel.id,
          event_type: "check.up",
          payload: "{}",
          status: "sent" as const,
          attempts: 1,
          created_at: new Date(Date.now() - 31 * 86_400_000),
        },
        {
          notification_id: crypto.randomUUID(),
          channel_id: other.id,
          event_type: "check.up",
          payload: "{}",
          status: "sent" as const,
          attempts: 1,
        },
      ])
      .execute();

    const pages: { id: string; createdAt: string }[][] = [];
    let before: string | null = null;
    do {
      const query: string = `?limit=10${before === null ? "" : `&before=${before}`}`;
      const response = await call("GET", `/channels/${channel.id}/deliveries${query}`);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.retentionDays).toBe(30);
      pages.push(body.deliveries);
      before = body.next;
    } while (before !== null && pages.length < 5);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 5]);
    const all = pages.flat();
    expect(new Set(all.map((delivery) => delivery.id)).size).toBe(25);
    const times = all.map((delivery) => delivery.createdAt);
    expect(times).toEqual(times.toSorted().toReversed());
    expect(all[0]).toMatchObject({
      type: "check.down",
      status: "failed",
      attempts: 8,
      lastError: "It answered 500. A webhook must return 2xx.",
      nextAttemptAt: null,
      sentAt: null,
    });

    // The default page, and bounds.
    expect(
      (await call("GET", `/channels/${channel.id}/deliveries`)).json().deliveries,
    ).toHaveLength(20);
    for (const query of ["?limit=0", "?limit=101", "?before=nope"]) {
      expect((await call("GET", `/channels/${channel.id}/deliveries${query}`)).statusCode).toBe(
        400,
      );
    }
    expect(
      (await call("GET", "/channels/00000000-0000-4000-8000-000000000000/deliveries")).statusCode,
    ).toBe(404);
  });

  test("say whether email is set up on this instance", async () => {
    const configured = await signedInDashboard({ notifications: { emailConfigured: true } });
    try {
      const response = await configured.app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { cookie: configured.cookie },
      });
      expect(response.json()).toMatchObject({ email: { configured: true }, channels: [] });
    } finally {
      await configured.close();
    }
  });
});
