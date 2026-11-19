/**
 * The demo shop's uptime checks and alert rules, for the development seed
 * (seed-data.ts). Thirty days of check runs are played in time order
 * through the worker's own steps: each run's outcome is recorded on its
 * check (recordOutcome, which opens and closes incidents) and written to
 * ClickHouse as the scheduler writes it (resultRow), and the alert rules
 * are evaluated by the worker's evaluators at the moments it would have,
 * so incidents, alert history, and the alerts firing now are the rows the
 * worker makes.
 */
import type { Kysely } from "kysely";

import { evaluateCertificates, evaluateCheckDown } from "../src/alerts/check-rules.ts";
import { evaluateErrorRules } from "../src/alerts/error-rules.ts";
import type { AlertContext } from "../src/alerts/fire.ts";
import type { RuleKind, SettingsInput } from "../src/alerts/kinds.ts";
import { createRule, ruleValuesOf } from "../src/alerts/rules.ts";
import type { ClickHouseClient } from "../src/clickhouse/clickhouse.ts";
import { insertRows } from "../src/clickhouse/insert.ts";
import {
  fromClickHouseTime,
  QueryParams,
  queryRows,
  type Reader,
} from "../src/clickhouse/query.ts";
import type { Database } from "../src/db/schema.ts";
import { checkValuesOf, createCheck, firstRunAt, recordOutcome } from "../src/uptime/checks.ts";
import type { CheckOutcome } from "../src/uptime/request.ts";
import { resultRow } from "../src/uptime/results.ts";
import { ERROR } from "../src/visits/visits.ts";
import type { Random } from "./seed-random.ts";
import { DAY_MS } from "./seed-site.ts";

const MINUTE_MS = 60_000;
const UPTIME_DAYS = 30;
/** Rows per ClickHouse insert. */
const BATCH = 10_000;

export interface MonitoringOptions {
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  publicUrl: string;
  projectId: string;
  channelId: string;
  rng: Random;
  now: Date;
  /** When the regressed error's group was resolved, and its fingerprint. */
  regression: { fingerprint: string; resolvedAt: Date };
  /** When the burst of errors began that the spike rule catches. */
  spikeAt: Date;
}

export interface MonitoringCounts {
  checks: number;
  checkResults: number;
  incidents: number;
  rules: number;
  alerts: number;
  firing: number;
}

interface CheckPlan {
  name: string;
  url: string;
  intervalSeconds: number;
  /** The run's outcome at a moment. */
  outcome: (at: number) => CheckOutcome;
}

/** Response times rise and fall with the day's traffic. */
const daily = (at: number) =>
  0.85 + 0.3 * Math.sin(((new Date(at).getUTCHours() - 8) / 24) * 2 * Math.PI);

const up = (statusCode: number, responseMs: number, tlsExpiresAt: Date | null): CheckOutcome => ({
  up: true,
  statusCode,
  responseMs: Math.round(responseMs),
  cause: null,
  detail: "",
  tlsExpiresAt,
});

/** Adds a rule as the Alerts page does: its values checked first. */
async function addRule(
  options: MonitoringOptions,
  input: { name: string; kind: RuleKind; settings: SettingsInput },
  at: Date,
): Promise<string> {
  const values = ruleValuesOf({ ...input, channelIds: [options.channelId] });
  if ("error" in values) throw new Error(`Rule "${input.name}": ${values.message}`);
  const result = await createRule(options.db, options.projectId, values, at);
  if (!("rule" in result)) throw new Error(`Rule "${input.name}" was not added`);
  return result.rule.id;
}

/**
 * Three checks with 30 days of runs: a storefront with one incident 12
 * days ago, an API whose certificate expires in 9 days, and a status page
 * down for the last 47 minutes. Then the alert rules, evaluated as the
 * worker would have.
 */
