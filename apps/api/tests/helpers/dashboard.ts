import { buildApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { createSetupToken } from "../../src/auth/setup.ts";
import { createTestDatabase } from "./test-database.ts";

export const PUBLIC_URL = "http://localhost:5173";
export const OWNER = {
  name: "Ada Owner",
  email: "ada@example.com",
  password: "correct horse battery",
};

/**
 * An app with the dashboard API on a fresh test database, its owner created
 * and signed in. Send `cookie` (and `origin` for changes) with requests.
 */
export async function signedInDashboard({
  timeZone = "UTC",
  now,
}: { timeZone?: string; now?: () => Date } = {}) {
  const testDb = await createTestDatabase();
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
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      timeZone,
      ...(now === undefined ? {} : { now }),
    },
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
  return {
    db: testDb.db,
    app,
    cookie,
    close: async () => {
      await app.close();
      await testDb.destroy();
    },
  };
}
