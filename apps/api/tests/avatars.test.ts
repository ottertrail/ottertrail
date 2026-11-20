import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { ICO, png, SVG } from "./helpers/images.ts";

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

// The development Garage from compose.yaml.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
let dashboard: Dashboard;
let plain: Dashboard;
const keysMade: string[] = [];

const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
};
const INVALID_IMAGE = "invalid_image";
const AVATAR_URL =
  /^\/api\/avatars\/(instance|users\/[0-9a-f-]{36}|projects\/[0-9a-f-]{36})\/[0-9a-f-]{36}\.png$/;

function call(
  app: Dashboard,
  method: "GET" | "PUT" | "DELETE" | "POST" | "PATCH",
  url: string,
  {
    cookie = app.cookie,
    body,
    contentType = "image/png",
    origin = PUBLIC_URL,
  }: { cookie?: string; body?: Buffer | object; contentType?: string; origin?: string | null } = {},
) {
  const json = body !== undefined && !Buffer.isBuffer(body);
  return app.app.inject({
    method,
    url,
    headers: {
      ...(cookie === "" ? {} : { cookie }),
      ...(origin === null ? {} : { origin }),
      ...(body === undefined ? {} : { "content-type": json ? "application/json" : contentType }),
    },
    ...(body === undefined ? {} : { payload: json ? JSON.stringify(body) : body }),
  });
}

/** The object key an avatar URL serves. */
const keyOf = (url: string) => {
  const key = url.replace(/^\/api\//, "");
  keysMade.push(key);
  return key;
};

async function upload(url: string, cookie = dashboard.cookie, body: Buffer = png(64, 64)) {
  const response = await call(dashboard, "PUT", url, { cookie, body });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function newProject(name: string): Promise<string> {
  const response = await call(dashboard, "POST", "/api/projects", {
    body: { name, allowedHostnames: [`${name.toLowerCase()}.example`] },
  });
  return response.json().project.id;
}

beforeAll(async () => {
  dashboard = await signedInDashboard({
    objectStore: store,
    // Five uploads per user, and next to no refill while the tests run.
    avatars: { uploadLimit: { capacity: 5, refillPerSecond: 0.001 } },
  });
  plain = await signedInDashboard();
});

afterAll(async () => {
  await store.delete(keysMade);
  store.close();
  await dashboard?.close();
  await plain?.close();
});

describe("the instance's icon", () => {
  test("the owner uploads it, everyone signed in sees it, and replacing deletes the old one", async () => {
    const image = png(64, 64);
    const first = (await upload("/api/settings/avatar", dashboard.cookie, image)).avatarUrl;
    expect(first).toMatch(AVATAR_URL);
    expect(first).toMatch(/^\/api\/avatars\/instance\//);
    const me = (await call(dashboard, "GET", "/api/me")).json();
    expect(me).toMatchObject({ instance: { avatarUrl: first }, avatarUploads: true });
    expect((await call(dashboard, "GET", "/api/settings")).json().settings.avatarUrl).toBe(first);

    const member = await signedInUser(dashboard, { name: "Mia", email: "mia@example.com" });
    const served = await call(dashboard, "GET", first, { cookie: member.cookie });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(image)).toBe(true);
    expect(served.headers).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
    // Signed out, nothing.
    expect((await call(dashboard, "GET", first, { cookie: "" })).statusCode).toBe(401);

    const second = (await upload("/api/settings/avatar")).avatarUrl;
    expect(second).not.toBe(first);
    expect(await store.get(keyOf(first))).toBeNull();
    expect((await call(dashboard, "GET", first)).statusCode).toBe(404);
    expect((await call(dashboard, "GET", second)).statusCode).toBe(200);

    const removed = await call(dashboard, "DELETE", "/api/settings/avatar");
    expect(removed.json()).toEqual({ avatarUrl: null });
    expect(await store.get(keyOf(second))).toBeNull();
    expect((await call(dashboard, "GET", "/api/me")).json().instance.avatarUrl).toBeNull();
    expect((await call(dashboard, "GET", second)).statusCode).toBe(404);
  });

  test("only the owner changes it, from the dashboard", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Al",
      email: "al@example.com",
      role: "admin",
    });
    const member = await signedInUser(dashboard, { name: "Mo", email: "mo@example.com" });
    for (const cookie of [admin.cookie, member.cookie]) {
      const put = await call(dashboard, "PUT", "/api/settings/avatar", { cookie, body: png(8, 8) });
      expect([put.statusCode, put.json()]).toEqual([403, FORBIDDEN]);
      const removed = await call(dashboard, "DELETE", "/api/settings/avatar", { cookie });
      expect([removed.statusCode, removed.json()]).toEqual([403, FORBIDDEN]);
    }
    const foreign = await call(dashboard, "PUT", "/api/settings/avatar", {
      body: png(8, 8),
      origin: "https://elsewhere.example",
    });
    expect([foreign.statusCode, foreign.json().error]).toEqual([403, "untrusted_origin"]);
    const none = await call(dashboard, "DELETE", "/api/settings/avatar", { origin: null });
    expect(none.statusCode).toBe(403);
    expect((await call(dashboard, "GET", "/api/me")).json().instance.avatarUrl).toBeNull();
  });
});

