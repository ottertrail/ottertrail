import type { Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { ALL_AREAS, PRESETS } from "../src/access/areas.ts";
import { INVITATION_TTL_MS } from "../src/access/invitations.ts";
import { createPasswordReset, RESET_LINK_TTL_MS } from "../src/access/password-resets.ts";
import { hashToken } from "../src/auth/tokens.ts";
import type { Database } from "../src/db/schema.ts";
import { OWNER, PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
};
const INVITATION_GONE = {
  error: "invalid_link",
  message: "This invitation link no longer works. Ask for a new one.",
};
const RESET_GONE = {
  error: "invalid_link",
  message: "This reset link no longer works. Ask for a new one.",
};
const PASSWORD = "a long new password";

const viewer = (projects: "all" | string[] = "all") => ({
  role: "member",
  access: { projects, areas: { ...PRESETS.viewer } },
});

const promote = (userId: string) => (trx: Transaction<Database>) =>
  trx.updateTable("dashboard_users").set({ role: "admin" }).where("id", "=", userId).execute();

const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, "");

describe("members, invitations, reset links, and ownership", () => {
  let dashboard: Dashboard;
  let site: { id: string };
  let admin: { userId: string; cookie: string };
  let counter = 0;

  function send(cookie: string | undefined, method: string, url: string, payload?: object) {
    return dashboard.app.inject({
      method: method as "GET",
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        origin: PUBLIC_URL,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  const signIn = (email: string, password: string) =>
    dashboard.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: PUBLIC_URL, "content-type": "application/json" },
      payload: JSON.stringify({ email, password }),
    });

  async function invite(cookie: string, email: string, body: object = viewer()) {
    return send(cookie, "POST", "/api/invitations", { email, ...body });
  }

  /** A member made through the database, signed in. */
  async function member(name = `member-${(counter += 1)}`) {
    return signedInUser(dashboard, {
      name,
      email: `${name}@example.com`,
      grants: { projects: "all", areas: PRESETS.viewer },
    });
  }

  beforeAll(async () => {
    dashboard = await signedInDashboard();
    site = (await send(dashboard.cookie, "POST", "/api/projects", { name: "Some site" })).json()
      .project;
    admin = await signedInUser(dashboard, {
      name: "Ada Admin",
      email: "admin@example.com",
      role: "admin",
    });
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  describe("invitations", () => {
    test("give a link to copy, valid 7 days, its token kept only as a hash", async () => {
      const before = Date.now();
      const response = await invite(dashboard.cookie, "  Jane@Example.com ", viewer([site.id]));
      expect(response.statusCode).toBe(201);
      const { invitation, url } = response.json();
      expect(url).toMatch(new RegExp(`^${PUBLIC_URL}/invite#token=[A-Za-z0-9_-]{43}$`));
      expect(invitation).toMatchObject({
        email: "jane@example.com",
        role: "member",
        access: { projects: [site.id], areas: PRESETS.viewer },
        invitedBy: { name: OWNER.name },
      });
      const expires = new Date(invitation.expiresAt).getTime();
      expect(expires - before).toBeGreaterThanOrEqual(INVITATION_TTL_MS - 1000);
      expect(expires - before).toBeLessThanOrEqual(INVITATION_TTL_MS + 5000);
      const row = await dashboard.db
        .selectFrom("dashboard_invitations")
        .select("token_hash")
        .where("email", "=", "jane@example.com")
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toEqual(hashToken(tokenOf(url)));
      const listed = (await send(dashboard.cookie, "GET", "/api/members")).json();
      expect(listed.invitations.map((item: { email: string }) => item.email)).toContain(
        "jane@example.com",
      );
      expect(JSON.stringify(listed)).not.toContain(tokenOf(url));
    });

    test("only the owner invites admins; members cannot invite at all", async () => {
      expect(
        (await invite(admin.cookie, "new-admin@example.com", { role: "admin" })).json(),
      ).toEqual(FORBIDDEN);
      const byAdmin = await invite(admin.cookie, "by-admin@example.com");
      expect(byAdmin.statusCode).toBe(201);
      // "all" stays all projects, including those created later.
      expect(byAdmin.json().invitation.access.projects).toBe("all");
      expect(
        (await invite(dashboard.cookie, "by-owner@example.com", { role: "admin" })).statusCode,
      ).toBe(201);
      const plain = await member();
      expect((await invite(plain.cookie, "by-member@example.com")).json()).toEqual(FORBIDDEN);
    });

    test("refuse an email with an account, a bad email, and a member without access", async () => {
      expect((await invite(dashboard.cookie, "ADMIN@example.com")).json()).toMatchObject({
        error: "account_exists",
      });
      expect((await invite(dashboard.cookie, "ops!alerts@example.com")).json()).toMatchObject({
        error: "invalid_email",
      });
      expect(
        (await invite(dashboard.cookie, "no-access@example.com", { role: "member" })).json(),
      ).toMatchObject({ error: "access_required" });
      // A level an area does not take.
      expect(
        (
          await invite(dashboard.cookie, "bad-level@example.com", {
            role: "member",
            access: { projects: "all", areas: { ...ALL_AREAS, monitoring: "manage" } },
          })
        ).statusCode,
      ).toBe(400);
    });

    test("inviting a pending email again replaces the invitation and its link", async () => {
      const first = tokenOf((await invite(dashboard.cookie, "twice@example.com")).json().url);
      const second = tokenOf(
        (await invite(admin.cookie, "twice@example.com", viewer([site.id]))).json().url,
      );
      expect(
        (await send(undefined, "POST", "/api/invite/preview", { token: first })).json(),
      ).toEqual(INVITATION_GONE);
      const preview = await send(undefined, "POST", "/api/invite/preview", { token: second });
      expect(preview.json()).toEqual({
        // Who invited whom, and to what: no role, areas, or project names.
        invitation: {
          email: "twice@example.com",
          invitedBy: "Ada Admin",
          instanceName: OWNER.instanceName,
        },
      });
      const rows = await dashboard.db
        .selectFrom("dashboard_invitations")
        .select("id")
        .where("email", "=", "twice@example.com")
        .execute();
      expect(rows).toHaveLength(1);
    });

    test("accepting creates the account, its grants without deleted projects, and lets it sign in", async () => {
      const doomed = (
        await send(dashboard.cookie, "POST", "/api/projects", { name: "Doomed" })
      ).json().project;
      const token = tokenOf(
        (await invite(dashboard.cookie, "joe@example.com", viewer([site.id, doomed.id]))).json()
          .url,
      );
      await send(dashboard.cookie, "DELETE", `/api/projects/${doomed.id}`, {
        confirmName: "Doomed",
      });
      // A confirmation that differs saves nothing: the link still works.
      const mismatch = await send(undefined, "POST", "/api/invite/accept", {
        token,
        name: "Joe",
        password: PASSWORD,
        confirmPassword: `${PASSWORD}!`,
      });
      expect(mismatch.json()).toMatchObject({ error: "passwords_differ" });
      expect((await send(undefined, "POST", "/api/invite/preview", { token })).statusCode).toBe(
        200,
      );

      const body = { token, name: " Joe ", password: PASSWORD, confirmPassword: PASSWORD };
      // A double submit, or a second tab: one account, the other "no longer works".
      const answers = await Promise.all([
        send(undefined, "POST", "/api/invite/accept", body),
        send(undefined, "POST", "/api/invite/accept", body),
      ]);
      expect(answers.map((answer) => answer.statusCode).toSorted((a, b) => a - b)).toEqual([
        201, 404,
      ]);
      expect(answers.find((answer) => answer.statusCode === 404)?.json()).toEqual(INVITATION_GONE);

      const user = await dashboard.db
        .selectFrom("dashboard_users")
        .select(["id", "name", "role"])
        .where("email", "=", "joe@example.com")
        .executeTakeFirstOrThrow();
      expect(user).toMatchObject({ name: "Joe", role: "member" });
      const projects = await dashboard.db
        .selectFrom("dashboard_member_projects")
        .select("project_id")
        .where("user_id", "=", user.id)
        .execute();
      expect(projects).toEqual([{ project_id: site.id }]);
      const signedIn = await signIn("joe@example.com", PASSWORD);
      expect(signedIn.statusCode).toBe(200);
      const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      expect((await send(cookie, "GET", "/api/me")).json().access).toEqual({
        projects: [site.id],
        areas: PRESETS.viewer,
      });
      // Used: gone from the list, and the link no longer works.
      expect((await send(undefined, "POST", "/api/invite/accept", body)).json()).toEqual(
        INVITATION_GONE,
      );
    });

    test("an admin's invitation makes an admin", async () => {
      const token = tokenOf(
        (await invite(dashboard.cookie, "second-admin@example.com", { role: "admin" })).json().url,
      );
      expect(
        (
          await send(undefined, "POST", "/api/invite/accept", {
            token,
            name: "Second",
            password: PASSWORD,
            confirmPassword: PASSWORD,
          })
        ).statusCode,
      ).toBe(201);
      const user = await dashboard.db
        .selectFrom("dashboard_users")
        .select("role")
        .where("email", "=", "second-admin@example.com")
        .executeTakeFirstOrThrow();
      expect(user.role).toBe("admin");
    });

    test("unknown, expired, revoked, and replaced links all get one message", async () => {
      const revoked = (await invite(dashboard.cookie, "revoked@example.com")).json();
      expect(
        (await send(dashboard.cookie, "DELETE", `/api/invitations/${revoked.invitation.id}`))
          .statusCode,
      ).toBe(204);
      const renewed = (await invite(dashboard.cookie, "renewed@example.com")).json();
      const fresh = (
        await send(dashboard.cookie, "POST", `/api/invitations/${renewed.invitation.id}/link`)
      ).json();
      expect(tokenOf(fresh.url)).not.toBe(tokenOf(renewed.url));
      const expired = tokenOf((await invite(dashboard.cookie, "expired@example.com")).json().url);
      await dashboard.db
        .updateTable("dashboard_invitations")
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where("email", "=", "expired@example.com")
        .execute();
      for (const token of ["made-up", tokenOf(revoked.url), tokenOf(renewed.url), expired]) {
        for (const path of ["/api/invite/preview", "/api/invite/accept"]) {
          const response = await send(undefined, "POST", path, {
            token,
            ...(path.endsWith("accept")
              ? { name: "X", password: PASSWORD, confirmPassword: PASSWORD }
              : {}),
          });
          expect({ path, status: response.statusCode, body: response.json() }).toEqual({
            path,
            status: 404,
            body: INVITATION_GONE,
          });
        }
      }
      expect(
        (await send(undefined, "POST", "/api/invite/preview", { token: tokenOf(fresh.url) }))
          .statusCode,
      ).toBe(200);
    });

    test("an admin cannot revoke or renew an admin's invitation", async () => {
      const { invitation } = (
        await invite(dashboard.cookie, "admin-invite@example.com", { role: "admin" })
      ).json();
      expect(
        (await send(admin.cookie, "DELETE", `/api/invitations/${invitation.id}`)).json(),
      ).toEqual(FORBIDDEN);
      expect(
        (await send(admin.cookie, "POST", `/api/invitations/${invitation.id}/link`)).json(),
      ).toEqual(FORBIDDEN);
    });
  });

  describe("members", () => {
    test("the list holds everyone, the owner first, with members' access and last sign-in", async () => {
      const plain = await member("listed");
      const { members, you } = (await send(admin.cookie, "GET", "/api/members")).json();
      expect(you).toEqual({ id: admin.userId, role: "admin" });
      expect(members[0]).toMatchObject({ role: "owner", name: OWNER.name, access: null });
      expect(members.find((item: { id: string }) => item.id === plain.userId)).toMatchObject({
        name: "listed",
        email: "listed@example.com",
        role: "member",
        access: { projects: "all", areas: PRESETS.viewer },
        lastSignInAt: expect.any(String),
      });
      expect((await send(plain.cookie, "GET", "/api/members")).json()).toEqual(FORBIDDEN);
    });

    test("access changes within the role rules", async () => {
      const plain = await member();
      const other = await signedInUser(dashboard, {
        name: "Other Admin",
        email: "other-admin@example.com",
        role: "admin",
      });
      const owner = await dashboard.db
        .selectFrom("dashboard_users")
        .select("id")
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      const patch = (cookie: string, userId: string, body: object) =>
        send(cookie, "PATCH", `/api/members/${userId}`, body);
      // An admin changes members' access, but makes no admins and touches no admin or owner.
      expect((await patch(admin.cookie, plain.userId, viewer([site.id]))).statusCode).toBe(204);
      expect((await patch(admin.cookie, plain.userId, { role: "admin" })).json()).toEqual(
        FORBIDDEN,
      );
      expect((await patch(admin.cookie, other.userId, viewer())).json()).toEqual(FORBIDDEN);
      expect((await patch(admin.cookie, owner.id, viewer())).json()).toEqual(FORBIDDEN);
      expect((await patch(admin.cookie, admin.userId, viewer())).json()).toEqual(FORBIDDEN);
      // The owner promotes and demotes, but never changes themselves.
      expect((await patch(dashboard.cookie, owner.id, { role: "admin" })).json()).toEqual(
        FORBIDDEN,
      );
      expect((await patch(dashboard.cookie, plain.userId, { role: "admin" })).statusCode).toBe(204);
      expect((await send(plain.cookie, "GET", "/api/members")).statusCode).toBe(200);
      const grants = await dashboard.db
        .selectFrom("dashboard_member_access")
        .select("user_id")
        .where("user_id", "=", plain.userId)
        .execute();
      expect(grants).toEqual([]);

      // Demoting an admin revokes the invitations they made.
      expect((await invite(other.cookie, "from-other@example.com")).statusCode).toBe(201);
      expect((await patch(dashboard.cookie, other.userId, viewer())).statusCode).toBe(204);
      const left = await dashboard.db
        .selectFrom("dashboard_invitations")
        .select("id")
        .where("invited_by", "=", other.userId)
        .execute();
      expect(left).toEqual([]);
      expect((await send(other.cookie, "GET", "/api/members")).json()).toEqual(FORBIDDEN);
    });

    test("removing deletes the account and signs it out, and keeps what it did", async () => {
      const plain = await member();
      await dashboard.db
        .insertInto("error_resolutions")
        .values({
          project_id: site.id,
          fingerprint: "1-0123456789abcdef0123",
          resolved_by: plain.userId,
        })
        .execute();
      const owner = await dashboard.db
        .selectFrom("dashboard_users")
        .select("id")
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      expect((await send(admin.cookie, "DELETE", `/api/members/${owner.id}`)).json()).toEqual(
        FORBIDDEN,
      );
      expect((await send(dashboard.cookie, "DELETE", `/api/members/${owner.id}`)).json()).toEqual(
        FORBIDDEN,
      );
      expect((await send(admin.cookie, "DELETE", `/api/members/${plain.userId}`)).statusCode).toBe(
        204,
      );
      expect((await send(plain.cookie, "GET", "/api/me")).statusCode).toBe(401);
      expect(
        await dashboard.db
          .selectFrom("error_resolutions")
          .select("resolved_by")
          .where("fingerprint", "=", "1-0123456789abcdef0123")
          .execute(),
      ).toEqual([{ resolved_by: null }]);
      expect(
        (await send(admin.cookie, "DELETE", `/api/members/${plain.userId}`)).json(),
      ).toMatchObject({ error: "member_not_found" });
    });

    test("removing an admin removes their pending invitations", async () => {
      const other = await signedInUser(dashboard, {
        name: "Leaving Admin",
        email: "leaving@example.com",
        role: "admin",
      });
      const token = tokenOf((await invite(other.cookie, "from-leaving@example.com")).json().url);
      expect((await send(admin.cookie, "DELETE", `/api/members/${other.userId}`)).json()).toEqual(
        FORBIDDEN,
      );
      expect(
        (await send(dashboard.cookie, "DELETE", `/api/members/${other.userId}`)).statusCode,
      ).toBe(204);
      expect((await send(undefined, "POST", "/api/invite/preview", { token })).json()).toEqual(
        INVITATION_GONE,
      );
    });
  });

  describe("reset links", () => {
    test("admins reset members; the owner anyone else; the old password works until it is used", async () => {
      const plain = await member("resettable");
      const owner = await dashboard.db
        .selectFrom("dashboard_users")
        .select("id")
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      const link = (userId: string, cookie: string) =>
        send(cookie, "POST", `/api/members/${userId}/reset-link`);
      expect((await link(owner.id, admin.cookie)).json()).toEqual(FORBIDDEN);
      expect((await link(admin.userId, admin.cookie)).json()).toEqual(FORBIDDEN);
      expect((await link(admin.userId, dashboard.cookie)).statusCode).toBe(201);

      const first = (await link(plain.userId, admin.cookie)).json();
      expect(first.url).toMatch(new RegExp(`^${PUBLIC_URL}/reset-password#token=`));
      expect(new Date(first.expiresAt).getTime() - Date.now()).toBeGreaterThan(
        RESET_LINK_TTL_MS - 60_000,
      );
      // One per user: a new one replaces the old.
      const second = (await link(plain.userId, admin.cookie)).json();
      expect(
        (
          await send(undefined, "POST", "/api/reset-password/preview", {
            token: tokenOf(first.url),
          })
        ).json(),
      ).toEqual(RESET_GONE);
      const token = tokenOf(second.url);
      expect(
        (await send(undefined, "POST", "/api/reset-password/preview", { token })).json(),
      ).toEqual({ email: "resettable@example.com" });

      // Until it is used, nothing changes.
      expect((await send(plain.cookie, "GET", "/api/me")).statusCode).toBe(200);
      expect(
        (
          await send(undefined, "POST", "/api/reset-password", {
            token,
            password: PASSWORD,
            confirmPassword: "something else entirely",
          })
        ).json(),
      ).toMatchObject({ error: "passwords_differ" });
      expect((await signIn("resettable@example.com", "another correct horse")).statusCode).toBe(
        200,
      );

      const used = await send(undefined, "POST", "/api/reset-password", {
        token,
        password: PASSWORD,
        confirmPassword: PASSWORD,
      });
      expect(used.json()).toEqual({ email: "resettable@example.com" });
      expect((await send(plain.cookie, "GET", "/api/me")).statusCode).toBe(401);
      expect((await signIn("resettable@example.com", "another correct horse")).statusCode).toBe(
        401,
      );
      expect((await signIn("resettable@example.com", PASSWORD)).statusCode).toBe(200);
      expect(
        (
          await send(undefined, "POST", "/api/reset-password", {
            token,
            password: PASSWORD,
            confirmPassword: PASSWORD,
          })
        ).json(),
      ).toEqual(RESET_GONE);
    });

    test("an expired link no longer works", async () => {
      const plain = await member();
      const { token } = await createPasswordReset(dashboard.db, plain.userId, {
        madeBy: "command",
        ttlMs: 60_000,
        now: new Date(Date.now() - 120_000),
      });
      expect(
        (await send(undefined, "POST", "/api/reset-password/preview", { token })).json(),
      ).toEqual(RESET_GONE);
    });
  });

  /**
   * Starts `request` while `userId`'s row is locked, then makes `change` in
   * the locking transaction and commits: the order a race could take,
   * forced. The request's answer comes once the lock is gone.
   */
  async function raced<T>(
    userId: string,
    request: () => Promise<T>,
    change: (trx: Transaction<Database>) => Promise<unknown>,
  ): Promise<T> {
    let pending: Promise<T> | undefined;
    await dashboard.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("dashboard_users")
        .select("id")
        .where("id", "=", userId)
        .forUpdate()
        .execute();
      pending = request();
      // Long enough for the request to reach the lock (or, unlocked, to finish its read).
      await new Promise((resolve) => setTimeout(resolve, 400));
      await change(trx);
    });
    if (pending === undefined) throw new Error("The request did not start");
    return pending;
  }

  const resetToken = async (cookie: string, userId: string) =>
    tokenOf((await send(cookie, "POST", `/api/members/${userId}/reset-link`)).json().url);
  const usable = async (token: string) =>
    (await send(undefined, "POST", "/api/reset-password/preview", { token })).statusCode === 200;

  const ownerId = async () =>
    (
      await dashboard.db
        .selectFrom("dashboard_users")
        .select("id")
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow()
    ).id;

  describe("a role checked is the role acted on", () => {
    test("an admin cannot change, remove, or reset someone the owner is promoting", async () => {
      for (const act of [
        (userId: string) => send(admin.cookie, "PATCH", `/api/members/${userId}`, viewer()),
        (userId: string) => send(admin.cookie, "DELETE", `/api/members/${userId}`),
        (userId: string) => send(admin.cookie, "POST", `/api/members/${userId}/reset-link`),
      ]) {
        const target = await member();
        const answer = await raced(target.userId, () => act(target.userId), promote(target.userId));
        expect(answer.json()).toEqual(FORBIDDEN);
        const row = await dashboard.db
          .selectFrom("dashboard_users")
          .select("role")
          .where("id", "=", target.userId)
          .executeTakeFirst();
        expect(row).toEqual({ role: "admin" });
        expect(
          await dashboard.db
            .selectFrom("dashboard_password_resets")
            .select("user_id")
            .where("user_id", "=", target.userId)
            .execute(),
        ).toEqual([]);
      }
    });

    test("a handover racing the heir's removal leaves the owner in place", async () => {
      const heir = await member("vanishing-heir");
      const owner = await ownerId();
      const answer = await raced(
        heir.userId,
        () =>
          send(dashboard.cookie, "POST", `/api/members/${heir.userId}/ownership`, {
            password: OWNER.password,
          }),
        (trx) => trx.deleteFrom("dashboard_users").where("id", "=", heir.userId).execute(),
      );
      expect(answer.statusCode).toBe(404);
      expect(await ownerId()).toBe(owner);
    });
  });

  describe("links outlive no right", () => {
    test("an admin's link for a member dies when the member is promoted, so cannot take the ownership over", async () => {
      const target = await member("future-owner");
      const token = await resetToken(admin.cookie, target.userId);
      expect(await usable(token)).toBe(true);
      expect(
        (await send(dashboard.cookie, "PATCH", `/api/members/${target.userId}`, { role: "admin" }))
          .statusCode,
      ).toBe(204);
      expect(await usable(token)).toBe(false);
      expect(
        (
          await send(dashboard.cookie, "POST", `/api/members/${target.userId}/ownership`, {
            password: OWNER.password,
          })
        ).statusCode,
      ).toBe(204);
      const used = await send(undefined, "POST", "/api/reset-password", {
        token,
        password: PASSWORD,
        confirmPassword: PASSWORD,
      });
      expect(used.json()).toEqual(RESET_GONE);
      // Back, so the other tests keep their owner.
      const heirIn = await signIn("future-owner@example.com", "another correct horse");
      const heirCookie = heirIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const owner = await dashboard.db
        .selectFrom("dashboard_users")
        .select("id")
        .where("email", "=", OWNER.email.toLowerCase())
        .executeTakeFirstOrThrow();
      expect(
        (
          await send(heirCookie, "POST", `/api/members/${owner.id}/ownership`, {
            password: "another correct horse",
          })
        ).statusCode,
      ).toBe(204);
    });

    test("a removed or demoted admin's links die with their right", async () => {
      for (const [index, end] of [
        (userId: string) => send(dashboard.cookie, "DELETE", `/api/members/${userId}`),
        (userId: string) => send(dashboard.cookie, "PATCH", `/api/members/${userId}`, viewer()),
      ].entries()) {
        const maker = await signedInUser(dashboard, {
          name: `Maker ${index}`,
          email: `maker-${index}@example.com`,
          role: "admin",
        });
        const target = await member();
        const reset = await resetToken(maker.cookie, target.userId);
        const invited = tokenOf(
          (await invite(maker.cookie, `invited-${index}@example.com`)).json().url,
        );
        expect((await end(maker.userId)).statusCode).toBe(204);
        expect(await usable(reset)).toBe(false);
        expect(
          (await send(undefined, "POST", "/api/invite/preview", { token: invited })).json(),
        ).toEqual(INVITATION_GONE);
      }
    });

    test("using a link checks again that its maker may reset the user as they are now", async () => {
      // As if a link had survived: an admin's link for the owner, stored directly.
      const owner = await ownerId();
      const { token } = await createPasswordReset(dashboard.db, owner, {
        madeBy: { userId: admin.userId },
        ttlMs: RESET_LINK_TTL_MS,
        now: new Date(),
      });
      const used = await send(undefined, "POST", "/api/reset-password", {
        token,
        password: PASSWORD,
        confirmPassword: PASSWORD,
      });
      expect(used.json()).toEqual(RESET_GONE);
      expect((await signIn(OWNER.email, OWNER.password)).statusCode).toBe(200);
      // The server's command may reset anyone, the owner included.
      const command = await createPasswordReset(dashboard.db, owner, {
        madeBy: "command",
        ttlMs: RESET_LINK_TTL_MS,
        now: new Date(),
      });
      expect(await usable(command.token)).toBe(true);
      await dashboard.db
        .deleteFrom("dashboard_password_resets")
        .where("user_id", "=", owner)
        .execute();
    });

    test("an invitation needs its inviter's right when it is accepted", async () => {
      const inviter = await signedInUser(dashboard, {
        name: "Inviting Admin",
        email: "inviting-admin@example.com",
        role: "admin",
      });
      const token = tokenOf((await invite(inviter.cookie, "late@example.com")).json().url);
      // Demoted without the cleanup the Members page does, as a race could leave it.
      await dashboard.db
        .updateTable("dashboard_users")
        .set({ role: "member" })
        .where("id", "=", inviter.userId)
        .execute();
      const accepted = await send(undefined, "POST", "/api/invite/accept", {
        token,
        name: "Late",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      });
      expect(accepted.json()).toEqual(INVITATION_GONE);
      expect(
        await dashboard.db
          .selectFrom("dashboard_users")
          .select("id")
          .where("email", "=", "late@example.com")
          .execute(),
      ).toEqual([]);
    });

    test("an admin cannot replace the owner's admin invitation by inviting again", async () => {
      const token = tokenOf(
        (await invite(dashboard.cookie, "boss@example.com", { role: "admin" })).json().url,
      );
      expect((await invite(admin.cookie, "boss@example.com")).json()).toEqual(FORBIDDEN);
      // The owner's link still works, and still makes an admin.
      expect(
        (await send(undefined, "POST", "/api/invite/preview", { token })).json().invitation,
      ).toMatchObject({ email: "boss@example.com" });
      const row = await dashboard.db
        .selectFrom("dashboard_invitations")
        .select("role")
        .where("email", "=", "boss@example.com")
        .executeTakeFirstOrThrow();
      expect(row.role).toBe("admin");
    });

    test("a handover revokes the old owner's pending admin invitations", async () => {
      const token = tokenOf(
        (await invite(dashboard.cookie, "admin-to-be@example.com", { role: "admin" })).json().url,
      );
      const heir = await member("short-heir");
      const owner = await ownerId();
      expect(
        (
          await send(dashboard.cookie, "POST", `/api/members/${heir.userId}/ownership`, {
            password: OWNER.password,
          })
        ).statusCode,
      ).toBe(204);
      expect((await send(undefined, "POST", "/api/invite/preview", { token })).json()).toEqual(
        INVITATION_GONE,
      );
      expect(
        (
          await send(heir.cookie, "POST", `/api/members/${owner}/ownership`, {
            password: "another correct horse",
          })
        ).statusCode,
      ).toBe(204);
    });
  });

  describe("ownership", () => {
    test("goes to another user after the owner's password; the old owner becomes an admin", async () => {
      const heir = await member("heir");
      const owner = await dashboard.db
        .selectFrom("dashboard_users")
        .select("id")
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      const hand = (cookie: string, password: string) =>
        send(cookie, "POST", `/api/members/${heir.userId}/ownership`, { password });
      expect((await hand(admin.cookie, OWNER.password)).json()).toEqual(FORBIDDEN);
      expect((await hand(dashboard.cookie, "not the password")).json()).toMatchObject({
        error: "wrong_password",
      });
      expect((await hand(dashboard.cookie, OWNER.password)).statusCode).toBe(204);

      const roles = await dashboard.db
        .selectFrom("dashboard_users")
        .select(["id", "role"])
        .where("id", "in", [owner.id, heir.userId])
        .execute();
      expect(Object.fromEntries(roles.map((row) => [row.id, row.role]))).toEqual({
        [owner.id]: "admin",
        [heir.userId]: "owner",
      });
      expect((await send(heir.cookie, "GET", "/api/me")).json().access).toEqual({
        projects: "all",
        areas: ALL_AREAS,
      });
      expect((await send(dashboard.cookie, "GET", "/api/settings")).json()).toEqual(FORBIDDEN);
      // And back, so the other tests keep their owner.
      expect(
        (
          await send(heir.cookie, "POST", `/api/members/${owner.id}/ownership`, {
            password: "another correct horse",
          })
        ).statusCode,
      ).toBe(204);
    });
  });
});

