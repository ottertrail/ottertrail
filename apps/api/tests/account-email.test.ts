import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { PRESETS } from "../src/access/areas.ts";
import { buildApp } from "../src/app.ts";
import { createAuth } from "../src/auth/auth.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { createDatabase } from "../src/db/database.ts";
import {
  AccountEmailSender,
  accountEmailMessage,
  takeDueAccountEmails,
} from "../src/notifications/account-emails.ts";
import { MAX_ATTEMPTS } from "../src/notifications/deliveries.ts";
import { type Mailer, smtpMailer } from "../src/notifications/email.ts";
import { OWNER, PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { decodedBody, header, type SmtpSink, startSmtpSink } from "./helpers/smtp-sink.ts";

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const PASSWORD = "another correct horse";
const NEW_PASSWORD = "a brand new long password";
const SAME_ANSWER = {
  requested: true,
  message:
    "If an account uses that email, we'll send a reset link. Check your inbox and spam folder.",
};
const LIMITED = {
  error: "rate_limited",
  message: "Too many reset requests. Wait a little, then try again.",
};

let sink: SmtpSink;

beforeAll(async () => {
  sink = await startSmtpSink();
});

afterAll(async () => {
  await sink?.close();
});

beforeEach(() => {
  sink.messages.length = 0;
  sink.reject.count = 0;
});

const sinkMailer = (): Mailer =>
  smtpMailer({ smtpUrl: `smtp://127.0.0.1:${sink.port}`, from: "Ottertrail <ops@example.com>" });

function send(
  dashboard: Dashboard,
  method: string,
  url: string,
  {
    cookie,
    payload,
    ip,
  }: { cookie?: string | undefined; payload?: unknown; ip?: string | undefined } = {},
) {
  return dashboard.app.inject({
    method: method as "POST",
    url,
    ...(ip === undefined ? {} : { remoteAddress: ip }),
    headers: {
      origin: PUBLIC_URL,
      ...(cookie === undefined ? {} : { cookie }),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined
      ? {}
      : { payload: typeof payload === "string" ? payload : JSON.stringify(payload) }),
  });
}

const request = (dashboard: Dashboard, email: string, ip = "203.0.113.7") =>
  send(dashboard, "POST", "/api/reset-password/request", { payload: { email }, ip });

const queued = (dashboard: Dashboard) =>
  dashboard.db
    .selectFrom("account_emails")
    .select(["kind", "to_address", "params", "attempts"])
    .orderBy("created_at")
    .execute();

/** Runs the worker's sender until nothing is due; returns each outcome. */
async function runWorker(dashboard: Dashboard, { now }: { now?: () => Date } = {}) {
  const sender = new AccountEmailSender({
    db: dashboard.db,
    mailer: sinkMailer(),
    publicUrl: PUBLIC_URL,
    ...(now === undefined ? {} : { now }),
  });
  const outcomes = [];
  for (;;) {
    const due = await takeDueAccountEmails(dashboard.db, { limit: 10 });
    if (due.length === 0) break;
    for (const row of due) outcomes.push(await sender.deliver(row));
  }
  return outcomes;
}

/** The link in a message's text, with its token. */
function linkIn(raw: string, path: string): string {
  const match = new RegExp(`${PUBLIC_URL}${path}#token=[A-Za-z0-9_-]+`, "u").exec(decodedBody(raw));
  if (match === null) throw new Error(`No ${path} link in the message`);
  return match[0];
}
const tokenOf = (link: string) => link.slice(link.indexOf("#token=") + 7);

const useReset = (dashboard: Dashboard, token: string, password = NEW_PASSWORD) =>
  send(dashboard, "POST", "/api/reset-password", {
    payload: { token, password, confirmPassword: password },
  });

describe("with SMTP set up", () => {
  let dashboard: Dashboard;
  let counter = 0;

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      notifications: { emailConfigured: true, mailer: sinkMailer() },
      // Wide limits but the ones a test lowers in an app of its own.
      resetRequestLimits: {
        ip: { capacity: 1000, refillPerSecond: 1000 },
        email: { capacity: 1000, refillPerSecond: 1000 },
      },
    });
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  afterEach(async () => {
    await dashboard.db.deleteFrom("account_emails").execute();
  });

  async function member() {
    counter += 1;
    const email = `member-${counter}@example.com`;
    const user = await signedInUser(dashboard, {
      name: `Member ${counter}`,
      email,
      password: PASSWORD,
      grants: { projects: "all", areas: PRESETS.viewer },
    });
    return { ...user, email };
  }

  describe("Forgot password", () => {
    test("answers the same for an address with an account and one without, and only queues", async () => {
      const { email, userId } = await member();
      const real = await request(dashboard, email.toUpperCase());
      const unknown = await request(dashboard, "nobody-here@example.com");
      expect(real.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(real.json()).toEqual(SAME_ANSWER);
      expect(unknown.json()).toEqual(SAME_ANSWER);
      expect(real.headers["content-length"]).toBe(unknown.headers["content-length"]);
      // The request path's work is one insert either way: no link is made
      // and no account is looked up until the worker runs.
      expect(await queued(dashboard)).toEqual([
        { kind: "password_reset", to_address: email, params: {}, attempts: 0 },
        { kind: "password_reset", to_address: "nobody-here@example.com", params: {}, attempts: 0 },
      ]);
      expect(
        await dashboard.db
          .selectFrom("dashboard_password_resets")
          .selectAll()
          .where("user_id", "=", userId)
          .execute(),
      ).toEqual([]);

      // The worker emails the account and sends nothing for the unknown address.
      expect(await runWorker(dashboard)).toEqual(["sent", "no_account"]);
      expect(sink.messages.map((message) => message.to)).toEqual([[email]]);
      expect(await queued(dashboard)).toEqual([]);
    });

    test("the email holds a link that works once and for an hour, from PUBLIC_URL", async () => {
      const { email } = await member();
      await request(dashboard, email);
      await runWorker(dashboard);
      const [message] = sink.messages;
      if (message === undefined) throw new Error("No email");
      expect(header(message.raw, "subject")).toBe(`${OWNER.instanceName}: Reset your password`);
      const text = decodedBody(message.raw);
      expect(text).toContain(
        `You requested a password reset for ${OWNER.instanceName} on Ottertrail.`,
      );
      expect(text).toContain("This link works once and expires in 1 hour.");
      const link = linkIn(message.raw, "/reset-password");
      expect(link.startsWith(`${PUBLIC_URL}/reset-password#token=`)).toBe(true);
      // An HTML version too.
      expect(message.raw).toMatch(/Content-Type: text\/html/u);

      const row = await dashboard.db
        .selectFrom("dashboard_password_resets as r")
        .innerJoin("dashboard_users as u", "u.id", "r.user_id")
        .select(["r.expires_at", "r.created_at", "r.emailed", "r.created_by"])
        .where("u.email", "=", email)
        .executeTakeFirstOrThrow();
      expect(row.emailed).toBe(true);
      expect(row.created_by).toBeNull();
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(60 * 60 * 1000);

      const used = await useReset(dashboard, tokenOf(link));
      expect(used.statusCode).toBe(200);
      expect(
        (await useReset(dashboard, tokenOf(link), "yet another long password")).statusCode,
      ).toBe(404);
    });

    test("a link made more than an hour ago no longer works", async () => {
      const { email } = await member();
      await request(dashboard, email);
      await runWorker(dashboard, { now: () => new Date(Date.now() - 61 * 60 * 1000) });
      const link = linkIn(sink.messages[0]?.raw ?? "", "/reset-password");
      const preview = await send(dashboard, "POST", "/api/reset-password/preview", {
        payload: { token: tokenOf(link) },
      });
      expect(preview.statusCode).toBe(404);
      expect((await useReset(dashboard, tokenOf(link))).statusCode).toBe(404);
    });

    test("a new request replaces the earlier emailed link, but not one an admin made", async () => {
      const { email, userId } = await member();
      const made = await send(dashboard, "POST", `/api/members/${userId}/reset-link`, {
        cookie: dashboard.cookie,
      });
      expect(made.statusCode).toBe(201);
      const adminToken = tokenOf(made.json().url);

      await request(dashboard, email);
      await runWorker(dashboard);
      await request(dashboard, email);
      await runWorker(dashboard);
      const [first, second] = sink.messages.map((message) =>
        tokenOf(linkIn(message.raw, "/reset-password")),
      );
      expect(first).not.toBe(second);
      expect((await useReset(dashboard, first ?? "")).statusCode).toBe(404);
      const preview = await send(dashboard, "POST", "/api/reset-password/preview", {
        payload: { token: adminToken },
      });
      expect(preview.statusCode).toBe(200);

      // Using one link voids the other too: the password is set.
      expect((await useReset(dashboard, second ?? "")).statusCode).toBe(200);
      expect((await useReset(dashboard, adminToken)).statusCode).toBe(404);
    });

    test("a reset signs out every session and sends the password-changed email", async () => {
      const { email, cookie } = await member();
      await request(dashboard, email);
      await runWorker(dashboard);
      const token = tokenOf(linkIn(sink.messages[0]?.raw ?? "", "/reset-password"));
      sink.messages.length = 0;

      expect((await useReset(dashboard, token)).statusCode).toBe(200);
      expect((await send(dashboard, "GET", "/api/me", { cookie })).statusCode).toBe(401);
      expect(await queued(dashboard)).toEqual([
        { kind: "password_changed", to_address: email, params: {}, attempts: 0 },
      ]);
      await runWorker(dashboard);
      const [message] = sink.messages;
      expect(message?.to).toEqual([email]);
      expect(header(message?.raw ?? "", "subject")).toBe(
        `${OWNER.instanceName}: Your password was changed`,
      );
      expect(decodedBody(message?.raw ?? "")).toContain(
        "All sessions that were active before the reset were ended.",
      );
    });

    test("malformed bodies and addresses sign-in refuses are refused, and nothing is queued", async () => {
      const answers = await Promise.all([
        send(dashboard, "POST", "/api/reset-password/request", { payload: {} }),
        send(dashboard, "POST", "/api/reset-password/request", { payload: "not json" }),
        send(dashboard, "POST", "/api/reset-password/request", { payload: { email: ["a"] } }),
        send(dashboard, "POST", "/api/reset-password/request", {
          payload: { email: `${"a".repeat(320)}@example.com` },
        }),
        request(dashboard, "ops!alerts@example.com"),
      ]);
      expect(answers.map((answer) => answer.statusCode)).toEqual([400, 400, 400, 400, 400]);
      expect(await queued(dashboard)).toEqual([]);
    });
  });

  describe("invitations", () => {
    test("are emailed, naming the inviter and the instance, and the link is still answered", async () => {
      const response = await send(dashboard, "POST", "/api/invitations", {
        cookie: dashboard.cookie,
        payload: { email: "Zoe@Example.com", role: "admin" },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.emailed).toBe(true);
      await runWorker(dashboard);
      const [message] = sink.messages;
      expect(message?.to).toEqual(["zoe@example.com"]);
      expect(header(message?.raw ?? "", "subject")).toBe(
        `${OWNER.instanceName}: Invitation from ${OWNER.name}`,
      );
      const text = decodedBody(message?.raw ?? "");
      expect(text).toContain(
        `${OWNER.name} invited you to the Ottertrail instance ${OWNER.instanceName}.`,
      );
      expect(text).toContain("This invitation is for zoe@example.com and expires in 7 days.");
      expect(linkIn(message?.raw ?? "", "/invite")).toBe(body.url);
    });

    test("New link sends again; revoking drops an email not sent yet", async () => {
      const created = await send(dashboard, "POST", "/api/invitations", {
        cookie: dashboard.cookie,
        payload: { email: "renew@example.com", role: "admin" },
      });
      const { invitation } = created.json();
      const renewed = await send(dashboard, "POST", `/api/invitations/${invitation.id}/link`, {
        cookie: dashboard.cookie,
      });
      expect(renewed.statusCode).toBe(200);
      const body = renewed.json();
      expect(body.emailed).toBe(true);
      // The first email's link no longer works: only the new one is queued.
      const rows = await queued(dashboard);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.params).toMatchObject({ link: body.url });

      const revoked = await send(dashboard, "DELETE", `/api/invitations/${invitation.id}`, {
        cookie: dashboard.cookie,
      });
      expect(revoked.statusCode).toBe(204);
      expect(await queued(dashboard)).toEqual([]);
    });
  });

  describe("reset links an owner or admin makes", () => {
    test('"Email it to them" queues the link for the user; copying alone sends nothing', async () => {
      const { email, userId } = await member();
      const copied = await send(dashboard, "POST", `/api/members/${userId}/reset-link`, {
        cookie: dashboard.cookie,
        payload: { email: false },
      });
      expect(copied.json()).toMatchObject({ emailed: false });
      expect(await queued(dashboard)).toEqual([]);

      const emailed = await send(dashboard, "POST", `/api/members/${userId}/reset-link`, {
        cookie: dashboard.cookie,
        payload: { email: true },
      });
      expect(emailed.statusCode).toBe(201);
      const body = emailed.json();
      expect(body.emailed).toBe(true);
      expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
      await runWorker(dashboard);
      const [message] = sink.messages;
      expect(message?.to).toEqual([email]);
      const text = decodedBody(message?.raw ?? "");
      expect(text).toContain(
        `${OWNER.name} made a password reset link for your Ottertrail account on ${OWNER.instanceName}.`,
      );
      expect(text).toContain("This link works once and expires in 24 hours.");
      expect(linkIn(message?.raw ?? "", "/reset-password")).toBe(body.url);
      expect(await queued(dashboard)).toEqual([]);
    });
  });

  describe("an email change", () => {
    test("notifies the old address", async () => {
      const { email, cookie } = await member();
      const changed = await send(dashboard, "POST", "/api/account/email", {
        cookie,
        payload: { email: "moved@example.com", password: PASSWORD },
      });
      expect(changed.statusCode).toBe(200);
      await runWorker(dashboard);
      const [message] = sink.messages;
      expect(message?.to).toEqual([email]);
      expect(header(message?.raw ?? "", "subject")).toBe(
        `${OWNER.instanceName}: Your account email was changed`,
      );
      const text = decodedBody(message?.raw ?? "");
      expect(text.replace(/\r\n/gu, "\n")).toContain(
        `changed from:\n${email}\nto:\nmoved@example.com`,
      );
    });
  });

  describe("the worker", () => {
    test("retries a refused email, then gives it up and deletes it", async () => {
      const { cookie } = await member();
      await send(dashboard, "POST", "/api/account/email", {
        cookie,
        payload: { email: `retried-${counter}@example.com`, password: PASSWORD },
      });
      sink.reject.count = 1;
      const sender = new AccountEmailSender({
        db: dashboard.db,
        mailer: sinkMailer(),
        publicUrl: PUBLIC_URL,
      });
      const [first] = await takeDueAccountEmails(dashboard.db, { limit: 10 });
      if (first === undefined) throw new Error("Nothing queued");
      expect(await sender.deliver(first)).toBe("retrying");
      expect(await queued(dashboard)).toHaveLength(1);
      // The last attempt fails for good, and the row goes.
      sink.reject.count = 1;
      expect(await sender.deliver({ ...first, attempt: MAX_ATTEMPTS })).toBe("given_up");
      expect(await queued(dashboard)).toEqual([]);
    });

    test("without a mailer, a row is given up and deleted, and nothing is sent", async () => {
      const { email } = await member();
      await request(dashboard, email);
      const sender = new AccountEmailSender({
        db: dashboard.db,
        mailer: null,
        publicUrl: PUBLIC_URL,
      });
      const [row] = await takeDueAccountEmails(dashboard.db, { limit: 10 });
      if (row === undefined) throw new Error("Nothing queued");
      expect(await sender.deliver(row)).toBe("given_up");
      expect(await queued(dashboard)).toEqual([]);
      expect(sink.messages).toEqual([]);
    });
  });

  describe("the test email", () => {
    test("goes to the signed-in user's own address at once", async () => {
      const response = await send(dashboard, "POST", "/api/channels/email-test", {
        cookie: dashboard.cookie,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        email: OWNER.email,
        message: `The mail server accepted a test email for ${OWNER.email}. Check your inbox.`,
      });
      expect(sink.messages.map((message) => message.to)).toEqual([[OWNER.email]]);
      expect(header(sink.messages[0]?.raw ?? "", "subject")).toBe(
        `${OWNER.instanceName}: Test email`,
      );
      // Not queued.
      expect(await queued(dashboard)).toEqual([]);
    });

    test("is for the owner and admins only, from the dashboard", async () => {
      const { cookie } = await member();
      expect(
        (await send(dashboard, "POST", "/api/channels/email-test", { cookie })).statusCode,
      ).toBe(403);
      expect((await send(dashboard, "POST", "/api/channels/email-test")).statusCode).toBe(401);
      const admin = await signedInUser(dashboard, {
        name: "Ann Admin",
        email: "ann-admin@example.com",
        role: "admin",
      });
      expect(
        (await send(dashboard, "POST", "/api/channels/email-test", { cookie: admin.cookie }))
          .statusCode,
      ).toBe(200);
      const foreign = await dashboard.app.inject({
        method: "POST",
        url: "/api/channels/email-test",
        headers: { cookie: dashboard.cookie, origin: "https://elsewhere.example" },
      });
      expect(foreign.statusCode).toBe(403);
    });
  });
});

