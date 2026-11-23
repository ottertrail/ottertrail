import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { evaluateCheckDown } from "../src/alerts/check-rules.ts";
import { MAX_RULES } from "../src/alerts/kinds.ts";
import { CHANNELS_DELETED_REASON, CHECK_DELETED_REASON } from "../src/alerts/rules.ts";
import { deleteChannel } from "../src/notifications/channels.ts";
import { deleteCheck } from "../src/uptime/checks.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { testLookup } from "./helpers/uptime-servers.ts";

/** Guard alert references and access checks (docs/uptime-alerts.md, "Alerts"). */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProjectId = "";
let email = "";
let hook = "";
let checkId = "";

const lookup = testLookup({ "hooks.example.com": ["93.184.215.14"] });

beforeAll(async () => {
  dashboard = await signedInDashboard({ uptime: { lookup } });
  projectId = (await insertProject(dashboard.db, { name: "Shop" })).id;
  otherProjectId = (await insertProject(dashboard.db, { name: "Blog" })).id;
});

afterAll(async () => {
  await dashboard?.close();
});

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) {
  return dashboard.app.inject({
    method,
    url: `/api${path}`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

const rules = (path = "") => `/projects/${projectId}/alert-rules${path}`;

async function insertCheck(project: string, name: string) {
  const row = await dashboard.db
    .insertInto("uptime_checks")
    .values({
      project_id: project,
      name,
      url: `https://${name.toLowerCase().replaceAll(" ", "-")}.example/`,
      method: "GET",
      interval_seconds: 60,
      timeout_seconds: 10,
      expected_statuses: "200-399",
      word_mode: "present",
      failures_before_down: 2,
      next_due_at: new Date(Date.now() + 3_600_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(async () => {
  await dashboard.db.deleteFrom("alert_rules").execute();
  await dashboard.db.deleteFrom("uptime_checks").execute();
  await dashboard.db.deleteFrom("notification_channels").execute();
  const created = await call("POST", "/channels", {
    kind: "email",
    addresses: ["ops@example.com"],
  });
  email = created.json<{ channel: { id: string } }>().channel.id;
  const webhook = await call("POST", "/channels", {
    kind: "webhook",
    url: "https://hooks.example.com/ottertrail",
  });
  hook = webhook.json<{ channel: { id: string } }>().channel.id;
  checkId = await insertCheck(projectId, "API health");
});

describe("alert rules", () => {
  test("are added, listed, read, changed, turned off and on, and deleted", async () => {
    const created = await call("POST", rules(), {
      name: "  API down  ",
      kind: "check_down",
      settings: { checkId },
      channelIds: [email, hook],
    });
    expect(created.statusCode).toBe(201);
    const { rule } = created.json<{ rule: { id: string } }>();
    expect(rule).toMatchObject({
      name: "API down",
      kind: "check_down",
      settings: { checkId },
      channelIds: [email, hook],
      enabled: true,
      disabledReason: null,
      firing: 0,
      lastFiredAt: null,
    });

    const spike = await call("POST", rules(), {
      kind: "error_spike",
      settings: { environment: "Staging", windowMinutes: 15, threshold: 50 },
      channelIds: [hook],
    });
    expect(spike.statusCode).toBe(201);
    expect(spike.json()).toMatchObject({
      rule: {
        // The kind's name stands in for an empty one; environments are lower case.
        name: "Error spike",
        settings: { environment: "staging", fingerprint: null, windowMinutes: 15, threshold: 50 },
      },
    });
    const certificate = await call("POST", rules(), {
      kind: "certificate_expiring",
      settings: { checkId: null },
      channelIds: [email],
    });
    expect(certificate.json()).toMatchObject({ rule: { settings: { checkId: null, days: 14 } } });

    const list = await call("GET", rules());
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ maxRules: MAX_RULES, hourlyCap: 20, timeZone: "UTC" });
    expect(list.json<{ rules: { name: string }[] }>().rules.map((item) => item.name)).toEqual([
      "API down",
      "Error spike",
      "Certificate expiring",
    ]);

    const read = await call("GET", rules(`/${rule.id}`));
    expect(read.json()).toMatchObject({ rule: { id: rule.id, name: "API down" } });

    const off = await call("PATCH", rules(`/${rule.id}`), { enabled: false });
    expect(off.json()).toMatchObject({ rule: { enabled: false, channelIds: [email, hook] } });
    const renamed = await call("PATCH", rules(`/${rule.id}`), {
      name: "Down",
      enabled: true,
      channelIds: [hook],
    });
    expect(renamed.json()).toMatchObject({
      rule: { name: "Down", enabled: true, channelIds: [hook], settings: { checkId } },
    });
    // Another kind takes its own settings, with defaults.
    const changed = await call("PATCH", rules(`/${rule.id}`), {
      kind: "certificate_expiring",
      settings: { days: 30 },
    });
    expect(changed.json()).toMatchObject({
      rule: { kind: "certificate_expiring", settings: { checkId: null, days: 30 } },
    });

    expect((await call("DELETE", rules(`/${rule.id}`))).statusCode).toBe(204);
    expect((await call("GET", rules(`/${rule.id}`))).json()).toEqual({
      error: "rule_not_found",
      message: "The project has no alert rule with this ID.",
    });
    expect((await call("DELETE", rules(`/${rule.id}`))).statusCode).toBe(404);
  });

  test("are refused with an unknown channel, another project's check, or bad settings", async () => {
    const unknown = await call("POST", rules(), {
      kind: "check_down",
      channelIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({
      error: "channel_not_found",
      message: "This instance has no notification channel with one of these IDs.",
    });

    const foreign = await insertCheck(otherProjectId, "Blog home");
    const other = await call("POST", rules(), {
      kind: "check_down",
      settings: { checkId: foreign },
      channelIds: [email],
    });
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({
      error: "check_not_found",
      message: "The project has no check with this ID.",
    });

    const none = await call("POST", rules(), { kind: "error_new", channelIds: [] });
    expect(none.json()).toEqual({
      error: "invalid_channels",
      message: "Choose at least one channel to send to.",
    });
    for (const body of [
      { kind: "error_spike", settings: { windowMinutes: 4 }, channelIds: [email] },
      { kind: "error_spike", settings: { threshold: 0 }, channelIds: [email] },
      { kind: "certificate_expiring", settings: { days: 91 }, channelIds: [email] },
      { kind: "error_new", settings: { environment: "not an environment" }, channelIds: [email] },
      { kind: "error_spike", settings: { fingerprint: "nope" }, channelIds: [email] },
      { kind: "page_down", channelIds: [email] },
      { kind: "check_down", channelIds: ["not-a-uuid"] },
      { kind: "check_down", name: "x".repeat(201), channelIds: [email] },
    ]) {
      const refused = await call("POST", rules(), body);
      expect({ body, status: refused.statusCode }).toEqual({ body, status: 400 });
    }
    const long = await call("POST", rules(), {
      kind: "check_down",
      name: "x".repeat(101),
      channelIds: [email],
    });
    expect(long.json()).toMatchObject({ error: "invalid_name" });

    // A change is checked the same way.
    const created = await call("POST", rules(), { kind: "check_down", channelIds: [email] });
    const { rule } = created.json<{ rule: { id: string } }>();
    const moved = await call("PATCH", rules(`/${rule.id}`), { settings: { checkId: foreign } });
    expect(moved.json()).toMatchObject({ error: "check_not_found" });
    expect((await call("GET", rules())).json<{ rules: unknown[] }>().rules).toHaveLength(1);
  });

  test(`are at most ${MAX_RULES} per project`, async () => {
    await dashboard.db
      .insertInto("alert_rules")
      .values(
        Array.from({ length: MAX_RULES }, (_, index) => ({
          project_id: projectId,
          name: `Rule ${index}`,
          kind: "error_new",
          settings: "{}",
          channel_ids: [email],
        })),
      )
      .execute();
    const refused = await call("POST", rules(), { kind: "error_new", channelIds: [email] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: "too_many_rules",
      message: `A project has at most ${MAX_RULES} alert rules.`,
    });
  });

  test("need a session, a project that exists, and the dashboard's origin for changes", async () => {
    const signedOut = await dashboard.app.inject({
      method: "GET",
      url: `/api${rules()}`,
    });
    expect(signedOut.statusCode).toBe(401);
    for (const path of ["/alert-rules", "/alerts", "/alerts/firing"]) {
      const missing = await call("GET", `/projects/00000000-0000-4000-8000-000000000000${path}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "not_found" });
    }
    const elsewhere = await call(
      "POST",
      rules(),
      { kind: "error_new", channelIds: [email] },
      { origin: "https://evil.example" },
    );
    expect(elsewhere.statusCode).toBe(403);
    // Another project's rule is not reachable through this project.
    const created = await call("POST", `/projects/${otherProjectId}/alert-rules`, {
      kind: "error_new",
      channelIds: [email],
    });
    const { rule } = created.json<{ rule: { id: string } }>();
    expect((await call("GET", rules(`/${rule.id}`))).statusCode).toBe(404);
    expect((await call("PATCH", rules(`/${rule.id}`), { enabled: false })).statusCode).toBe(404);
    expect((await call("DELETE", rules(`/${rule.id}`))).statusCode).toBe(404);
    expect((await call("GET", rules(`/${rule.id}/history`))).statusCode).toBe(404);
  });
});

describe("changing a rule", () => {
  test("keeps a firing spike's alert when only its name or channels change, and forgets it when its settings do", async () => {
    const { rule } = (
      await call("POST", rules(), {
        kind: "error_spike",
        settings: { environment: "production", windowMinutes: 15, threshold: 5 },
        channelIds: [email],
      })
    ).json<{ rule: { id: string } }>();
    await dashboard.db
      .insertInto("alert_states")
      .values({ rule_id: rule.id, subject: "", firing: true, since: new Date() })
      .execute();
    const renamed = await call("PATCH", rules(`/${rule.id}`), {
      name: "Production spike",
      channelIds: [email, hook],
    });
    expect(renamed.json()).toMatchObject({ rule: { firing: 1 } });
    const same = await call("PATCH", rules(`/${rule.id}`), {
      settings: { threshold: 5, windowMinutes: 15, environment: "production" },
    });
    expect(same.json()).toMatchObject({ rule: { firing: 1 } });
    const changed = await call("PATCH", rules(`/${rule.id}`), { settings: { threshold: 6 } });
    expect(changed.json()).toMatchObject({ rule: { firing: 0 } });
  });
});

describe("deleting what rules name", () => {
  test("a deleted check turns off the rules that watched only it, with the reason, and ends its alerts", async () => {
    await dashboard.db.updateTable("uptime_checks").set({ state: "down" }).execute();
    const only = (
      await call("POST", rules(), {
        kind: "check_down",
        settings: { checkId },
        channelIds: [email],
      })
    ).json<{ rule: { id: string } }>().rule;
    const all = (await call("POST", rules(), { kind: "check_down", channelIds: [email] })).json<{
      rule: { id: string };
    }>().rule;
    await evaluateCheckDown({ db: dashboard.db, publicUrl: PUBLIC_URL }, {}, new Date());
    const firing = await call("GET", `/projects/${projectId}/alerts/firing`);
    expect(firing.json<{ alerts: unknown[] }>().alerts).toHaveLength(2);

    expect((await call("DELETE", `/projects/${projectId}/checks/${checkId}`)).statusCode).toBe(204);
    const list = (await call("GET", rules())).json<{
      rules: { id: string; enabled: boolean; disabledReason: string | null; firing: number }[];
    }>().rules;
    expect(list.find((rule) => rule.id === only.id)).toMatchObject({
      enabled: false,
      disabledReason: CHECK_DELETED_REASON,
      firing: 0,
    });
    expect(list.find((rule) => rule.id === all.id)).toMatchObject({
      enabled: true,
      disabledReason: null,
      firing: 0,
    });
    expect(
      (await call("GET", `/projects/${projectId}/alerts/firing`)).json<{ alerts: unknown[] }>()
        .alerts,
    ).toEqual([]);
    const history = (await call("GET", `/projects/${projectId}/alerts`)).json<{
      alerts: { resolvedAt: string | null }[];
    }>().alerts;
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.resolvedAt !== null)).toBe(true);

    // Turned on again, it needs a check that exists.
    const again = await call("PATCH", rules(`/${only.id}`), { enabled: true });
    expect(again.json()).toMatchObject({ error: "check_not_found" });
    const other = await insertCheck(projectId, "Shop home");
    const fixed = await call("PATCH", rules(`/${only.id}`), {
      enabled: true,
      settings: { checkId: other },
    });
    expect(fixed.json()).toMatchObject({ rule: { enabled: true, disabledReason: null } });
  });

  test("a deleted channel leaves its rules, and turns off a rule left with none", async () => {
    const both = (
      await call("POST", rules(), { kind: "error_new", channelIds: [email, hook] })
    ).json<{ rule: { id: string } }>().rule;
    const onlyHook = (
      await call("POST", rules(), { kind: "error_regressed", channelIds: [hook] })
    ).json<{ rule: { id: string } }>().rule;
    expect((await call("DELETE", `/channels/${hook}`)).statusCode).toBe(204);
    const list = (await call("GET", rules())).json<{
      rules: {
        id: string;
        channelIds: string[];
        enabled: boolean;
        disabledReason: string | null;
      }[];
    }>().rules;
    expect(list.find((rule) => rule.id === both.id)).toMatchObject({
      channelIds: [email],
      enabled: true,
      disabledReason: null,
    });
    expect(list.find((rule) => rule.id === onlyHook.id)).toMatchObject({
      channelIds: [],
      enabled: false,
      disabledReason: CHANNELS_DELETED_REASON,
    });
  });
});

describe("a rule the server turned off", () => {
  test("is on again once a save gives it a channel, or a check that exists", async () => {
    const hookOnly = (await call("POST", rules(), { kind: "error_new", channelIds: [hook] })).json<{
      rule: { id: string };
    }>().rule;
    const onCheck = (
      await call("POST", rules(), {
        kind: "check_down",
        settings: { checkId },
        channelIds: [email],
      })
    ).json<{ rule: { id: string } }>().rule;
    await call("DELETE", `/channels/${hook}`);
    await call("DELETE", `/projects/${projectId}/checks/${checkId}`);

    const channel = await call("PATCH", rules(`/${hookOnly.id}`), { channelIds: [email] });
    expect(channel.json()).toMatchObject({
      rule: { enabled: true, disabledReason: null, channelIds: [email] },
    });
    const other = await insertCheck(projectId, "Shop home");
    const check = await call("PATCH", rules(`/${onCheck.id}`), { settings: { checkId: other } });
    expect(check.json()).toMatchObject({ rule: { enabled: true, disabledReason: null } });
    // A save that says to stay off does.
    await call("DELETE", `/projects/${projectId}/checks/${other}`);
    const third = await insertCheck(projectId, "Blog");
    const off = await call("PATCH", rules(`/${onCheck.id}`), {
      settings: { checkId: third },
      enabled: false,
    });
    expect(off.json()).toMatchObject({ rule: { enabled: false } });
  });
});

/**
 * A save's transaction, held open where createRule holds it: the check
 * or channel it names locked FOR SHARE, the rule written. The deletion
 * starts meanwhile, and the save commits after it has had time to run.
 */
async function saveDuring(
  lock: "uptime_checks" | "notification_channels",
  id: string,
  rule: { kind: string; settings: object; channel_ids: string[] },
  deletion: () => Promise<boolean>,
) {
  let deleting: Promise<boolean> = Promise.resolve(false);
  const ruleId = await dashboard.db.transaction().execute(async (trx) => {
    await trx.selectFrom(lock).select("id").where("id", "=", id).forShare().execute();
    const row = await trx
      .insertInto("alert_rules")
      .values({
        project_id: projectId,
        name: "Saved meanwhile",
        kind: rule.kind,
        settings: JSON.stringify(rule.settings),
        channel_ids: rule.channel_ids,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    deleting = deletion();
    await new Promise((done) => setTimeout(done, 300));
    return row.id;
  });
  expect(await deleting).toBe(true);
  return ruleId;
}

describe("deleting a check or a channel while a rule naming it is saved", () => {
  test("a check: the rule saved first is turned off by the deletion", async () => {
    const ruleId = await saveDuring(
      "uptime_checks",
      checkId,
      { kind: "check_down", settings: { checkId }, channel_ids: [email] },
      () => deleteCheck(dashboard.db, projectId, checkId),
    );
    const rule = (await call("GET", rules(`/${ruleId}`))).json<{ rule: object }>().rule;
    expect(rule).toMatchObject({ enabled: false, disabledReason: CHECK_DELETED_REASON });
  });

  test("a channel: the rule saved first drops it, and is turned off with none left", async () => {
    const ruleId = await saveDuring(
      "notification_channels",
      hook,
      { kind: "error_new", settings: {}, channel_ids: [hook] },
      () => deleteChannel(dashboard.db, hook),
    );
    const rule = (await call("GET", rules(`/${ruleId}`))).json<{ rule: object }>().rule;
    expect(rule).toMatchObject({
      channelIds: [],
      enabled: false,
      disabledReason: CHANNELS_DELETED_REASON,
    });
  });
});

describe("alert history and firing alerts", () => {
  test("list the project's and a rule's alerts, newest first, a page at a time", async () => {
    const rule = (await call("POST", rules(), { kind: "check_down", channelIds: [email] })).json<{
      rule: { id: string };
    }>().rule;
    const context = { db: dashboard.db, publicUrl: PUBLIC_URL };
    // Three times down and up.
    for (let round = 0; round < 3; round += 1) {
      await dashboard.db.updateTable("uptime_checks").set({ state: "down" }).execute();
      await evaluateCheckDown(context, {}, new Date(Date.now() - (10 - 2 * round) * 60_000));
      await dashboard.db.updateTable("uptime_checks").set({ state: "up" }).execute();
      await evaluateCheckDown(context, {}, new Date(Date.now() - (9 - 2 * round) * 60_000));
    }
    await dashboard.db.updateTable("uptime_checks").set({ state: "down" }).execute();
    await evaluateCheckDown(context, {}, new Date());

    const firing = (await call("GET", `/projects/${projectId}/alerts/firing`)).json<{
      alerts: { ruleId: string; subject: string; subjectName: string; message: string }[];
    }>().alerts;
    expect(firing).toEqual([
      expect.objectContaining({
        ruleId: rule.id,
        subject: checkId,
        subjectName: "API health",
        message: 'Shop: the check "API health" (https://api-health.example/) is down.',
      }),
    ]);

    const first = await call("GET", rules(`/${rule.id}/history?limit=3`));
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      retentionDays: number;
      alerts: { id: string; resolvedAt: string | null; notified: boolean; kind: string }[];
      next: string | null;
    }>();
    expect(page.retentionDays).toBe(90);
    expect(page.alerts).toHaveLength(3);
    expect(page.alerts[0]).toMatchObject({ resolvedAt: null, notified: true, kind: "check_down" });
    expect(page.next).toBe(page.alerts[2]?.id);
    const second = (
      await call("GET", rules(`/${rule.id}/history?limit=3&before=${page.next ?? ""}`))
    ).json<{ alerts: unknown[]; next: string | null }>();
    expect(second.alerts).toHaveLength(1);
    expect(second.next).toBeNull();
    const project = (await call("GET", `/projects/${projectId}/alerts`)).json<{
      alerts: unknown[];
    }>();
    expect(project.alerts).toHaveLength(4);
    expect((await call("GET", rules(`/${rule.id}/history?limit=101`))).statusCode).toBe(400);

    // The rule's list says it fires now.
    const listed = (await call("GET", rules())).json<{
      rules: { firing: number; lastFiredAt: string | null }[];
    }>().rules;
    expect(listed[0]?.firing).toBe(1);
    expect(listed[0]?.lastFiredAt).not.toBeNull();

    // A new name keeps what it watches, and its alert.
    const renamed = await call("PATCH", rules(`/${rule.id}`), { name: "Still down" });
    expect(renamed.json()).toMatchObject({ rule: { name: "Still down", firing: 1 } });

    // Turned off: its alerts end, and none fires.
    await call("PATCH", rules(`/${rule.id}`), { enabled: false });
    expect(
      (await call("GET", `/projects/${projectId}/alerts/firing`)).json<{ alerts: unknown[] }>()
        .alerts,
    ).toEqual([]);
  });
});
