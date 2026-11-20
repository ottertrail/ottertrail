import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { ALL_AREAS, type Areas } from "../src/access/areas.ts";
import { type AlertContext, fire, resolve } from "../src/alerts/fire.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { tellAssigneesOfRegressions } from "../src/errors/assignments.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { notify } from "../src/notifications/deliveries.ts";
import { pruneInbox } from "../src/notifications/inbox.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * The notifications inbox and error assignment (docs/dashboard.md,
 * "Notifications"; docs/errors.md, "Assignment").
 */

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const CART = {
  type: "TypeError",
  message: "Cannot read properties of undefined (reading 'total')",
};
const CART_GROUP = fingerprint(CART);
const PAYMENT = { type: "Error", message: "Payment declined" };
const PAYMENT_GROUP = fingerprint(PAYMENT);

const NONE: Areas = {
  web_analytics: "none",
  product_analytics: "none",
  errors: "none",
  replays: "none",
  users: "none",
  monitoring: "none",
  uptime_alerts: "none",
};

function anError(error: { type: string; message: string }, occurredAt: Date): NewEvent {
  return {
    eventId: randomUUID(),
    name: "error",
    occurredAt,
    path: "/cart",
    visitorId: "1",
    error: { ...error, handled: false, fingerprint: fingerprint(error) },
  };
}

let dashboard: Dashboard;
let shop: string;
let blog: string;
let ownerId: string;