describe("the limits on Forgot password", () => {
  let dashboard: Dashboard;

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      notifications: { emailConfigured: true, mailer: sinkMailer() },
      resetRequestLimits: {
        ip: { capacity: 5, refillPerSecond: 5 / 900 },
        email: { capacity: 3, refillPerSecond: 3 / 3600 },
      },
    });
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  test("three an hour per email address, counted alike for an account's address and an unknown one", async () => {
    for (const email of [OWNER.email, "unknown@example.com"]) {
      const answers = [];
      for (let i = 0; i < 4; i += 1) {
        // A new client address each time: only the address's own limit counts.
        answers.push(
          await request(dashboard, email, `198.51.100.${i + (email === OWNER.email ? 10 : 20)}`),
        );
      }
      expect(answers.map((answer) => answer.statusCode)).toEqual([202, 202, 202, 429]);
      expect(answers[3]?.json()).toEqual(LIMITED);
      expect(Number(answers[3]?.headers["retry-after"])).toBeGreaterThan(0);
    }
  });

  test("five per 15 minutes per client address, an IPv6 address by its /64", async () => {
    const answers = [];
    for (let i = 0; i < 6; i += 1) {
      answers.push(await request(dashboard, `limit-${i}@example.com`, `2001:db8:1:2::${i + 1}`));
    }
    expect(answers.map((answer) => answer.statusCode)).toEqual([202, 202, 202, 202, 202, 429]);
    expect(answers[5]?.json()).toEqual(LIMITED);
    // Another /64 has its own.
    expect((await request(dashboard, "limit-x@example.com", "2001:db8:1:3::1")).statusCode).toBe(
      202,
    );
  });
});