export async function seedMonitoring(options: MonitoringOptions): Promise<MonitoringCounts> {
  const { db, clickhouse, projectId, rng, now } = options;
  const nowMs = now.getTime();
  const start = nowMs - UPTIME_DAYS * DAY_MS - 30 * MINUTE_MS;
  const context: AlertContext = { db, publicUrl: options.publicUrl };
  const reader: Reader = { client: clickhouse };

  // Rules on checks first: they watch every check of the project.
  const rulesAt = new Date(start - 10 * MINUTE_MS);
  const ruleIds = [
    await addRule(
      options,
      { name: "A check is down", kind: "check_down", settings: { checkId: null } },
      rulesAt,
    ),
    await addRule(
      options,
      {
        name: "Certificate expires within 14 days",
        kind: "certificate_expiring",
        settings: { checkId: null, days: 14 },
      },
      rulesAt,
    ),
  ];

  const incidentAt = nowMs - 12 * DAY_MS - 9 * 3_600_000;
  const blipAt = nowMs - 3 * DAY_MS - 5 * 3_600_000;
  const statusDownAt = nowMs - 47 * MINUTE_MS;
  const plans: CheckPlan[] = [
    {
      name: "Storefront",
      url: "https://example.com/",
      intervalSeconds: 300,
      outcome: (at) =>
        at >= incidentAt && at < incidentAt + 25 * MINUTE_MS
          ? {
              up: false,
              statusCode: 502,
              responseMs: rng.int(30, 90),
              cause: "status",
              detail: "It answered 502, which does not count as up.",
              tlsExpiresAt: new Date(nowMs + 61 * DAY_MS),
            }
          : up(200, rng.logNormal(210 * daily(at), 0.25), new Date(nowMs + 61 * DAY_MS)),
    },
    {
      name: "Checkout API",
      url: "https://example.net/",
      intervalSeconds: 300,
      outcome: (at) =>
        at >= blipAt && at < blipAt + 5 * MINUTE_MS
          ? {
              up: false,
              statusCode: null,
              responseMs: 10_000,
              cause: "timeout",
              detail: "No complete answer within 10 seconds.",
              tlsExpiresAt: null,
            }
          : up(200, rng.logNormal(140 * daily(at), 0.3), new Date(nowMs + 9 * DAY_MS)),
    },
    {
      name: "Status page",
      url: "https://status.demo-shop.example/",
      intervalSeconds: 600,
      outcome: (at) =>
        at >= statusDownAt
          ? {
              up: false,
              statusCode: null,
              responseMs: rng.int(20, 60),
              cause: "dns",
              detail: "The host could not be resolved (ENOTFOUND).",
              tlsExpiresAt: null,
            }
          : up(200, rng.logNormal(90, 0.3), new Date(nowMs + 40 * DAY_MS)),
    },
  ];

  const checks: { id: string; plan: CheckPlan }[] = [];
  for (const plan of plans) {
    const values = checkValuesOf({
      name: plan.name,
      url: plan.url,
      intervalSeconds: plan.intervalSeconds,
    });
    if ("error" in values) throw new Error(`Check "${plan.name}": ${values.message}`);
    const created = await createCheck(db, projectId, values, new Date(start));
    if (!("check" in created)) throw new Error(`Check "${plan.name}" was not added`);
    checks.push({ id: created.check.id, plan });
  }

  // Every run of every check, in time order.
  const runs = checks
    .flatMap((check) => {
      const step = check.plan.intervalSeconds * 1000;
      const first = start + rng.int(0, step);
      const times: { check: (typeof checks)[number]; at: number }[] = [];
      for (let at = first; at <= nowMs - 30_000; at += step) times.push({ check, at });
      return times;
    })
    .toSorted((a, b) => a.at - b.at);

  let rows: object[] = [];
  let checkResults = 0;
  const failing = new Set<string>();
  const lastOf = new Map<string, { at: number; outcome: CheckOutcome }>();
  for (const [index, run] of runs.entries()) {
    const outcome = run.check.plan.outcome(run.at);
    const at = new Date(run.at);
    const checkRef = { id: run.check.id, projectId };
    // The check's state changes only on a failure, the first success after
    // one, and its first run: only those are recorded as they happen; the
    // last run of each check is recorded below, for its latest answer.
    const first = !lastOf.has(run.check.id);
    if (first || !outcome.up || failing.has(run.check.id)) {
      const change = await recordOutcome(db, run.check.id, outcome, at);
      if (outcome.up) failing.delete(run.check.id);
      else failing.add(run.check.id);
      if (change !== null) await evaluateCheckDown(context, { projectId }, at);
    }
    lastOf.set(run.check.id, { at: run.at, outcome });
    rows.push(resultRow(checkRef, outcome, at));
    if (rows.length >= BATCH || index === runs.length - 1) {
      await insertRows(clickhouse, "check_results", rows);
      checkResults += rows.length;
      rows = [];
    }
  }
  for (const check of checks) {
    const last = lastOf.get(check.id);
    if (last !== undefined) await recordOutcome(db, check.id, last.outcome, new Date(last.at));
    // Due again soon, as a check added now would be, not overdue for a month.
    await db
      .updateTable("uptime_checks")
      .set({ next_due_at: firstRunAt(now, check.plan.intervalSeconds, () => rng.next()) })
      .where("id", "=", check.id)
      .execute();
  }

  // Error rules, added three weeks ago, and rules on the services' telemetry.
  const errorRulesAt = new Date(nowMs - 21 * DAY_MS);
  ruleIds.push(
    await addRule(
      options,
      {
        name: "New error in production",
        kind: "error_new",
        settings: { environment: "production" },
      },
      errorRulesAt,
    ),
    await addRule(
      options,
      { name: "A resolved error is back", kind: "error_regressed", settings: {} },
      errorRulesAt,
    ),
    await addRule(
      options,
      {
        name: "Error spike in production",
        kind: "error_spike",
        settings: {
          environment: "production",
          fingerprint: null,
          windowMinutes: 10,
          threshold: 25,
        },
      },
      errorRulesAt,
    ),
  );
  const telemetryRulesAt = new Date(nowMs - 7 * DAY_MS);
  ruleIds.push(
    await addRule(
      options,
      {
        name: "Search is slow",
        kind: "route_latency",
        settings: {
          environment: "production",
          service: "web",
          route: "/api/search",
          percentile: "p95",
          thresholdMs: 2500,
          windowMinutes: 30,
          minRequests: 5,
        },
      },
      telemetryRulesAt,
    ),
    await addRule(
      options,
      {
        name: "Charges failing",
        kind: "route_failures",
        settings: {
          environment: "production",
          service: "billing",
          route: "/charges",
          thresholdPercent: 20,
          windowMinutes: 30,
          minRequests: 5,
        },
      },
      telemetryRulesAt,
    ),
    await addRule(
      options,
      {
        name: "Receipt queue backing up",
        kind: "metric_threshold",
        settings: {
          environment: "production",
          metric: "jobs.queue.depth",
          metricKind: "gauge",
          aggregate: "avg",
          direction: "above",
          value: 50,
          windowMinutes: 15,
        },
      },
      telemetryRulesAt,
    ),
  );

  // The error rules, evaluated when the worker would have told of something:
  // each production group's first arrival after the rules came on, the
  // regression's, and around the spike.
  const params = new QueryParams();
  const firsts = await queryRows<{ first: string }>(
    reader,
    `SELECT min(received_at) AS first
     FROM events
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND name = '${ERROR}' AND error_fingerprint != '' AND environment = 'production'
     GROUP BY error_fingerprint`,
    params,
  );
  const regressionParams = new QueryParams();
  const [regressed] = await queryRows<{ first: string }>(
    reader,
    `SELECT min(received_at) AS first
     FROM events
     WHERE project_id = ${regressionParams.add(projectId, "UUID")}
       AND name = '${ERROR}'
       AND error_fingerprint = ${regressionParams.add(options.regression.fingerprint, "String")}
       AND occurred_at > ${regressionParams.time(options.regression.resolvedAt)}`,
    regressionParams,
  );
  const spike = options.spikeAt.getTime();
  const moments = [
    ...firsts.map((row) => fromClickHouseTime(row.first).getTime()),
    ...(regressed === undefined || regressed.first.startsWith("1970")
      ? []
      : [fromClickHouseTime(regressed.first).getTime()]),
    spike + 7 * MINUTE_MS,
    spike + 20 * MINUTE_MS,
    spike + 40 * MINUTE_MS,
  ]
    .filter((at) => at > errorRulesAt.getTime() && at < nowMs - 2 * MINUTE_MS)
    .map((at) => at + 90_000)
    .toSorted((a, b) => a - b);
  for (const at of moments) await evaluateErrorRules(context, reader, new Date(at), { projectId });

  // And now, as the worker's next minute would.
  await evaluateCheckDown(context, { projectId }, now);
  await evaluateCertificates(context, { projectId }, now);
  await evaluateErrorRules(context, reader, now, { projectId });

  const [incidents, alerts, firing] = await Promise.all([
    db
      .selectFrom("uptime_incidents")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("alert_history")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("alert_states")
      .innerJoin("alert_rules", "alert_rules.id", "alert_states.rule_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("alert_rules.project_id", "=", projectId)
      .where("alert_states.firing", "=", true)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    checks: checks.length,
    checkResults,
    incidents: Number(incidents.n),
    rules: ruleIds.length,
    alerts: Number(alerts.n),
    firing: Number(firing.n),
  };
}
