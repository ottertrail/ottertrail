import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { notify, type NotifyInput, RETRY_DELAYS_SECONDS } from "../src/notifications/deliveries.ts";
import { emailOf, NOT_SET_UP_ERROR, sendEmail, smtpMailer } from "../src/notifications/email.ts";
import type { NotificationPayload } from "../src/notifications/events.ts";
import { DeliverySender } from "../src/notifications/sender.ts";
import { updateInstanceSettings } from "../src/settings/settings.ts";
import { decodedBody, header, type SmtpSink, startSmtpSink } from "./helpers/smtp-sink.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

/** Credentials made at run time, so no secret scanner mistakes them for real ones. */
const LOGIN = { user: "alerts", pass: ["sink", "pass?word#", String(4242), "@:%/"].join("-") };

const instance = { name: "Acme", timeZone: "Asia/Singapore" };

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

let open: SmtpSink;
let guarded: SmtpSink;

beforeAll(async () => {
  open = await startSmtpSink();
  guarded = await startSmtpSink({ login: LOGIN });
});

afterAll(async () => {
  await open?.close();
  await guarded?.close();
});

beforeEach(() => {
  for (const sink of [open, guarded]) {
    sink.messages.length = 0;
    sink.logins.length = 0;
    sink.reject.count = 0;
  }
});

const openMailer = () =>
  smtpMailer({ smtpUrl: `smtp://127.0.0.1:${open.port}`, from: "Ottertrail <alerts@example.com>" });

describe("an alert email", () => {
  test("is plain text: what happened, when, and the link; the subject starts with the instance's name", () => {
    const { subject, text } = emailOf(payload, instance);
    expect(subject).toBe("Acme: API health is down: it answered 503.");
    expect(text).toBe(
      [
        "API health is down: it answered 503.",
        "",
        "When: 18 Nov 2026, 14:30 (Asia/Singapore)",
        "Project: Shop",
        "Open in Ottertrail: https://ottertrail.example.com/projects/0d6e5f80/uptime/c0ffee00",
        "",
        "-- ",
        'Sent by "Acme" on Ottertrail.',
        "",
      ].join("\n"),
    );
    // A subject is one line, and not too long.
    const long = emailOf(
      { ...payload, message: `Line one\r\nBcc: someone@example.com ${"x".repeat(300)}` },
      instance,
    );
    expect(long.subject).not.toMatch(/[\r\n]/u);
    expect(long.subject.length).toBeLessThanOrEqual(200);
  });

  test("goes to the SMTP server, to every address", async () => {
    const mailer = openMailer();
    try {
      expect(
        await sendEmail(mailer, ["ops@example.com", "dev@example.com"], payload, instance),
      ).toEqual({ ok: true });
    } finally {
      mailer.close();
    }
    expect(open.messages).toHaveLength(1);
    const [message] = open.messages;
    expect(message?.from).toBe("alerts@example.com");
    expect(message?.to).toEqual(["ops@example.com", "dev@example.com"]);
    expect(header(message?.raw ?? "", "Subject")).toBe(
      "Acme: API health is down: it answered 503.",
    );
    expect(header(message?.raw ?? "", "From")).toBe("Ottertrail <alerts@example.com>");
    expect(header(message?.raw ?? "", "Content-Type")).toMatch(/^text\/plain/u);
    const body = decodedBody(message?.raw ?? "");
    expect(body).toContain("When: 18 Nov 2026, 14:30 (Asia/Singapore)");
    expect(body).toContain(`Open in Ottertrail: ${payload.url}`);
  });

  test("signs in after STARTTLS, and a wrong password fails without repeating it", async () => {
    const mailer = smtpMailer(
      {
        smtpUrl: `smtp://${LOGIN.user}:${encodeURIComponent(LOGIN.pass)}@localhost:${guarded.port}`,
        from: "alerts@example.com",
      },
      { ca: guarded.certificate.cert },
    );
    try {
      expect(await sendEmail(mailer, ["ops@example.com"], payload, instance)).toEqual({ ok: true });
    } finally {
      mailer.close();
    }
    expect(guarded.logins).toEqual([{ user: "alerts", ok: true }]);
    expect(guarded.messages).toHaveLength(1);

    const wrong = `${LOGIN.pass}-wrong`;
    const refused = smtpMailer(
      {
        smtpUrl: `smtp://${LOGIN.user}:${encodeURIComponent(wrong)}@localhost:${guarded.port}`,
        from: "alerts@example.com",
      },
      { ca: guarded.certificate.cert },
    );
    try {
      const outcome = await sendEmail(refused, ["ops@example.com"], payload, instance);
      expect(outcome).toEqual({
        ok: false,
        error: "The SMTP server refused the user name and password (535).",
      });
      expect(JSON.stringify(outcome)).not.toContain(wrong);
      expect(JSON.stringify(outcome)).not.toContain(encodeURIComponent(wrong));
    } finally {
      refused.close();
    }
    expect(guarded.messages).toHaveLength(1);
  });

  test("never sends the password over a connection without TLS", async () => {
    // The open sink offers no STARTTLS: with a password to send, the mailer stops there.
    const mailer = smtpMailer({
      smtpUrl: `smtp://${LOGIN.user}:${encodeURIComponent(LOGIN.pass)}@localhost:${open.port}`,
      from: "alerts@example.com",
    });
    try {
      const outcome = await sendEmail(mailer, ["ops@example.com"], payload, instance);
      expect(outcome.ok).toBe(false);
    } finally {
      mailer.close();
    }
    expect(open.messages).toEqual([]);
  });

  test("takes its options from the code, never from the URL's query string", async () => {
    // Config refuses a query string; were one to reach the mailer, it is not read:
    // requireTLS=false would let the password go over a connection without TLS.
    const mailer = smtpMailer({
      smtpUrl: `smtp://${LOGIN.user}:${encodeURIComponent(LOGIN.pass)}@localhost:${open.port}?requireTLS=false&ignoreTLS=true`,
      from: "alerts@example.com",
    });
    try {
      expect((await sendEmail(mailer, ["ops@example.com"], payload, instance)).ok).toBe(false);
    } finally {
      mailer.close();
    }
    expect(open.messages).toEqual([]);
  });

  test("fails when nothing listens", async () => {
    const closed = await startSmtpSink();
    await closed.close();
    const mailer = smtpMailer({
      smtpUrl: `smtp://127.0.0.1:${closed.port}`,
      from: "a@example.com",
    });
    try {
      expect(await sendEmail(mailer, ["ops@example.com"], payload, instance)).toEqual({
        ok: false,
        error: "The connection to the SMTP server failed, or the server closed it.",
      });
    } finally {
      mailer.close();
    }
  });
});