describe("the test email's limit and errors", () => {
  test("five per 10 minutes per user", async () => {
    const dashboard = await signedInDashboard({
      notifications: { emailConfigured: true, mailer: sinkMailer() },
    });
    try {
      const answers = [];
      for (let i = 0; i < 6; i += 1) {
        answers.push(
          await send(dashboard, "POST", "/api/channels/email-test", { cookie: dashboard.cookie }),
        );
      }
      expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200, 200, 429]);
      expect(answers[5]?.json()).toMatchObject({ error: "rate_limited" });
    } finally {
      await dashboard.close();
    }
  });

  test("a refusal answers the server's error in mailError's words, never SMTP_URL", async () => {
    const secretUrl = "smtp://user:hunter2-secret@mail.example.com:587";
    const refusing: Mailer = {
      send: () =>
        Promise.reject(
          Object.assign(new Error(`Invalid login for ${secretUrl}`), {
            code: "EAUTH",
            responseCode: 535,
          }),
        ),
      close: () => undefined,
    };
    const dashboard = await signedInDashboard({
      notifications: { emailConfigured: true, mailer: refusing },
    });
    try {
      const response = await send(dashboard, "POST", "/api/channels/email-test", {
        cookie: dashboard.cookie,
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: "email_failed",
        message:
          "The test email could not be sent. Check the server's email settings, then try again. Error: The SMTP server refused the user name and password (535).",
      });
      expect(response.body).not.toContain("hunter2");
    } finally {
      await dashboard.close();
    }
  });
});

