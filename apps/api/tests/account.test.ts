import { betterAuth } from "better-auth";
import { sql } from "kysely";
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

  type Listed = {
    id: string;
    createdAt: string;
    lastActiveAt: string;
    userAgent: string | null;
    current: boolean;
  };
  const listOf = async (cookie: string): Promise<Listed[]> => {
    const response = await send(cookie, "GET", "/api/account/sessions");
    expect(response.statusCode).toBe(200);
    return response.json().sessions;
  };

  const sessionsOf = (userId: string) =>
    dashboard.db
      .selectFrom("dashboard_sessions")
      .select(["id", "user_agent", "ip_address"])
      .where("user_id", "=", userId)
      .execute();

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      passwordTryLimit: { capacity: 3, refillPerSecond: 1 / 600 },
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
      // Nor by another spelling of the path.
      for (const path of [
        "/api/auth/update-user/",
        "/api/auth/Update-User",
        "/api/auth/UPDATE-USER/",
        "/api/auth/change-password/",
        "/api/auth/Change-Password",
        "/api/auth/change-email/",
        "/api/auth/CHANGE-EMAIL",
      ]) {
        const response = await send(user.cookie, "POST", path, {
          name: "Mallory",
          newEmail: "mallory@example.com",
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        });
        expect([path, response.statusCode]).toEqual([path, 404]);
      }
      // Deleting the account or unlinking its password, which Ottertrail does not offer.
      for (const [method, path, body] of [
        ["POST", "/api/auth/delete-user", { password: PASSWORD }],
        ["GET", "/api/auth/delete-user/callback", undefined],
        ["POST", "/api/auth/unlink-account", { providerId: "credential" }],
        ["POST", "/api/auth/Delete-User/", { password: PASSWORD }],
      ] as const) {
        expect([path, (await send(user.cookie, method, path, body)).statusCode]).toEqual([
          path,
          404,
        ]);
      }
      // Still refused were deleting accounts ever turned on in Better Auth.
      const withDelete = betterAuth({
        ...dashboard.auth.options,
        user: { ...dashboard.auth.options.user, deleteUser: { enabled: true } },
      });
      for (const path of ["/api/auth/delete-user", "/api/auth/unlink-account"]) {
        const response = await withDelete.handler(
          new Request(`${PUBLIC_URL}${path}`, {
            method: "POST",
            headers: {
              cookie: user.cookie,
              origin: PUBLIC_URL,
              "content-type": "application/json",
            },
            body: JSON.stringify({ password: PASSWORD, providerId: "credential" }),
          }),
        );
        expect([path, response.status]).toEqual([path, 404]);
      }
      const row = await dashboard.db
        .selectFrom("dashboard_users")
        .select(["name", "email"])
        .where("id", "=", user.userId)
        .executeTakeFirst();
      expect(row).toEqual({ name: expect.stringMatching(/^Member /), email: user.email });
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(200);
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

    test("cannot take an address with a pending invitation, which then still works", async () => {
      const user = await member();
      const invited = await send(dashboard.cookie, "POST", "/api/invitations", {
        email: "cto@acme.example",
        role: "admin",
      });
      expect(invited.statusCode).toBe(201);
      for (const email of ["cto@acme.example", "CTO@Acme.example"]) {
        const response = await send(user.cookie, "POST", "/api/account/email", {
          email,
          password: PASSWORD,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "email_invited" });
      }
      expect((await signIn(user.email, PASSWORD)).statusCode).toBe(200);

      const token = new URL(invited.json().url).hash.replace(/^#token=/, "");
      const accepted = await send(undefined, "POST", "/api/invite/accept", {
        token,
        name: "The CTO",
        password: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      expect(accepted.statusCode).toBeLessThan(300);
      expect((await signIn("cto@acme.example", NEW_PASSWORD)).statusCode).toBe(200);
    });

    test("an invitation whose address an account takes during accepting answers as a used link", async () => {
      const invited = await send(dashboard.cookie, "POST", "/api/invitations", {
        email: "racer@acme.example",
        role: "member",
        access: { projects: "all", areas: PRESETS.viewer },
      });
      const token = new URL(invited.json().url).hash.replace(/^#token=/, "");
      // Another transaction holds an uncommitted account with the address: accepting
      // does not see it, then waits on the unique index, then hits it.
      let accepting: ReturnType<typeof send> | undefined;
      await dashboard.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("dashboard_users")
          .values({ name: "Racer", email: "racer@acme.example", role: "member" })
          .execute();
        accepting = send(undefined, "POST", "/api/invite/accept", {
          token,
          name: "Invitee",
          password: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      const response = await accepting;
      expect(response?.statusCode).toBe(404);
      expect(response?.json()).toMatchObject({ error: "invalid_link" });
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
    test("lists the user's own, with the browser, no address and no token, old ones too", async () => {
      const user = await member();
      cookieOf(await signIn(user.email, PASSWORD));
      cookieOf(await signIn(user.email, PASSWORD));
      await member();
      // A session signed in three days ago, which Better Auth's "fresh" rule would refuse to list from.
      const old = new Date(Date.now() - 3 * 86_400_000);
      // created_at is never updated by the app; the test moves it back by hand.
      await sql`update dashboard_sessions set created_at = ${old}, updated_at = ${old}
        where user_id = ${user.userId}`.execute(dashboard.db);

      const response = await send(user.cookie, "GET", "/api/account/sessions");
      expect(response.body).not.toMatch(/token/i);
      const sessions: Listed[] = response.json().sessions;
      expect(sessions).toHaveLength(3);
      const rows = await sessionsOf(user.userId);
      expect(sessions.map((session) => session.id).toSorted()).toEqual(
        rows.map((row) => row.id).toSorted(),
      );
      expect(sessions.filter((session) => session.current)).toHaveLength(1);
      expect(sessions.filter((session) => session.userAgent === UA)).toHaveLength(2);
      for (const session of sessions) {
        expect(Object.keys(session).toSorted()).toEqual([
          "createdAt",
          "current",
          "id",
          "lastActiveAt",
          "userAgent",
        ]);
        expect(new Date(session.createdAt).getTime()).toBe(old.getTime());
      }
      expect((await send(undefined, "GET", "/api/account/sessions")).statusCode).toBe(401);
    });

    test("signs out one other session, never another user's, and not this one", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const other = await member();
      const sessions = await listOf(user.cookie);
      const current = sessions.find((session) => session.current);
      const target = sessions.find((session) => !session.current);
      const theirs = (await listOf(other.cookie))[0];

      // Another user's session ID deletes nothing.
      const foreign = await send(user.cookie, "DELETE", `/api/account/sessions/${theirs?.id}`);
      expect(foreign.statusCode).toBe(404);
      expect((await send(other.cookie, "GET", "/api/me")).statusCode).toBe(200);

      // This session is ended by signing out, not here.
      const own = await send(user.cookie, "DELETE", `/api/account/sessions/${current?.id}`);
      expect(own.statusCode).toBe(400);
      expect(own.json()).toMatchObject({ error: "current_session" });
      expect((await send(user.cookie, "GET", "/api/me")).statusCode).toBe(200);

      expect(
        (await send(user.cookie, "DELETE", "/api/account/sessions/not-an-id")).statusCode,
      ).toBe(400);
      // From the dashboard only.
      expect(
        (
          await send(user.cookie, "DELETE", `/api/account/sessions/${target?.id}`, undefined, {
            origin: "https://evil.example",
          })
        ).statusCode,
      ).toBe(403);
      expect((await send(second, "GET", "/api/me")).statusCode).toBe(200);

      expect(
        (await send(user.cookie, "DELETE", `/api/account/sessions/${target?.id}`)).statusCode,
      ).toBe(204);
      expect((await send(second, "GET", "/api/me")).statusCode).toBe(401);
      expect(await sessionsOf(user.userId)).toHaveLength(1);
    });

    test("signs out every other session, and only the user's", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const third = cookieOf(await signIn(user.email, PASSWORD));
      const other = await member();
      const response = await send(user.cookie, "DELETE", "/api/account/sessions");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ signedOut: 2 });
      expect((await send(second, "GET", "/api/me")).statusCode).toBe(401);
      expect((await send(third, "GET", "/api/me")).statusCode).toBe(401);
      expect((await send(user.cookie, "GET", "/api/me")).statusCode).toBe(200);
      expect((await send(other.cookie, "GET", "/api/me")).statusCode).toBe(200);
    });

    test("a revoked session ends the heatmap overlay links made in it", async () => {
      const user = await member();
      const second = cookieOf(await signIn(user.email, PASSWORD));
      const project = (
        await send(dashboard.cookie, "POST", "/api/projects", { name: "Overlay site" })
      ).json().project;
      const count = async () =>
        Number(
          (
            await dashboard.db
              .selectFrom("heatmap_overlay_tokens")
              .select((eb) => eb.fn.countAll<string>().as("n"))
              .where("user_id", "=", user.userId)
              .executeTakeFirstOrThrow()
          ).n,
        );
      const mint = (cookie: string) =>
        send(cookie, "POST", `/api/projects/${project.id}/heatmaps/overlay-link`);
      expect((await mint(second)).statusCode).toBe(200);
      expect(await count()).toBe(1);
      const target = (await listOf(user.cookie)).find((session) => !session.current);
      await send(user.cookie, "DELETE", `/api/account/sessions/${target?.id}`);
      expect(await count()).toBe(0);

      const third = cookieOf(await signIn(user.email, PASSWORD));
      expect((await mint(third)).statusCode).toBe(200);
      await send(user.cookie, "DELETE", "/api/account/sessions");
      expect(await count()).toBe(0);
    });
  });

  test("one bucket of password tries per user, across email, password and ownership", async () => {
    // The owner: only the owner hands over ownership. Last, as it spends the owner's tries.
    const heir = await member();
    const owner = dashboard.cookie;
    expect((await attemptEmail(owner, "wrong password")).statusCode).toBe(403);
    expect((await change(owner, { currentPassword: "wrong password" })).statusCode).toBe(403);
    const ownership = await send(owner, "POST", `/api/members/${heir.userId}/ownership`, {
      password: "wrong password",
    });
    expect(ownership.statusCode).toBe(403);
    // Three tries, one on each route: none is left on any of them.
    expect((await attemptEmail(owner, OWNER.password)).statusCode).toBe(429);
    expect((await change(owner, { currentPassword: OWNER.password })).statusCode).toBe(429);
    expect(
      (
        await send(owner, "POST", `/api/members/${heir.userId}/ownership`, {
          password: OWNER.password,
        })
      ).statusCode,
    ).toBe(429);
  });
});