function send(cookie: string, method: string, url: string, payload?: unknown, origin = true) {
  return dashboard.app.inject({
    method: method as "GET",
    url,
    headers: {
      cookie,
      ...(origin ? { origin: PUBLIC_URL } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** A user's inbox titles, newest first. */
async function titles(cookie: string, query = "") {
  const response = await send(cookie, "GET", `/api/notifications${query}`);
  expect(response.statusCode).toBe(200);
  return (response.json().notifications as { title: string }[]).map((item) => item.title);
}

async function unread(cookie: string) {
  const response = await send(cookie, "GET", "/api/notifications/unread-count");
  expect(response.statusCode).toBe(200);
  return response.json().unread;
}

/** A channel notification of `type`, as alert rules and storage send them. */
function notice(
  type: Parameters<typeof notify>[1]["type"],
  project: { id: string; name: string } | null,
  subject: Record<string, string | number>,
  inbox?: Parameters<typeof notify>[1]["inbox"],
) {
  return notify(dashboard.db, {
    channelIds: [],
    type,
    project,
    subject,
    message: "What happened, in a sentence.",
    url: `${PUBLIC_URL}${project === null ? "/settings?tab=storage" : `/projects/${project.id}/alerts`}`,
    ...(inbox === undefined ? {} : { inbox }),
  });
}

async function member(email: string, areas: Partial<Areas>, projects: "all" | string[]) {
  return signedInUser(dashboard, {
    name: email.split("@")[0] ?? email,
    email,
    grants: { projects, areas: { ...NONE, ...areas } },
  });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ notifications: { emailConfigured: true } });
  shop = (await insertProject(dashboard.db, { name: "Shop" })).id;
  blog = (await insertProject(dashboard.db, { name: "Blog" })).id;
  ownerId = (
    await dashboard.db
      .selectFrom("dashboard_users")
      .select("id")
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await dashboard?.close();
});

describe("the inbox's routes", () => {
  test("each needs a session; changes need the dashboard's origin and a valid body", async () => {
    for (const [method, url, body] of [
      ["GET", "/api/notifications"],
      ["GET", "/api/notifications/unread-count"],
      ["PATCH", `/api/notifications/${randomUUID()}`, { read: true }],
      ["POST", "/api/notifications/read-all"],
    ] as const) {
      expect((await send("", method, url, body)).statusCode).toBe(401);
    }
    const { cookie } = await member("origin@example.com", {}, []);
    expect(
      (await send(cookie, "POST", "/api/notifications/read-all", undefined, false)).statusCode,
    ).toBe(403);
    expect(
      (await send(cookie, "PATCH", `/api/notifications/${randomUUID()}`, { read: true }, false))
        .statusCode,
    ).toBe(403);
    for (const body of [{}, { read: "yes" }, { read: {} }]) {
      expect(
        (await send(cookie, "PATCH", `/api/notifications/${randomUUID()}`, body)).statusCode,
      ).toBe(400);
    }
    expect(
      (await send(cookie, "PATCH", "/api/notifications/nope", { read: true })).statusCode,
    ).toBe(400);
    for (const query of ["?filter=read", "?limit=0", "?limit=101", "?before=x"]) {
      expect((await send(cookie, "GET", `/api/notifications${query}`)).statusCode).toBe(400);
    }
    // Unknown: as one the user may not see.
    const unknown = await send(cookie, "PATCH", `/api/notifications/${randomUUID()}`, {
      read: true,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: "notification_not_found",
      message: "You have no notification with this ID.",
    });
  });
});

describe("who sees what", () => {
  test("project items by area and project, instance items for the owner and admins, backups' for the owner", async () => {
    const alertsOnly = await member("alerts@example.com", { uptime_alerts: "view" }, [shop]);
    const errorsToo = await member(
      "errors@example.com",
      { uptime_alerts: "view", errors: "view" },
      [shop],
    );
    const errorsOnly = await member("errorsonly@example.com", { errors: "manage" }, [shop]);
    const monitoring = await member(
      "monitoring@example.com",
      { uptime_alerts: "manage", monitoring: "view" },
      "all",
    );
    const admin = await signedInUser(dashboard, {
      name: "Grace",
      email: "grace@example.com",
      role: "admin",
    });

    const project = { id: shop, name: "Shop" };
    await notice("check.down", project, { type: "check", name: "Checkout API" });
    await notice("error.new", project, {
      type: "error",
      errorType: "TypeError",
      message: "x is undefined",
    });
    await notice("route.latency", project, { type: "route", ruleName: "Slow checkout" });
    await notice("check.down", { id: blog, name: "Blog" }, { type: "check", name: "Blog home" });
    await notice("storage.low", null, { type: "storage" }, { title: "The disk is 92% full" });
    await notice(
      "backups.changed",
      null,
      { type: "backups" },
      { title: "Ada turned backups off", permission: "settings" },
    );

    expect(await titles(alertsOnly.cookie)).toEqual(["Checkout API is down"]);
    expect(await titles(errorsToo.cookie)).toEqual([
      "New error: TypeError: x is undefined",
      "Checkout API is down",
    ]);
    // Errors without alerts: an error rule's alert is an alert.
    expect(await titles(errorsOnly.cookie)).toEqual([]);
    expect(await titles(monitoring.cookie)).toEqual([
      "Blog home is down",
      "Slow responses: Slow checkout",
      "Checkout API is down",
    ]);
    const everything = [
      "The disk is 92% full",
      "Blog home is down",
      "Slow responses: Slow checkout",
      "New error: TypeError: x is undefined",
      "Checkout API is down",
    ];
    // The Backups tab is the owner's, and so are its notices.
    expect(await titles(admin.cookie)).toEqual(everything);
    expect(await titles(dashboard.cookie)).toEqual(["Ada turned backups off", ...everything]);
    expect(await unread(admin.cookie)).toBe(5);
    expect(await unread(dashboard.cookie)).toBe(6);

    const list = await send(admin.cookie, "GET", "/api/notifications?limit=1");
    expect(list.json()).toMatchObject({
      notifications: [
        {
          kind: "storage.low",
          title: "The disk is 92% full",
          project: null,
          link: "/settings?tab=storage",
          read: false,
        },
      ],
      unread: 5,
    });

    // A user made after them sees none of them.
    const later = await member("later@example.com", ALL_AREAS, "all");
    expect(await titles(later.cookie)).toEqual([]);
  });

  test("a member who loses a project or an area stops seeing its items, and cannot mark them", async () => {
    const lena = await member("lena@example.com", { uptime_alerts: "view", errors: "view" }, [
      shop,
      blog,
    ]);
    await notice("check.down", { id: blog, name: "Blog" }, { type: "check", name: "Blog feed" });
    const listed = (await send(lena.cookie, "GET", "/api/notifications")).json().notifications as {
      id: string;
      title: string;
    }[];
    const feed = listed.find((item) => item.title === "Blog feed is down");
    expect(feed).toBeDefined();

    const change = (projects: string[], areas: Partial<Areas>) =>
      send(dashboard.cookie, "PATCH", `/api/members/${lena.userId}`, {
        role: "member",
        access: { projects, areas: { ...NONE, ...areas } },
      });
    expect((await change([shop], { uptime_alerts: "view", errors: "view" })).statusCode).toBe(204);
    expect(await titles(lena.cookie)).not.toContain("Blog feed is down");
    expect(
      (await send(lena.cookie, "PATCH", `/api/notifications/${feed?.id}`, { read: true }))
        .statusCode,
    ).toBe(404);
    expect(await unread(lena.cookie)).toBe(0);

    // Granted again: it is back.
    expect((await change([shop, blog], { uptime_alerts: "view" })).statusCode).toBe(204);
    expect(await titles(lena.cookie)).toContain("Blog feed is down");
    // An area lost hides its items as well.
    expect((await change([shop, blog], { errors: "view" })).statusCode).toBe(204);
    expect(await titles(lena.cookie)).toEqual([]);
  });
});

describe("read and unread", () => {
  test("one item, every item, and the unread filter, per user", async () => {
    const ida = await member("ida@example.com", { uptime_alerts: "view" }, [blog]);
    const ole = await member("ole@example.com", { uptime_alerts: "view" }, [blog]);
    for (const name of ["One", "Two", "Three"]) {
      await notice("check.down", { id: blog, name: "Blog" }, { type: "check", name });
    }
    expect(await unread(ida.cookie)).toBe(3);
    const items = (await send(ida.cookie, "GET", "/api/notifications")).json().notifications as {
      id: string;
      read: boolean;
    }[];
    const [three, two] = items;

    const read = await send(ida.cookie, "PATCH", `/api/notifications/${three?.id}`, { read: true });
    expect(read.json()).toEqual({ id: three?.id, read: true });
    // Twice changes nothing.
    await send(ida.cookie, "PATCH", `/api/notifications/${three?.id}`, { read: true });
    expect(await unread(ida.cookie)).toBe(2);
    expect(await unread(ole.cookie)).toBe(3);
    expect(await titles(ida.cookie, "?filter=unread")).toEqual(["Two is down", "One is down"]);

    const all = await send(ida.cookie, "POST", "/api/notifications/read-all");
    expect(all.json()).toEqual({ marked: 2 });
    expect(await unread(ida.cookie)).toBe(0);
    expect(await titles(ida.cookie, "?filter=unread")).toEqual([]);
    expect(await unread(ole.cookie)).toBe(3);

    await send(ida.cookie, "PATCH", `/api/notifications/${two?.id}`, { read: false });
    expect(await titles(ida.cookie, "?filter=unread")).toEqual(["Two is down"]);
    const listed = (await send(ida.cookie, "GET", "/api/notifications")).json();
    expect(listed.unread).toBe(1);
    expect((listed.notifications as { read: boolean }[]).map((item) => item.read)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("pages go back in time without gaps", async () => {
    const pia = await member("pia@example.com", { uptime_alerts: "view" }, [blog]);
    for (let index = 0; index < 5; index += 1) {
      await notice(
        "check.up",
        { id: blog, name: "Blog" },
        { type: "check", name: `Page ${index}` },
      );
    }
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const query: string = before === null ? "?limit=2" : `?limit=2&before=${before}`;
      const page = (await send(pia.cookie, "GET", `/api/notifications${query}`)).json();
      seen.push(...page.notifications.map((item: { title: string }) => item.title));
      before = page.next;
    } while (before !== null);
    expect(seen).toEqual([4, 3, 2, 1, 0].map((index) => `Page ${index} is up`));
  });

  test("the worker deletes items older than 90 days, with their reads", async () => {
    const old = await dashboard.db
      .insertInto("notifications")
      .values({
        kind: "check.down",
        project_id: blog,
        areas: ["uptime_alerts"],
        title: "Old",
        link: "/",
        created_at: new Date(Date.now() - 91 * 86_400_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await dashboard.db
      .insertInto("notification_reads")
      .values({ user_id: ownerId, notification_id: old.id })
      .execute();
    expect(await pruneInbox(dashboard.db)).toBe(1);
    const left = await sql<{ count: string }>`
      select count(*) from notification_reads where notification_id = ${old.id}
    `.execute(dashboard.db);
    expect(left.rows[0]?.count).toBe("0");
    expect(await pruneInbox(dashboard.db)).toBe(0);
  });
});

describe("what makes items", () => {
  test("an alert firing makes one item, firing again none, and resolving its own", async () => {
    const project = await insertProject(dashboard.db, { name: "Alerts" });
    const rule = await dashboard.db
      .insertInto("alert_rules")
      .values({
        project_id: project.id,
        name: "API down",
        kind: "check_down",
        settings: "{}",
        channel_ids: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const context: AlertContext = { db: dashboard.db, publicUrl: PUBLIC_URL };
    const at = new Date();
    const down = {
      ruleId: rule.id,
      subjectKey: "check-1",
      subjectName: "Checkout API",
      type: "check.down" as const,
      message: "Alerts: the check is down.",
      url: `${PUBLIC_URL}/projects/${project.id}/uptime/check-1`,
      subject: { type: "check", id: "check-1", name: "Checkout API" },
      at,
    };
    expect(await fire(context, down)).toBe("sent");
    expect(await fire(context, down)).toBe("skipped");
    expect(
      await resolve(context, {
        ...down,
        type: "check.up",
        message: "Alerts: the check is up.",
        at: new Date(at.getTime() + 1000),
      }),
    ).toBe("sent");
    const rows = await dashboard.db
      .selectFrom("notifications")
      .select(["kind", "title", "areas", "link"])
      .where("project_id", "=", project.id)
      .orderBy("created_at")
      .execute();
    expect(rows).toEqual([
      {
        kind: "check.down",
        title: "Checkout API is down",
        areas: ["uptime_alerts"],
        link: `/projects/${project.id}/uptime/check-1`,
      },
      {
        kind: "check.up",
        title: "Checkout API is up",
        areas: ["uptime_alerts"],
        link: `/projects/${project.id}/uptime/check-1`,
      },
    ]);
  });

  test("an error rule's alert needs errors too; a test send makes none", async () => {
    const project = await insertProject(dashboard.db, { name: "Rules" });
    const rule = await dashboard.db
      .insertInto("alert_rules")
      .values({
        project_id: project.id,
        name: "New errors",
        kind: "error_new",
        settings: "{}",
        channel_ids: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await fire(
      { db: dashboard.db, publicUrl: PUBLIC_URL },
      {
        ruleId: rule.id,
        subjectKey: CART_GROUP,
        subjectName: "TypeError",
        once: true,
        type: "error.new",
        message: "Rules: a new error.",
        url: `${PUBLIC_URL}/projects/${project.id}/errors/${CART_GROUP}?env=%22production%22`,
        subject: { type: "error", errorType: CART.type, message: CART.message },
        at: new Date(),
      },
    );
    const row = await dashboard.db
      .selectFrom("notifications")
      .select(["title", "areas", "link"])
      .where("project_id", "=", project.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      title: `New error: TypeError: ${CART.message}`,
      areas: ["uptime_alerts", "errors"],
      link: `/projects/${project.id}/errors/${CART_GROUP}?env=%22production%22`,
    });
    const before = await dashboard.db
      .selectFrom("notifications")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const channel = await dashboard.db
      .insertInto("notification_channels")
      .values({ name: "Mail", kind: "email", email_addresses: ["team@example.com"] })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { sendTest } = await import("../src/notifications/deliveries.ts");
    await sendTest(dashboard.db, channel.id, {
      project: null,
      subject: {},
      message: "A test.",
      url: PUBLIC_URL,
    });
    const after = await dashboard.db
      .selectFrom("notifications")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
  });
});

describe("assigning errors", () => {
  let project: string;
  let viewer: { userId: string; cookie: string };
  let manager: { userId: string; cookie: string };
  let outsider: { userId: string; cookie: string };
  const assignee = (group: string) => `/api/projects/${project}/errors/${group}/assignee`;

  beforeAll(async () => {
    project = (await insertProject(dashboard.db, { name: "Checkout" })).id;
    viewer = await member("ada.viewer@example.com", { errors: "view" }, [project]);
    manager = await member("max@example.com", { errors: "manage" }, [project]);
    outsider = await member("otto@example.com", { errors: "manage", uptime_alerts: "view" }, [
      shop,
    ]);
    await dashboard.store(project, [
      anError(CART, new Date(Date.now() - 3_600_000)),
      anError(PAYMENT, new Date(Date.now() - 1_800_000)),
    ]);
  });

  test("the people to choose from see the project's errors; choosing needs manage", async () => {
    const list = await send(dashboard.cookie, "GET", `/api/projects/${project}/error-assignees`);
    const names = (list.json().users as { id: string; name: string }[]).map((user) => user.name);
    expect(names).toContain("ada.viewer");
    expect(names).toContain("max");
    expect(names).toContain("Ada Owner");
    expect(names).not.toContain("otto");
    for (const user of list.json().users as Record<string, unknown>[]) {
      expect(Object.keys(user).toSorted()).toEqual(["avatarUrl", "id", "name"]);
    }
    expect(
      (await send(viewer.cookie, "GET", `/api/projects/${project}/error-assignees`)).statusCode,
    ).toBe(403);
    expect(
      (await send(viewer.cookie, "PUT", assignee(CART_GROUP), { assignee: viewer.userId }))
        .statusCode,
    ).toBe(403);
    // Another project's member: as an unknown project.
    expect(
      (await send(outsider.cookie, "PUT", assignee(CART_GROUP), { assignee: null })).statusCode,
    ).toBe(404);
    for (const body of [{}, { assignee: "x" }, { assignee: true }, { assignee: [] }]) {
      expect((await send(manager.cookie, "PUT", assignee(CART_GROUP), body)).statusCode).toBe(400);
    }
    expect(
      (await send(manager.cookie, "PUT", assignee(CART_GROUP), { assignee: null }, false))
        .statusCode,
    ).toBe(403);
  });

  test("only someone who sees the project's errors can be assigned", async () => {
    for (const id of [outsider.userId, randomUUID()]) {
      const refused = await send(manager.cookie, "PUT", assignee(CART_GROUP), { assignee: id });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({
        error: "not_assignable",
        message: "This person can't see this project's errors. Choose someone else.",
      });
    }
    expect(
      await dashboard.db
        .selectFrom("error_assignments")
        .selectAll()
        .where("project_id", "=", project)
        .execute(),
    ).toEqual([]);
  });

  test("the assignee gets an item and an email, but not for assigning themselves", async () => {
    const assigned = await send(manager.cookie, "PUT", assignee(CART_GROUP), {
      assignee: viewer.userId,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({
      fingerprint: CART_GROUP,
      assignee: { id: viewer.userId, name: "ada.viewer", avatarUrl: null },
    });
    const items = (await send(viewer.cookie, "GET", "/api/notifications")).json().notifications;
    expect(items).toMatchObject([
      {
        kind: "error.assigned",
        title: `max assigned you TypeError: ${CART.message}`,
        project: { id: project, name: "Checkout" },
        link: `/projects/${project}/errors/${CART_GROUP}`,
        read: false,
      },
    ]);
    // Personal: the manager, who sees the project's errors, does not get it.
    expect(await titles(manager.cookie)).toEqual([]);
    const emails = await dashboard.db
      .selectFrom("account_emails")
      .select(["kind", "to_address", "params"])
      .where("kind", "=", "error_assigned")
      .execute();
    expect(emails).toEqual([
      {
        kind: "error_assigned",
        to_address: "ada.viewer@example.com",
        params: {
          by: "max",
          error: `TypeError: ${CART.message}`,
          project: "Checkout",
          link: `${PUBLIC_URL}/projects/${project}/errors/${CART_GROUP}`,
        },
      },
    ]);
    // The same person again: nothing new.
    await send(manager.cookie, "PUT", assignee(CART_GROUP), { assignee: viewer.userId });
    expect(await titles(viewer.cookie)).toHaveLength(1);
    // Assigning yourself: no item, no email.
    await send(manager.cookie, "PUT", assignee(PAYMENT_GROUP), { assignee: manager.userId });
    expect(await titles(manager.cookie)).toEqual([]);
    const count = await dashboard.db
      .selectFrom("account_emails")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("kind", "=", "error_assigned")
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("1");
  });

  test("the list shows each group's assignee, and filters by it; resolving keeps it", async () => {
    const list = (query: string, cookie = manager.cookie) =>
      send(cookie, "GET", `/api/projects/${project}/errors?period=7d&status=all${query}`);
    const everyone = (await list("")).json();
    expect(everyone.assignee).toBeNull();
    const byGroup = Object.fromEntries(
      (everyone.groups as { fingerprint: string; assignee: unknown }[]).map((group) => [
        group.fingerprint,
        group.assignee,
      ]),
    );
    expect(byGroup).toEqual({
      [CART_GROUP]: { id: viewer.userId, name: "ada.viewer", avatarUrl: null },
      [PAYMENT_GROUP]: { id: manager.userId, name: "max", avatarUrl: null },
    });
    const fingerprints = async (query: string, cookie?: string) =>
      ((await list(query, cookie)).json().groups as { fingerprint: string }[]).map(
        (group) => group.fingerprint,
      );
    expect(await fingerprints("&assignee=me")).toEqual([PAYMENT_GROUP]);
    expect(await fingerprints("&assignee=me", viewer.cookie)).toEqual([CART_GROUP]);
    expect(await fingerprints("&assignee=none")).toEqual([]);
    expect((await list("&assignee=someone")).statusCode).toBe(400);

    const resolved = await send(
      manager.cookie,
      "PATCH",
      `/api/projects/${project}/errors/${CART_GROUP}`,
      {
        status: "resolved",
      },
    );
    expect(resolved.statusCode).toBe(200);
    const detail = await send(
      manager.cookie,
      "GET",
      `/api/projects/${project}/errors/${CART_GROUP}?period=7d`,
    );
    expect(detail.json().group).toMatchObject({
      status: "resolved",
      assignee: { id: viewer.userId, name: "ada.viewer", avatarUrl: null },
    });

    await send(manager.cookie, "PUT", assignee(PAYMENT_GROUP), { assignee: null });
    expect(await fingerprints("&assignee=none")).toEqual([PAYMENT_GROUP]);
  });

  test("a group with no occurrence in the project can't be assigned", async () => {
    const never = fingerprint({ type: "Error", message: "Never happened here" });
    const refused = await send(manager.cookie, "PUT", assignee(never), {
      assignee: viewer.userId,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({
      error: "no_occurrences",
      message: "This error has no occurrence in the last 366 days.",
    });
    // Nor one only another project has.
    await dashboard.store(shop, [anError({ type: "Error", message: "Shop only" }, new Date())]);
    const elsewhere = fingerprint({ type: "Error", message: "Shop only" });
    expect(
      (await send(manager.cookie, "PUT", assignee(elsewhere), { assignee: viewer.userId }))
        .statusCode,
    ).toBe(404);
    expect(
      await dashboard.db
        .selectFrom("error_assignments")
        .select("fingerprint")
        .where("fingerprint", "in", [never, elsewhere])
        .execute(),
    ).toEqual([]);
  });

  test("two people assigning the same person at once tell them once", async () => {
    const before = await titles(viewer.cookie);
    const both = await Promise.all([
      send(manager.cookie, "PUT", assignee(PAYMENT_GROUP), { assignee: viewer.userId }),
      send(dashboard.cookie, "PUT", assignee(PAYMENT_GROUP), { assignee: viewer.userId }),
    ]);
    expect(both.map((reply) => reply.statusCode)).toEqual([200, 200]);
    const after = await titles(viewer.cookie);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatch(/ assigned you Error: Payment declined$/);
  });

  test("a regression tells the assignee once per resolution, from the errors that arrived", async () => {
    const tell = (from: Date, until: Date, pageSize?: number) =>
      tellAssigneesOfRegressions(dashboard.db, dashboard.reader, { from, until }, pageSize);
    const start = new Date();
    const before = await titles(viewer.cookie);
    // Nothing new since CART was resolved.
    expect(await tell(start, new Date(Date.now() + 5000))).toBe(0);
    // Both groups on the viewer's plate, resolved.
    const resolved = await send(
      manager.cookie,
      "PATCH",
      `/api/projects/${project}/errors/${PAYMENT_GROUP}`,
      { status: "resolved" },
    );
    expect(resolved.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 5));
    await dashboard.store(project, [
      anError(CART, new Date(Date.now() + 1000)),
      anError(PAYMENT, new Date(Date.now() + 1000)),
    ]);
    const arrived = new Date();
    const until = new Date(Date.now() + 5000);
    // Arrivals before the window are not read.
    expect(await tell(arrived, until)).toBe(0);
    // A page of one group at a time still reads them all.
    expect(await tell(start, until, 1)).toBe(2);
    expect(await tell(start, until)).toBe(0);
    // The resolution told is the one stored, whole: neither row is a candidate now.
    const left = await sql<{ count: string }>`
      select count(*) as count
      from error_assignments a
      join error_resolutions r using (project_id, fingerprint)
      where a.project_id = ${project}
        and a.regression_told_for is distinct from r.resolved_at
    `.execute(dashboard.db);
    expect(left.rows[0]?.count).toBe("0");
    const now = await titles(viewer.cookie);
    expect(now.slice(2)).toEqual(before);
    expect(now.slice(0, 2).toSorted()).toEqual([
      "Regressed: Error: Payment declined",
      `Regressed: TypeError: ${CART.message}`,
    ]);
    expect(await titles(manager.cookie)).toEqual([]);
  });

  test("losing the project's errors, or being removed, clears their assignments", async () => {
    await send(manager.cookie, "PUT", assignee(PAYMENT_GROUP), { assignee: viewer.userId });
    const assignedTo = async () =>
      (
        await dashboard.db
          .selectFrom("error_assignments")
          .select("assignee_id")
          .where("project_id", "=", project)
          .orderBy("fingerprint")
          .execute()
      ).map((row) => row.assignee_id);
    expect(await assignedTo()).toEqual([viewer.userId, viewer.userId]);

    // Errors kept, on another project too: nothing changes.
    const keep = await send(dashboard.cookie, "PATCH", `/api/members/${viewer.userId}`, {
      role: "member",
      access: { projects: [project, shop], areas: { ...NONE, errors: "view" } },
    });
    expect(keep.statusCode).toBe(204);
    expect(await assignedTo()).toEqual([viewer.userId, viewer.userId]);
    // The project lost: cleared.
    await send(dashboard.cookie, "PATCH", `/api/members/${viewer.userId}`, {
      role: "member",
      access: { projects: [shop], areas: { ...NONE, errors: "view" } },
    });
    expect(await assignedTo()).toEqual([]);

    // The area lost: cleared.
    await send(manager.cookie, "PUT", assignee(CART_GROUP), { assignee: manager.userId });
    await send(dashboard.cookie, "PATCH", `/api/members/${manager.userId}`, {
      role: "member",
      access: { projects: "all", areas: { ...NONE, uptime_alerts: "view" } },
    });
    expect(await assignedTo()).toEqual([]);

    // Removed: cleared.
    const leo = await member("leo@example.com", { errors: "view" }, "all");
    expect(
      (await send(dashboard.cookie, "PUT", assignee(CART_GROUP), { assignee: leo.userId }))
        .statusCode,
    ).toBe(200);
    expect(await assignedTo()).toEqual([leo.userId]);
    expect((await send(dashboard.cookie, "DELETE", `/api/members/${leo.userId}`)).statusCode).toBe(
      204,
    );
    expect(await assignedTo()).toEqual([]);
  });
});

test("the assignment email is short, with the error's page from PUBLIC_URL", async () => {
  const { accountEmailMessage } = await import("../src/notifications/account-emails.ts");
  const link = `${PUBLIC_URL}/projects/p/errors/${CART_GROUP}`;
  const message = accountEmailMessage(
    {
      kind: "error_assigned",
      to: "ada@example.com",
      params: { by: "Max", error: "TypeError: x is undefined", project: "Shop", link },
    },
    "Ada's company",
  );
  expect(message.subject).toBe("Ada's company: Max assigned you an error");
  expect(message.text).toBe(
    `Max assigned you an error in Shop:\nTypeError: x is undefined\n\nOpen it:\n${link}\n`,
  );
  expect(message.html).toContain(`<a href="${link}">`);
});
