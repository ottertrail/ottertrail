import { type AppOptions, buildApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { createSetupToken } from "../../src/auth/setup.ts";
import type { Reader } from "../../src/clickhouse/query.ts";
import { type NewEvent, storeEvents } from "../../src/collection/event-store.ts";
import { LastEventRecorder } from "../../src/collection/last-event.ts";
import type { MembershipRole } from "../../src/db/schema.ts";
import { createOrganization } from "../../src/organizations/organizations.ts";
import { createTestClickHouse } from "./test-clickhouse.ts";
import { createTestDatabase } from "./test-database.ts";

export const PUBLIC_URL = "http://localhost:5173";
export const OWNER = {
  name: "Ada Owner",
  email: "ada@example.com",
  password: "correct horse battery",
  organizationName: "Ada's company",
};

/**
 * An app with the dashboard API on a fresh test database and ClickHouse,
 * its owner created and signed in, with their organization in `timeZone`.
 * Send `cookie` (and `origin` for changes) with requests; put projects in
 * `organizationId`; add events with `store`, which reports then read.
 */
export async function signedInDashboard({
  timeZone = "UTC",
  now,
  objectStore,
  sourceMaps,
  replays,
  replayPlayerPath,
  telemetry,
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
      defaultTimeZone: timeZone,
      ...(now === undefined ? {} : { now }),
    },
    ...(objectStore === undefined ? {} : { objectStore }),
    ...(sourceMaps === undefined ? {} : { sourceMaps }),
    ...(replays === undefined ? {} : { replays }),
    ...(replayPlayerPath === undefined ? {} : { replayPlayerPath }),
    ...(telemetry === undefined ? {} : { telemetry }),
  });
  const link = await createSetupToken(testDb.db);
  await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: link?.token, ...OWNER },
  });
  const signedIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: PUBLIC_URL, "content-type": "application/json" },
    payload: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const { organization_id: organizationId } = await testDb.db
    .selectFrom("memberships")
    .select("organization_id")
    .executeTakeFirstOrThrow();
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
    organizationId,
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

/**
 * Another dashboard user, signed in: a member of an existing organization,
 * the owner of a new one, or in no organization at all.
 */
export async function signedInUser(
  { db, app, auth }: Pick<Dashboard, "db" | "app" | "auth">,
  {
    name,
    email,
    password = "another correct horse",
  }: { name: string; email: string; password?: string },
  membership:
    | { organizationId: string; role: MembershipRole }
    | { newOrganization: string; timeZone?: string }
    | null,
): Promise<{ userId: string; cookie: string; organizationId: string | null }> {
  const user = await db
    .insertInto("dashboard_users")
    .values({ name, email })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("dashboard_accounts")
    .values({
      user_id: user.id,
      account_id: user.id,
      provider_id: "credential",
      password: await (await auth.$context).password.hash(password),
    })
    .execute();
  let organizationId: string | null = null;
  if (membership !== null && "organizationId" in membership) {
    organizationId = membership.organizationId;
    await db
      .insertInto("memberships")
      .values({ organization_id: organizationId, user_id: user.id, role: membership.role })
      .execute();
  } else if (membership !== null) {
    organizationId = (
      await createOrganization(db, {
        name: membership.newOrganization,
        timeZone: membership.timeZone ?? "UTC",
        ownerId: user.id,
      })
    ).id;
  }
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
  return { userId: user.id, cookie, organizationId };
}