describe("without SMTP", () => {
  let dashboard: Dashboard;

  beforeAll(async () => {
    dashboard = await signedInDashboard();
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  test("nothing is sent or queued, and Forgot password and the test email say why", async () => {
    const member = await signedInUser(dashboard, {
      name: "Nia",
      email: "nia@example.com",
      password: PASSWORD,
    });
    const forgot = await request(dashboard, "nia@example.com");
    expect(forgot.statusCode).toBe(404);
    expect(forgot.json()).toMatchObject({ error: "email_not_set_up" });

    const invited = await send(dashboard, "POST", "/api/invitations", {
      cookie: dashboard.cookie,
      payload: { email: "zed@example.com", role: "admin" },
    });
    expect(invited.json()).toMatchObject({ emailed: false });

    const link = await send(dashboard, "POST", `/api/members/${member.userId}/reset-link`, {
      cookie: dashboard.cookie,
    });
    expect(link.statusCode).toBe(201);
    expect(link.json()).toMatchObject({ emailed: false });
    const emailIt = await send(dashboard, "POST", `/api/members/${member.userId}/reset-link`, {
      cookie: dashboard.cookie,
      payload: { email: true },
    });
    expect(emailIt.statusCode).toBe(409);

    const token = tokenOf(link.json().url);
    expect((await useReset(dashboard, token)).statusCode).toBe(200);

    const signIn = await dashboard.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: PUBLIC_URL, "content-type": "application/json" },
      payload: JSON.stringify({ email: "nia@example.com", password: NEW_PASSWORD }),
    });
    const cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect(
      (
        await send(dashboard, "POST", "/api/account/email", {
          cookie,
          payload: { email: "nia2@example.com", password: NEW_PASSWORD },
        })
      ).statusCode,
    ).toBe(200);

    const tested = await send(dashboard, "POST", "/api/channels/email-test", {
      cookie: dashboard.cookie,
    });
    expect(tested.statusCode).toBe(409);
    expect(tested.json()).toMatchObject({ error: "email_not_set_up" });

    const members = await send(dashboard, "GET", "/api/members", { cookie: dashboard.cookie });
    expect(members.json()).toMatchObject({ emailConfigured: false });
    expect(await queued(dashboard)).toEqual([]);
  });
});