describe("a user's own avatar", () => {
  test("each user changes their own; others see it; the error assignees list carries it", async () => {
    const member = await signedInUser(dashboard, {
      name: "Uma",
      email: "uma@example.com",
      grants: { projects: "all", areas: { errors: "manage" } },
    });
    const url = (await upload("/api/account/avatar", member.cookie)).avatarUrl;
    expect(url).toMatch(new RegExp(`^/api/avatars/users/${member.userId}/`));
    keyOf(url);
    expect(
      (await call(dashboard, "GET", "/api/me", { cookie: member.cookie })).json().user,
    ).toMatchObject({ id: member.userId, avatarUrl: url });
    // The owner's own is untouched, and the owner sees the member's.
    expect((await call(dashboard, "GET", "/api/me")).json().user.avatarUrl).toBeNull();
    expect((await call(dashboard, "GET", url)).statusCode).toBe(200);

    const project = await newProject("Assignees");
    const assignees = (
      await call(dashboard, "GET", `/api/projects/${project}/error-assignees`)
    ).json().users;
    expect(assignees).toContainEqual({ id: member.userId, name: "Uma", avatarUrl: url });

    const removed = await call(dashboard, "DELETE", "/api/account/avatar", {
      cookie: member.cookie,
    });
    expect(removed.json()).toEqual({ avatarUrl: null });
    expect(await store.get(keyOf(url))).toBeNull();
  });

  test("an avatar address of another user's, or a made-up one, serves nothing", async () => {
    const member = await signedInUser(dashboard, { name: "Ned", email: "ned@example.com" });
    const url = (await upload("/api/account/avatar", member.cookie)).avatarUrl;
    keyOf(url);
    const other = url.replace(member.userId, "00000000-0000-4000-8000-000000000000");
    expect((await call(dashboard, "GET", other)).statusCode).toBe(404);
    const made = url.replace(/[0-9a-f-]{36}\.png$/, "00000000-0000-4000-8000-000000000000.png");
    expect((await call(dashboard, "GET", made)).statusCode).toBe(404);
    for (const bad of [
      "/api/avatars/instance/..%2Fsecret.png",
      "/api/avatars/instance/abc.svg",
      `/api/avatars/users/${member.userId}/x.png`,
      "/api/avatars/projects/not-a-project/favicon-x.ico",
    ]) {
      expect([bad, (await call(dashboard, "GET", bad)).statusCode]).toEqual([bad, 400]);
    }
  });

  test("removing a member deletes their avatar", async () => {
    const member = await signedInUser(dashboard, { name: "Rex", email: "rex@example.com" });
    const url = (await upload("/api/account/avatar", member.cookie)).avatarUrl;
    const key = keyOf(url);
    expect(await store.get(key)).not.toBeNull();
    const removed = await call(dashboard, "DELETE", `/api/members/${member.userId}`);
    expect(removed.statusCode).toBe(204);
    expect(await store.get(key)).toBeNull();
  });
});

