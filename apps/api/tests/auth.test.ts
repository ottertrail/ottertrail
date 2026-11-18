import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { type Auth, createAuth } from "../src/auth/auth.ts";
import { requireSession } from "../src/auth/routes.ts";
import {
  completeSetup,
  createSetupToken,
  ownerExists,
  SETUP_LINK_TTL_MS,
} from "../src/auth/setup.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import type { RateLimit } from "../src/collection/rate-limiter.ts";
import { loadConfig } from "../src/config.ts";
import { readInstanceSettings } from "../src/settings/settings.ts";
import { createTestDatabase } from "./helpers/test-database.ts";

const PUBLIC_URL = "http://localhost:5173";
const OWNER = {
  name: "Ada Owner",
  email: "Ada@Example.com",
  password: "correct horse battery",
  instanceName: "Ada's company",
};

/** A fresh instance: its own database schema, no owner yet. */
async function instance({
  rateLimit = false,
  setupLimit,
}: { rateLimit?: boolean; setupLimit?: RateLimit } = {}) {
  const testDb = await createTestDatabase();
  const auth = createAuth({
    db: testDb.db,
    publicUrl: PUBLIC_URL,
    trustedOrigins: [PUBLIC_URL],
    secret: "a-secret-only-these-tests-use-0123456789",
    rateLimit,
  });
  // Never queried here: these tests read no reports, so no ClickHouse is needed.
  const clickhouse = createClickHouse(loadConfig().clickhouse);
  const app = buildApp({
    db: testDb.db,
    dashboard: {
      auth,
      clickhouse,
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      // Not the migration's UTC, so the setup tests see that setup sets it.
      defaultTimeZone: "Asia/Singapore",
      ...(setupLimit === undefined ? {} : { setupLimit }),
    },
  });
  // A route only signed-in users may use, to test the session check.
  app.get("/api/test/me", { preHandler: requireSession(auth) }, (request, reply) =>
    reply.send({ user: request.dashboardUser }),
  );
  return {
    db: testDb.db,
    app,
    close: async () => {
      await app.close();
      await clickhouse.close();
      await testDb.destroy();
    },
  };
}

type Instance = Awaited<ReturnType<typeof instance>>;

function setUp(app: Instance["app"], body: object) {
  return app.inject({ method: "POST", url: "/api/setup", payload: body });
}

function signIn(
  app: Instance["app"],
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
  remoteAddress = "203.0.113.10",
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: PUBLIC_URL, "content-type": "application/json", ...headers },
    payload: JSON.stringify(credentials),
    remoteAddress,
  });
}

/** An Auth whose password hashing only counts calls. */
function countingAuth() {
  const hashed: string[] = [];
  const auth = {
    $context: Promise.resolve({
      password: {
        hash: (password: string) => {
          hashed.push(password);
          return Promise.resolve(`hash-of-${password.length}`);
        },
      },
    }),
  } as unknown as Auth;
  return { auth, hashed };
}

/** The cookies a response set, as a Cookie request header. */
function cookieHeader(response: LightMyRequestResponse): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

describe("owner setup", () => {
  let current: Instance;
  beforeAll(async () => {
    current = await instance();
  });
  afterAll(async () => {
    await current?.close();
  });

  test("refuses an expired link", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * SETUP_LINK_TTL_MS);
    const old = await createSetupToken(current.db, twoHoursAgo);
    const response = await setUp(current.app, { token: old?.token, ...OWNER });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "invalid_link" });
  });

  test("refuses a short password or a bad email before using the link", async () => {
    const link = await createSetupToken(current.db);
    for (const body of [
      { ...OWNER, password: "too short" },
      { ...OWNER, email: "not an email" },
      // A valid email format that sign-in refuses: the owner could never sign in.
      { ...OWNER, email: "ops!alerts@example.com" },
      { ...OWNER, name: "   " },
      { ...OWNER, instanceName: "   " },
      { token: link?.token, name: OWNER.name, email: OWNER.email, password: OWNER.password },
    ]) {
      expect((await setUp(current.app, { token: link?.token, ...body })).statusCode).toBe(400);
    }
    expect(await ownerExists(current.db)).toBe(false);
    // The link still works.
    expect(
      await current.db.selectFrom("owner_setup_tokens").select("token_hash").execute(),
    ).toHaveLength(1);
  });

  test("replaces an earlier link with a new one", async () => {
    const first = await createSetupToken(current.db);
    await createSetupToken(current.db);
    expect((await setUp(current.app, { token: first?.token, ...OWNER })).statusCode).toBe(403);
  });

  test("creates the owner from a link, once, even when two requests race", async () => {
    expect((await current.app.inject({ url: "/api/setup" })).json()).toEqual({
      ownerExists: false,
    });
    const link = await createSetupToken(current.db);
    const responses = await Promise.all([
      setUp(current.app, { token: link?.token, ...OWNER }),
      setUp(current.app, { token: link?.token, ...OWNER, email: "eve@example.com" }),
    ]);
    expect(responses.map((response) => response.statusCode).toSorted((a, b) => a - b)).toEqual([
      201, 403,
    ]);

    const users = await current.db.selectFrom("dashboard_users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: "owner", name: "Ada Owner" });
    // The password is stored as a hash, never as itself.
    const account = await current.db
      .selectFrom("dashboard_accounts")
      .selectAll()
      .executeTakeFirst();
    expect(account?.provider_id).toBe("credential");
    expect(account?.password).not.toContain(OWNER.password);
    expect((await current.app.inject({ url: "/api/setup" })).json()).toEqual({ ownerExists: true });

    // Setup names the instance, and sets its timezone from TIMEZONE (the
    // migration's row says UTC until then).
    const settings = await current.db.selectFrom("instance_settings").selectAll().execute();
    expect(settings).toMatchObject([{ name: "Ada's company", time_zone: "Asia/Singapore" }]);
    expect(await readInstanceSettings(current.db)).toEqual({
      name: "Ada's company",
      timeZone: "Asia/Singapore",
    });
  });

  test("gives no new link once the owner exists", async () => {
    expect(await createSetupToken(current.db)).toBeNull();
  });
});