describe("an account email's message", () => {
  test("escapes the HTML version, and keeps the subject on one line", () => {
    const message = accountEmailMessage(
      {
        kind: "invitation",
        to: "a@example.com",
        params: {
          link: "http://localhost:5173/invite#token=abc",
          inviter: "Eve <b>\r\nBcc: x@example.com",
          invitedEmail: "a@example.com",
        },
      },
      'Acme "<script>"',
    );
    expect(message.subject).not.toMatch(/[\r\n]/u);
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("Eve &lt;b&gt;");
    expect(message.html).toContain(
      '<a href="http://localhost:5173/invite#token=abc">http://localhost:5173/invite#token=abc</a>',
    );
    expect(message.text).toContain("http://localhost:5173/invite#token=abc");
  });

  test("a malformed request is refused before any database work", async () => {
    // An app whose databases cannot be reached: anything that touched them would answer 500.
    const db = createDatabase({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
    const auth = createAuth({
      db,
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      secret: "a-secret-only-these-tests-use-0123456789",
    });
    const clickhouse = createClickHouse({
      url: "http://127.0.0.1:1",
      username: "nobody",
      password: "none",
      database: "none",
    });
    const app = buildApp({
      db,
      dashboard: { auth, clickhouse, publicUrl: PUBLIC_URL, trustedOrigins: [PUBLIC_URL] },
      notifications: { emailConfigured: true },
      dashboardPath: tmpdir(),
    });
    try {
      const answers = await Promise.all(
        [
          {},
          { email: 3 },
          { email: { address: "a@example.com" } },
          { email: "not-an-address" },
        ].map((payload) =>
          app.inject({
            method: "POST",
            url: "/api/reset-password/request",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify(payload),
          }),
        ),
      );
      expect(answers.map((answer) => answer.statusCode)).toEqual([400, 400, 400, 400]);
    } finally {
      await app.close();
      await db.destroy();
      await clickhouse.close();
    }
  });
});