describe("email deliveries", () => {
  let testDb: TestDatabase;
  let channel = "";

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await updateInstanceSettings(testDb.db, { name: "Acme", timeZone: "Asia/Singapore" });
  });

  afterAll(async () => {
    await testDb?.destroy();
  });

  beforeEach(async () => {
    await testDb.db.deleteFrom("notification_channels").execute();
    channel = (
      await testDb.db
        .insertInto("notification_channels")
        .values({ name: "Ops", kind: "email", email_addresses: ["ops@example.com"] })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  });

  const input = (): NotifyInput => ({
    channelIds: [channel],
    type: "check.down",
    project: payload.project,
    subject: payload.subject,
    message: payload.message,
    url: payload.url,
  });

  const rows = () => testDb.db.selectFrom("notification_deliveries").selectAll().execute();

  test("are retried after the server refuses one, then sent", async () => {
    open.reject.count = 1;
    await notify(testDb.db, input());
    const mailer = openMailer();
    try {
      // The database's clock, which the deliveries' times are on.
      const {
        rows: [clock],
      } = await sql<{ now: Date }>`select now() as now`.execute(testDb.db);
      const at = clock?.now ?? new Date();
      const worker = new DeliverySender({
        db: testDb.db,
        mailer,
        policy: { allowPrivate: false },
        now: () => at,
      });
      expect(await worker.tick()).toBe(1);
      await worker.drain();
      expect(await rows()).toMatchObject([
        {
          status: "pending",
          attempts: 1,
          last_error: expect.stringMatching(/^The SMTP server refused the message \(451\)/u),
        },
      ]);
      const later = new Date(at.getTime() + RETRY_DELAYS_SECONDS[0] * 1000);
      const again = new DeliverySender({
        db: testDb.db,
        mailer,
        policy: { allowPrivate: false },
        now: () => later,
      });
      expect(await again.tick()).toBe(1);
      await again.drain();
    } finally {
      mailer.close();
    }
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 2, last_error: null }]);
    expect(open.messages).toHaveLength(1);
    expect(header(open.messages[0]?.raw ?? "", "Subject")).toBe(
      "Acme: API health is down: it answered 503.",
    );
  });

  test("fail at once, saying why, when email is not set up", async () => {
    await notify(testDb.db, input());
    const worker = new DeliverySender({
      db: testDb.db,
      mailer: null,
      policy: { allowPrivate: false },
    });
    expect(await worker.tick()).toBe(1);
    await worker.drain();
    expect(await rows()).toMatchObject([
      { status: "failed", attempts: 1, next_attempt_at: null, last_error: NOT_SET_UP_ERROR },
    ]);
    expect(NOT_SET_UP_ERROR).toBe(
      "Email isn't set up. Ask the instance's operator to set SMTP_URL and EMAIL_FROM.",
    );
  });
});