describe("what an upload must be", () => {
  test("only a PNG within the limits, sent as one; nothing is stored otherwise", async () => {
    const tries: [string, Buffer, string][] = [
      ["text as a PNG", Buffer.from("not an image"), "image/png"],
      ["a PNG as JSON", png(8, 8), "application/json"],
      ["a PNG as octets", png(8, 8), "application/octet-stream"],
      ["an SVG", SVG, "image/svg+xml"],
      ["an SVG as a PNG", SVG, "image/png"],
      ["an ICO as a PNG", ICO, "image/png"],
      ["no pixels", png(1, 1, { width: 0, height: 0 }), "image/png"],
      ["too wide", png(1, 1, { width: 513, height: 10 }), "image/png"],
      ["too tall", png(1, 1, { width: 10, height: 513 }), "image/png"],
      ["empty", Buffer.alloc(0), "image/png"],
    ];
    for (const [what, body, contentType] of tries) {
      const response = await call(dashboard, "PUT", "/api/account/avatar", { body, contentType });
      expect([what, response.statusCode, response.json().error]).toEqual([
        what,
        400,
        INVALID_IMAGE,
      ]);
    }
    const large = Buffer.concat([png(8, 8), Buffer.alloc(600 * 1024)]);
    const tooLarge = await call(dashboard, "PUT", "/api/account/avatar", { body: large });
    expect([tooLarge.statusCode, tooLarge.json().error]).toEqual([413, "image_too_large"]);
    // The largest accepted still goes in.
    const edge = await call(dashboard, "PUT", "/api/account/avatar", { body: png(512, 512) });
    expect(edge.statusCode).toBe(200);
    keyOf(edge.json().avatarUrl);
    await call(dashboard, "DELETE", "/api/account/avatar");
  });

  test("uploads past the per-user limit answer 429 with Retry-After", async () => {
    const member = await signedInUser(dashboard, { name: "Lim", email: "lim@example.com" });
    for (let index = 0; index < 5; index += 1) {
      keyOf((await upload("/api/account/avatar", member.cookie, png(4, 4))).avatarUrl);
    }
    const limited = await call(dashboard, "PUT", "/api/account/avatar", {
      cookie: member.cookie,
      body: png(4, 4),
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json().error).toBe("rate_limited");
    // Another user's uploads are their own.
    const other = await signedInUser(dashboard, { name: "Oz", email: "oz@example.com" });
    keyOf((await upload("/api/account/avatar", other.cookie, png(4, 4))).avatarUrl);
  });

  test("without an object store, uploads are off and say why", async () => {
    expect((await call(plain, "GET", "/api/me")).json()).toMatchObject({ avatarUploads: false });
    for (const [method, url] of [
      ["PUT", "/api/settings/avatar"],
      ["DELETE", "/api/settings/avatar"],
      ["PUT", "/api/account/avatar"],
      ["DELETE", "/api/account/avatar"],
    ] as const) {
      const response = await call(plain, method, url, method === "PUT" ? { body: png(8, 8) } : {});
      expect([url, response.statusCode, response.json()]).toEqual([
        url,
        409,
        {
          error: "object_store_not_set_up",
          message:
            "Uploads need object storage. Set OBJECT_STORE_URL on the server, then restart it.",
        },
      ]);
    }
  });
});

describe("a project's icon", () => {
  test("owners and admins set it; members of the project see it; others get nothing", async () => {
    const project = await newProject("Iconic");
    const other = await newProject("Elsewhere");
    const set = await upload(`/api/projects/${project}/avatar`);
    expect(set).toEqual({ iconUrl: expect.stringMatching(AVATAR_URL), avatarUrl: set.iconUrl });
    keyOf(set.iconUrl);

    const listed = (await call(dashboard, "GET", "/api/projects")).json().projects;
    expect(listed.find((item: { id: string }) => item.id === project)).toMatchObject({
      avatarUrl: set.iconUrl,
      iconUrl: set.iconUrl,
    });

    const viewer = await signedInUser(dashboard, {
      name: "Vi",
      email: "vi@example.com",
      grants: { projects: [project], areas: { web_analytics: "view" } },
    });
    const outsider = await signedInUser(dashboard, {
      name: "Ox",
      email: "ox@example.com",
      grants: { projects: [other], areas: { web_analytics: "view" } },
    });
    const seen = (
      await call(dashboard, "GET", `/api/projects/${project}`, { cookie: viewer.cookie })
    ).json().project;
    expect(seen).toEqual({
      id: project,
      name: "Iconic",
      createdAt: expect.any(String),
      lastEventAt: null,
      avatarUrl: set.iconUrl,
    });
    expect((await call(dashboard, "GET", set.iconUrl, { cookie: viewer.cookie })).statusCode).toBe(
      200,
    );
    expect(
      (await call(dashboard, "GET", set.iconUrl, { cookie: outsider.cookie })).statusCode,
    ).toBe(404);
    const refused = await call(dashboard, "PUT", `/api/projects/${project}/avatar`, {
      cookie: viewer.cookie,
      body: png(8, 8),
    });
    expect([refused.statusCode, refused.json()]).toEqual([403, FORBIDDEN]);

    const admin = await signedInUser(dashboard, {
      name: "Ari",
      email: "ari@example.com",
      role: "admin",
    });
    const replaced = await upload(`/api/projects/${project}/avatar`, admin.cookie);
    keyOf(replaced.iconUrl);
    expect(await store.get(keyOf(set.iconUrl))).toBeNull();
  });

  test("without an uploaded icon, the site's favicon shows; removing the icon goes back to it", async () => {
    const project = await newProject("Favicon");
    const favicon = `avatars/projects/${project}/favicon-00000000-0000-4000-8000-000000000001.ico`;
    keysMade.push(favicon);
    await store.put(favicon, ICO, "image/x-icon");
    await dashboard.db
      .updateTable("projects")
      .set({ favicon_key: favicon })
      .where("id", "=", project)
      .execute();
    const shown = (await call(dashboard, "GET", `/api/projects/${project}`)).json().project;
    expect(shown).toMatchObject({ avatarUrl: `/api/${favicon}`, iconUrl: null });
    const served = await call(dashboard, "GET", `/api/${favicon}`);
    expect(served.headers["content-type"]).toBe("image/x-icon");
    expect(served.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");

    const set = await upload(`/api/projects/${project}/avatar`);
    keyOf(set.iconUrl);
    expect(set.avatarUrl).toBe(set.iconUrl);
    const removed = (await call(dashboard, "DELETE", `/api/projects/${project}/avatar`)).json();
    expect(removed).toEqual({ iconUrl: null, avatarUrl: `/api/${favicon}` });
    // The favicon's own address does not serve as the uploaded icon's.
    const swapped = `/api/avatars/projects/${project}/00000000-0000-4000-8000-000000000001.png`;
    expect((await call(dashboard, "GET", swapped)).statusCode).toBe(404);
  });

  test("deleting a project deletes its icon and favicon", async () => {
    const project = await newProject("Doomed");
    // The owner's uploads are spent by now: each user has their own.
    const admin = await signedInUser(dashboard, {
      name: "Dee",
      email: "dee@example.com",
      role: "admin",
    });
    const icon = keyOf((await upload(`/api/projects/${project}/avatar`, admin.cookie)).iconUrl);
    const favicon = `avatars/projects/${project}/favicon-00000000-0000-4000-8000-000000000002.png`;
    keysMade.push(favicon);
    await store.put(favicon, png(16, 16), "image/png");
    const deleted = await call(dashboard, "DELETE", `/api/projects/${project}`, {
      body: { confirmName: "Doomed" },
    });
    expect(deleted.statusCode).toBe(204);
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client, store);
    expect(await store.get(icon)).toBeNull();
    expect(await store.get(favicon)).toBeNull();
  });
});