describe("the links' rate limit", () => {
  let dashboard: Dashboard;
  beforeAll(async () => {
    dashboard = await signedInDashboard({ linkLimit: { capacity: 2, refillPerSecond: 0.001 } });
  });
  afterAll(async () => {
    await dashboard?.close();
  });

  const attempt = (url: string, remoteAddress: string) =>
    dashboard.app.inject({
      method: "POST",
      url,
      payload: { token: "made-up" },
      remoteAddress,
    });

  test("limits attempts per client address, across invitations and reset links", async () => {
    expect((await attempt("/api/invite/preview", "203.0.113.10")).statusCode).toBe(404);
    expect((await attempt("/api/reset-password/preview", "203.0.113.10")).statusCode).toBe(404);
    const limited = await attempt("/api/invite/preview", "203.0.113.10");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await attempt("/api/invite/preview", "203.0.113.11")).statusCode).toBe(404);
  });

  test("counts an IPv6 client by its /64", async () => {
    expect((await attempt("/api/invite/preview", "2001:db8:1:2::1")).statusCode).toBe(404);
    expect((await attempt("/api/invite/preview", "2001:db8:1:2::ffff")).statusCode).toBe(404);
    // Another address in the same /64: the same bucket.
    expect((await attempt("/api/invite/preview", "2001:db8:1:2:abcd::9")).statusCode).toBe(429);
    expect((await attempt("/api/invite/preview", "2001:db8:1:3::1")).statusCode).toBe(404);
  });

  test("limits the owner's password tries on a handover", async () => {
    const heir = await signedInUser(dashboard, { name: "Heir", email: "heir@example.com" });
    const hand = () =>
      dashboard.app.inject({
        method: "POST",
        url: `/api/members/${heir.userId}/ownership`,
        headers: {
          cookie: dashboard.cookie,
          origin: PUBLIC_URL,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ password: "not the password" }),
      });
    for (let tries = 0; tries < 5; tries += 1) {
      expect((await hand()).json()).toMatchObject({ error: "wrong_password" });
    }
    const limited = await hand();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