describe("owner setup: the slow work comes last", () => {
  let current: Instance;
  beforeAll(async () => {
    current = await instance();
  });
  afterAll(async () => {
    await current?.close();
  });

  test("hashes no password for a made-up link, or once the owner exists", async () => {
    const { auth, hashed } = countingAuth();
    const details = {
      token: "made-up",
      name: "Eve",
      email: "eve@example.com",
      password: "x".repeat(20),
      instanceName: "Eve's company",
    };
    const options = { timeZone: "UTC" };
    expect(await completeSetup(current.db, auth, details, options)).toBe("invalid_link");
    expect(hashed).toHaveLength(0);

    const link = await createSetupToken(current.db);
    expect(
      await completeSetup(current.db, auth, { ...details, token: link?.token ?? "" }, options),
    ).toBe("created");
    expect(hashed).toHaveLength(1);

    expect(await completeSetup(current.db, auth, details, options)).toBe("already_set_up");
    expect(hashed).toHaveLength(1);
  });
});

describe("owner setup rate limit", () => {
  let current: Instance;
  beforeAll(async () => {
    current = await instance({ setupLimit: { capacity: 2, refillPerSecond: 0.001 } });
  });
  afterAll(async () => {
    await current?.close();
  });

  const attempt = (remoteAddress: string) =>
    current.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { token: "made-up", ...OWNER },
      remoteAddress,
    });

  test("limits setup attempts per client address", async () => {
    expect((await attempt("203.0.113.10")).statusCode).toBe(403);
    expect((await attempt("203.0.113.10")).statusCode).toBe(403);
    const limited = await attempt("203.0.113.10");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    // Another address has its own limit.
    expect((await attempt("198.51.100.7")).statusCode).toBe(403);
  });
});

describe("signing in", () => {
  let current: Instance;
  beforeAll(async () => {
    current = await instance();
    const link = await createSetupToken(current.db);
    await setUp(current.app, { token: link?.token, ...OWNER });
  });
  afterAll(async () => {
    await current?.close();
  });

  test("signs the owner in with a session cookie that signed-in routes accept", async () => {
    // Email addresses are matched without regard to case.
    const response = await signIn(current.app, { ...OWNER, email: "ada@example.com" });
    expect(response.statusCode).toBe(200);
    const session = response.cookies.find((cookie) => cookie.name.endsWith("session_token"));
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    const me = await current.app.inject({
      url: "/api/test/me",
      headers: { cookie: cookieHeader(response) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: "ada@example.com", role: "owner" } });
  });

  test("answers 401 to a signed-in route without a session", async () => {
    const me = await current.app.inject({ url: "/api/test/me" });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toMatchObject({ error: "unauthorized" });
  });

  test("refuses a wrong password", async () => {
    const response = await signIn(current.app, { ...OWNER, password: "wrong password!!" });
    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });

  test("lets nobody sign up", async () => {
    const response = await current.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: PUBLIC_URL, "content-type": "application/json" },
      payload: JSON.stringify({
        name: "Eve",
        email: "eve@example.com",
        password: "a long password!",
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(await current.db.selectFrom("dashboard_users").select("email").execute()).toEqual([
      { email: "ada@example.com" },
    ]);
  });

  test("refuses a sign-in sent from another site", async () => {
    const response = await signIn(current.app, OWNER, { origin: "https://attacker.example" });
    expect(response.statusCode).toBe(403);
    expect(response.cookies).toHaveLength(0);
  });

  test("stores no IP address with a session", async () => {
    await signIn(current.app, OWNER, { "x-forwarded-for": "198.51.100.7" });
    const sessions = await current.db
      .selectFrom("dashboard_sessions")
      .select("ip_address")
      .execute();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.ip_address === null)).toBe(true);
  });

  test("ends the session on sign-out", async () => {
    const cookie = cookieHeader(await signIn(current.app, OWNER));
    const signOut = await current.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: PUBLIC_URL, cookie },
    });
    expect(signOut.statusCode).toBe(200);
    expect(
      (await current.app.inject({ url: "/api/test/me", headers: { cookie } })).statusCode,
    ).toBe(401);
  });
});

describe("sign-in rate limit", () => {
  let current: Instance;
  beforeAll(async () => {
    current = await instance({ rateLimit: true });
    const link = await createSetupToken(current.db);
    await setUp(current.app, { token: link?.token, ...OWNER });
  });
  afterAll(async () => {
    await current?.close();
  });

  test("limits attempts per client, whatever address headers the client sends", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const forged = `198.51.100.${attempt}`;
      const response = await signIn(
        current.app,
        { ...OWNER, password: "wrong password!!" },
        { "x-forwarded-for": forged, "x-ottertrail-client-ip": forged },
      );
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
    // Another client is not affected.
    const other = await signIn(current.app, OWNER, {}, "192.0.2.44");
    expect(other.statusCode).toBe(200);
  });
});
