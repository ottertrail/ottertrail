import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { PRESETS } from "../src/access/areas.ts";
import { OWNER, PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const PASSWORD = "another correct horse";
const NEW_PASSWORD = "a brand new long password";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/140.0";

/* The signed-in user's own account: name, email, password, and sessions (docs/access.md). */
describe("your account", () => {
  let dashboard: Dashboard;
  let counter = 0;

  function send(
    cookie: string | undefined,
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    return dashboard.app.inject({
      method: method as "GET",
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        origin: PUBLIC_URL,
        "user-agent": UA,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(payload === undefined
        ? {}
        : { payload: typeof payload === "string" ? payload : JSON.stringify(payload) }),
    });
  }

  const signIn = (email: string, password: string) =>
    send(undefined, "POST", "/api/auth/sign-in/email", { email, password });

  const cookieOf = (response: Awaited<ReturnType<typeof signIn>>) =>
    response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  /** A new member, signed in, with their own rate limits' bucket. */
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

  const attemptEmail = (cookie: string, password: string) =>
    send(cookie, "POST", "/api/account/email", { email: "tries@example.com", password });

  const change = (cookie: string, body: Record<string, unknown>) =>
    send(cookie, "POST", "/api/account/password", {
      currentPassword: PASSWORD,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
      revokeOtherSessions: false,
      ...body,
    });

  const sessionsOf = (userId: string) =>
    dashboard.db
      .selectFrom("dashboard_sessions")
      .select(["id", "user_agent", "ip_address"])
      .where("user_id", "=", userId)
      .execute();

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      accountLimit: { capacity: 3, refillPerSecond: 1 / 600 },
    });
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  describe("the name", () => {
    test("changes, trimmed, and the session shows it at once", async () => {
      const user = await member();
      const response = await send(user.cookie, "PATCH", "/api/account", { name: "  Zoe Zed " });
      expect(response.statusCode).toBe(200);
      expect(response.json().user).toEqual({ id: user.userId, name: "Zoe Zed", email: user.email });
      const session = await send(user.cookie, "GET", "/api/auth/get-session");
      expect(session.json().user.name).toBe("Zoe Zed");
    });

    test("refuses a blank, a long, or an extra field, and needs a session and the dashboard", async () => {
      const user = await member();
      for (const body of [
        { name: "   " },
        { name: "x".repeat(201) },
        { name: { a: 1 } },
        {},
        "x",
      ]) {
        expect((await send(user.cookie, "PATCH", "/api/account", body)).statusCode).toBe(400);
      }
      // A field the route does not take is dropped, as on every route: the role stays.
      const extra = await send(user.cookie, "PATCH", "/api/account", { name: "A", role: "owner" });
      expect(extra.statusCode).toBe(200);
      expect((await send(user.cookie, "GET", "/api/me")).json().user.role).toBe("member");
      expect((await send(undefined, "PATCH", "/api/account", { name: "A" })).statusCode).toBe(401);
      expect(
        (
          await send(
            user.cookie,
            "PATCH",
            "/api/account",
            { name: "A" },
            { origin: "https://evil.example" },
          )
        ).statusCode,
      ).toBe(403);
    });

    test("Better Auth's own routes for the account are off", async () => {
      const user = await member();
      for (const [path, body] of [
        ["/api/auth/update-user", { name: "Mallory" }],
        ["/api/auth/change-email", { newEmail: "x@example.com" }],
        [
          "/api/auth/change-password",
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false },
        ],
      ] as const) {
        expect((await send(user.cookie, "POST", path, body)).statusCode).toBe(404);
      }
    });
  });

  describe("the email", () => {
    test("changes at once with the password; sign-in takes the new one, sessions and role stay", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const before = await sessionsOf(user.userId);
      const response = await send(user.cookie, "POST", "/api/account/email", {
        email: " Zoe.New@Example.com ",
        password: PASSWORD,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.email).toBe("zoe.new@example.com");

      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(401);
      expect((await signIn("zoe.new@example.com", PASSWORD)).statusCode).toBe(200);
      expect((await signIn("ZOE.NEW@example.com", PASSWORD)).statusCode).toBe(200);

      // Both earlier sessions still work, and show the new address.
      for (const cookie of [user.cookie, second]) {
        expect((await send(cookie, "GET", "/api/me")).json().user).toMatchObject({
          email: "zoe.new@example.com",
          role: "member",
        });
      }
      const after = await sessionsOf(user.userId);
      expect(after.map((row) => row.id)).toEqual(
        expect.arrayContaining(before.map((row) => row.id)),
      );
      const me = (await send(user.cookie, "GET", "/api/me")).json();
      expect(me.access.areas).toEqual(PRESETS.viewer);
    });

    test("needs the right password every time", async () => {
      const user = await member();
      const wrong = await send(user.cookie, "POST", "/api/account/email", {
        email: "wrong-pass@example.com",
        password: "not my password",
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ error: "wrong_password" });
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(200);
      // A session alone is not enough, however recently signed in.
      const missing = await send(user.cookie, "POST", "/api/account/email", {
        email: "no-pass@example.com",
      });
      expect(missing.statusCode).toBe(400);
    });

    test("cannot take an address another account uses, in any case", async () => {
      const user = await member();
      for (const email of [OWNER.email, OWNER.email.toUpperCase()]) {
        const response = await send(user.cookie, "POST", "/api/account/email", {
          email,
          password: PASSWORD,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "email_in_use" });
      }
      expect((await signIn(OWNER.email, OWNER.password)).statusCode).toBe(200);
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(200);
    });

    test("refuses an address sign-in would refuse, the same address, and malformed bodies", async () => {
      const user = await member();
      const refuse = async (body: unknown, status: number, error?: string) => {
        const response = await send(user.cookie, "POST", "/api/account/email", body);
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject(error === undefined ? {} : { error });
      };
      await refuse({ email: "ops!alerts@example.com", password: PASSWORD }, 400, "invalid_email");
      await refuse({ email: "not-an-email", password: PASSWORD }, 400, "invalid_email");
      await refuse({ email: user.email.toUpperCase(), password: PASSWORD }, 400, "same_email");
      await refuse({ email: `${"a".repeat(320)}@example.com`, password: PASSWORD }, 400);
      await refuse({ email: "x@example.com", password: "p".repeat(129) }, 400);
      await refuse({ email: { a: 1 }, password: PASSWORD }, 400);
      await refuse({ password: PASSWORD }, 400);
      await refuse("not json", 400);
      expect(
        (
          await send(undefined, "POST", "/api/account/email", {
            email: "x@example.com",
            password: PASSWORD,
          })
        ).statusCode,
      ).toBe(401);
    });

    test("limits password tries per user", async () => {
      const user = await member();
      const other = await member();
      for (let i = 0; i < 3; i += 1) {
        expect((await attemptEmail(user.cookie, "wrong password")).statusCode).toBe(403);
      }
      const refused = await attemptEmail(user.cookie, PASSWORD);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      // Another user has their own tries.
      expect((await attemptEmail(other.cookie, PASSWORD)).statusCode).toBe(200);
    });
  });

  describe("the password", () => {
    test("changes with the current one, keeping other sessions when asked", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const response = await change(user.cookie, {});
      expect(response.statusCode).toBe(204);
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(401);
      expect((await signIn(user.email, NEW_PASSWORD)).statusCode).toBe(200);
      expect((await send(second, "GET", "/api/me")).statusCode).toBe(200);
      expect((await send(user.cookie, "GET", "/api/me")).statusCode).toBe(200);
    });

    test("signs out the other devices, and this one carries on in a new session", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const response = await change(user.cookie, { revokeOtherSessions: true });
      expect(response.statusCode).toBe(204);
      const renewed = cookieOf(response);
      expect(renewed).not.toBe("");
      expect((await send(second, "GET", "/api/me")).statusCode).toBe(401);
      expect((await send(user.cookie, "GET", "/api/me")).statusCode).toBe(401);
      expect((await send(renewed, "GET", "/api/me")).statusCode).toBe(200);
      const rows = await sessionsOf(user.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ip_address).toBeNull();
    });

    test("refuses a wrong current password, a mismatch, a short one, and malformed bodies", async () => {
      const user = await member();
      const wrong = await change(user.cookie, { currentPassword: "not my password" });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ error: "wrong_password" });
      const differ = await change(user.cookie, { confirmPassword: "something else entirely" });
      expect(differ.statusCode).toBe(400);
      expect(differ.json()).toMatchObject({ error: "passwords_differ" });
      for (const body of [
        { password: "short", confirmPassword: "short" },
        { password: "p".repeat(129), confirmPassword: "p".repeat(129) },
        { revokeOtherSessions: "yes" },
        { currentPassword: "" },
      ]) {
        expect((await change(user.cookie, body)).statusCode).toBe(400);
      }
      expect(
        (
          await send(user.cookie, "POST", "/api/account/password", {
            password: NEW_PASSWORD,
            confirmPassword: NEW_PASSWORD,
            revokeOtherSessions: false,
          })
        ).statusCode,
      ).toBe(400);
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(200);
    });

    test("limits tries per user", async () => {
      const user = await member();
      for (let i = 0; i < 3; i += 1) {
        expect((await change(user.cookie, { currentPassword: "wrong password" })).statusCode).toBe(
          403,
        );
      }
      expect((await change(user.cookie, {})).statusCode).toBe(429);
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(200);
    });
  });

  describe("sessions", () => {
    test("lists only the user's own, with the browser but no address, and revokes one or the others", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const third = cookieOf(await signIn(user.email, PASSWORD));
      const other = await member();

      const listed = await send(user.cookie, "GET", "/api/auth/list-sessions");
      expect(listed.statusCode).toBe(200);
      const sessions: { token: string; userId: string; userAgent: string; ipAddress: unknown }[] =
        listed.json();
      expect(sessions).toHaveLength(3);
      for (const session of sessions) {
        expect(session.userId).toBe(user.userId);
        expect(session.ipAddress ?? null).toBeNull();
      }
      // The browser's User-Agent, as sent at sign-in.
      expect(sessions.filter((session) => session.userAgent === UA)).toHaveLength(2);

      // Another user's token revokes nothing.
      const theirs: { token: string }[] = (
        await send(other.cookie, "GET", "/api/auth/list-sessions")
      ).json();
      await send(user.cookie, "POST", "/api/auth/revoke-session", { token: theirs[0]?.token });
      expect((await send(other.cookie, "GET", "/api/me")).statusCode).toBe(200);

      const current = (await send(user.cookie, "GET", "/api/auth/get-session")).json().session
        .token;
      const target = sessions.find((session) => session.token !== current);
      expect(
        (await send(user.cookie, "POST", "/api/auth/revoke-session", { token: target?.token }))
          .statusCode,
      ).toBe(200);
      expect(await sessionsOf(user.userId)).toHaveLength(2);

      expect(
        (await send(user.cookie, "POST", "/api/auth/revoke-other-sessions", {})).statusCode,
      ).toBe(200);
      expect((await send(second, "GET", "/api/me")).statusCode).toBe(401);
      expect((await send(third, "GET", "/api/me")).statusCode).toBe(401);
      expect((await send(user.cookie, "GET", "/api/me")).statusCode).toBe(200);
    });

    test("a revoked session ends the heatmap overlay links made in it", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const project = (
        await send(dashboard.cookie, "POST", "/api/projects", { name: "Overlay site" })
      ).json().project;
      const minted = await send(
        second,
        "POST",
        `/api/projects/${project.id}/heatmaps/overlay-link`,
      );
      expect(minted.statusCode).toBe(200);
      const count = async () =>
        (
          await dashboard.db
            .selectFrom("heatmap_overlay_tokens")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("user_id", "=", user.userId)
            .executeTakeFirstOrThrow()
        ).n;
      expect(Number(await count())).toBe(1);
      await send(user.cookie, "POST", "/api/auth/revoke-other-sessions", {});
      expect(Number(await count())).toBe(0);
    });
  });
});
