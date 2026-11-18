import type { Kysely } from "kysely";

import type { Areas } from "../../src/access/areas.ts";
import { setUserAccess } from "../../src/access/grants.ts";
import { type AppOptions, buildApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { createSetupToken } from "../../src/auth/setup.ts";
import type { Reader } from "../../src/clickhouse/query.ts";
import { type NewEvent, storeEvents } from "../../src/collection/event-store.ts";
import { LastEventRecorder } from "../../src/collection/last-event.ts";
import type { RateLimit } from "../../src/collection/rate-limiter.ts";
import type { Database } from "../../src/db/schema.ts";
import { createTestClickHouse } from "./test-clickhouse.ts";
import { createTestDatabase } from "./test-database.ts";

export const PUBLIC_URL = "http://localhost:5173";
export const OWNER = {
  name: "Ada Owner",
  email: "ada@example.com",
  password: "correct horse battery",
  instanceName: "Ada's company",
};

/**
 * An app with the dashboard API on a fresh test database and ClickHouse,
 * its owner created and signed in, the instance's timezone `timeZone`.
 * Send `cookie` (and `origin` for changes) with requests; add events with
 * `store`, which reports then read.
 */
export async function signedInDashboard({
  timeZone = "UTC",
  now,
  objectStore,
  sourceMaps,
  replays,
  replayPlayerPath,
  telemetry,
  uptime,
  notifications,
  linkLimit = { capacity: 1000, refillPerSecond: 1000 },
}: {
  timeZone?: string;
  now?: () => Date;
  /** The object store for source maps and replays; none when omitted (tests/source-maps.test.ts). */
  objectStore?: AppOptions["objectStore"];
  sourceMaps?: AppOptions["sourceMaps"];
  replays?: AppOptions["replays"];
  /** The built replay player, served at /replay-player.js; not served when omitted. */
  replayPlayerPath?: string;
  /** OTLP's limits (tests/telemetry.test.ts); the test's ClickHouse unless it names another. */
  telemetry?: AppOptions["telemetry"];
  /** Uptime checks' address rules and resolver (tests/uptime.test.ts). */
  uptime?: AppOptions["uptime"];
  /** Whether email is set up, for notification channels (tests/channels.test.ts). */
  notifications?: AppOptions["notifications"];
  /** Accepting invitations and using reset links, per client address; no limit by default. */
  linkLimit?: RateLimit;
} = {}) {
  const testDb = await createTestDatabase();
  const testClickHouse = await createTestClickHouse().catch(async (error: unknown) => {
    await testDb.destroy();
    throw error;
  });
  const auth = createAuth({
    db: testDb.db,
    publicUrl: PUBLIC_URL,
    trustedOrigins: [PUBLIC_URL],
    secret: "a-secret-only-these-tests-use-0123456789",
    rateLimit: false,
  });
  const app = buildApp({
    db: testDb.db,
    dashboard: {
      auth,
      clickhouse: testClickHouse.client,
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      linkLimit,
      ...(now === undefined ? {} : { now }),
    },
    ...(objectStore === undefined ? {} : { objectStore }),
    ...(sourceMaps === undefined ? {} : { sourceMaps }),
    ...(replays === undefined ? {} : { replays }),
    ...(replayPlayerPath === undefined ? {} : { replayPlayerPath }),
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(uptime === undefined ? {} : { uptime }),
    ...(notifications === undefined ? {} : { notifications }),
  });
  const link = await createSetupToken(testDb.db);
  await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: link?.token, ...OWNER, confirmPassword: OWNER.password, timeZone },
  });
  const signedIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: PUBLIC_URL, "content-type": "application/json" },
    payload: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const reader: Reader = { client: testClickHouse.client };
  return {
    db: testDb.db,
    /** Where reports read events. */
    reader,
    /** The name of the test's own ClickHouse database. */
    clickhouseDatabase: testClickHouse.database,
    app,
    auth,
    cookie,
    /** Stores events in ClickHouse and records the project's latest, as collection does. */
    store: async (projectId: string, events: readonly NewEvent[]) => {
      await storeEvents(testClickHouse.client, projectId, events);
      await new LastEventRecorder(testDb.db).record(projectId, events);
    },
    close: async () => {
      await app.close();
      await testDb.destroy();
      await testClickHouse.destroy();
    },
  };
}

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const NO_AREAS: Areas = {
  web_analytics: "none",
  product_analytics: "none",
  errors: "none",
  replays: "none",
  users: "none",
  monitoring: "none",
  uptime_alerts: "none",
};

/** What a member is granted (docs/access.md): areas left out are none. */
export interface MemberGrants {
  /** "all", or the projects' IDs. */
  projects: "all" | readonly string[];
  areas?: Partial<Areas>;
}

/** Stores a member's grants, replacing any they had, as the Members page will (access/grants.ts). */
export async function grantMember(
  db: Kysely<Database>,
  userId: string,
  { projects, areas = {} }: MemberGrants,
): Promise<void> {
  await setUserAccess(db, userId, {
    role: "member",
    projects,
    areas: { ...NO_AREAS, ...areas },
  });
}

/**
 * Another dashboard user, created in the database and signed in: a member
 * (with `grants`, or nothing granted) unless `role` says "admin".
 */
export async function signedInUser(
  { db, app, auth }: Pick<Dashboard, "db" | "app" | "auth">,
  {
    name,
    email,
    password = "another correct horse",
    role = "member",
    grants,
  }: {
    name: string;
    email: string;
    password?: string;
    role?: "admin" | "member";
    grants?: MemberGrants;
  },
): Promise<{ userId: string; cookie: string }> {
  const user = await db
    .insertInto("dashboard_users")
    .values({ name, email, role })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (role === "member" && grants !== undefined) {
    await grantMember(db, user.id, grants);
  }
  await db
    .insertInto("dashboard_accounts")
    .values({
      user_id: user.id,
      account_id: user.id,
      provider_id: "credential",
      password: await (await auth.$context).password.hash(password),
    })
    .execute();
  const signedIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: PUBLIC_URL, "content-type": "application/json" },
    payload: JSON.stringify({ email, password }),
  });
  if (signedIn.statusCode !== 200) {
    throw new Error(`${email} could not sign in: ${signedIn.body}`);
  }
  const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { userId: user.id, cookie };
}
