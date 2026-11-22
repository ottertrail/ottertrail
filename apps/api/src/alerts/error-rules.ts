import { type Kysely, sql } from "kysely";

import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import { MAX_FUTURE_MS } from "../collection/server-events.ts";
import type { Database } from "../db/schema.ts";
import { resolutions, statusOf } from "../errors/errors.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { ERROR } from "../visits/visits.ts";
import type { Counts } from "./check-rules.ts";
import {
  type AlertContext,
  cut,
  dashboardLink,
  fire,
  resolve,
  type RuleRead,
  setClearSince,
} from "./fire.ts";
import {
  isRuleKind,
  newErrorSettingsOf,
  type RuleKind,
  type SpikeSettings,
  spikeSettingsOf,
} from "./kinds.ts";

/**
 * Error rules (docs/uptime-alerts.md, "Alerts"): new, regressed, and
 * spiking errors, evaluated by the worker every minute from the error
 * list's own data in ClickHouse (errors/errors.ts), for browser and
 * server errors alike. Each project's rules are evaluated together:
 *
 * - "New" and "regressed" read the error groups whose occurrences arrived
 *   since the project's last evaluation: one query over the arrivals,
 *   kept to the days an arrival can have happened on (the table's
 *   project and day order), a page of MAX_WINDOW_GROUPS groups at a time
 *   in the order of their first arrival. A group's history is then read
 *   only when PostgreSQL does not know it yet (alert_error_groups): the
 *   bloom filter on the fingerprint skips the parts without it, which
 *   helps for a rare group but not for a frequent one, present in nearly
 *   every part, so each group's first arrival is looked up in ClickHouse
 *   once and kept. Arrivals, not occurrence times: an error that happened
 *   a while ago but arrives now is still seen once.
 * - "Spike" counts each rule's window (5 to 60 minutes), all the
 *   project's spike rules in one query, evaluated apart from the others,
 *   so a failure of one does not silence the other.
 *
 * Every query filters by project first, takes its values as parameters,
 * and runs with the dashboard's time and memory limits
 * (DASHBOARD_SETTINGS). The evaluation reads up to ARRIVAL_LAG_MS ago, so
 * an insert still under way when it runs is read the next minute; after
 * a gap (a worker that was stopped) it starts where it ended, but reads
 * at most MAX_CATCH_UP_MS, so a long outage does not end in a flood. A
 * rule reads nothing that arrived before it was created or turned on
 * (active_since).
 */

/** How far behind now the arrivals read end: inserts take a moment to land. */
export const ARRIVAL_LAG_MS = 30_000;
/** The longest stretch of arrivals one evaluation reads, after a gap. */
export const MAX_CATCH_UP_MS = 60 * 60 * 1000;
/** Error groups (per environment) in a page of arrivals. */
export const MAX_WINDOW_GROUPS = 1000;
/** Pages of arrivals one evaluation reads; the rest wait for the next minute. */
export const MAX_PAGES = 5;
/** Fingerprints per history query, so a query's parameters stay small. */
const CHUNK = 200;
/** The longest error message a notification quotes. */
const MESSAGE_CHARS = 200;

const ERROR_KINDS: RuleKind[] = ["error_new", "error_regressed", "error_spike"];

interface ErrorRule {
  id: string;
  projectId: string;
  projectName: string;
  kind: RuleKind;
  settings: unknown;
  /** When it was created or turned on: it reads nothing that arrived before. */
  activeSince: Date;
  /** Its kind and settings as read, which an alert checks again (fire.ts). */
  read: RuleRead;
}

/** The groups whose occurrences arrived in the window, per environment. */
interface Arrival {
  fingerprint: string;
  environment: string;
  firstArrival: Date;
  lastArrival: Date;
  lastOccurred: Date;
  type: string;
  message: string;
}

/** Where a page of arrivals starts: after this group, in their order. */
export interface ArrivalKey {
  firstArrival: Date;
  fingerprint: string;
  environment: string;
}

/**
 * A page of the groups whose occurrences arrived in (from, until], per
 * environment, in the order of their first arrival in it, then
 * fingerprint and environment, after `after`. Ties are common (one batch
 * shares one arrival time), hence the whole key.
 */
async function arrivals(
  reader: Reader,
  projectId: string,
  from: Date,
  until: Date,
  after: ArrivalKey | null,
  pageSize: number,
): Promise<{ rows: Arrival[]; truncated: boolean }> {
  const params = new QueryParams();
  const rows = await queryRows<{
    fingerprint: string;
    environment: string;
    first_arrival: string;
    last_arrival: string;
    last_occurred: string;
    type: string;
    message: string;
  }>(
    reader,
    // An event is at most a day old when it arrives (collection/normalize.ts),
    // and a server's clock at most a few minutes ahead: the occurrence time
    // keeps the read to the days such arrivals can be on.
    `SELECT error_fingerprint AS fingerprint,
            environment,
            min(received_at) AS first_arrival,
            max(received_at) AS last_arrival,
            max(occurred_at) AS last_occurred,
            argMax(error_type, received_at) AS type,
            argMax(error_message, received_at) AS message
     FROM events
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND occurred_at >= ${params.time(new Date(from.getTime() - MAX_EVENT_AGE_MS))}
       AND occurred_at <= ${params.time(new Date(until.getTime() + MAX_FUTURE_MS))}
       AND received_at > ${params.time(from)}
       AND received_at <= ${params.time(until)}
       AND name = '${ERROR}'
       AND error_fingerprint != ''
     GROUP BY fingerprint, environment
     ${
       after === null
         ? ""
         : `HAVING (first_arrival, fingerprint, environment) > (${params.time(after.firstArrival)}, ${params.add(after.fingerprint, "String")}, ${params.add(after.environment, "String")})`
     }
     ORDER BY first_arrival, fingerprint, environment
     LIMIT ${pageSize + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return {
    rows: rows.slice(0, pageSize).map((row) => ({
      fingerprint: row.fingerprint,
      environment: row.environment,
      firstArrival: fromClickHouseTime(row.first_arrival),
      lastArrival: fromClickHouseTime(row.last_arrival),
      lastOccurred: fromClickHouseTime(row.last_occurred),
      type: row.type,
      message: row.message,
    })),
    truncated: rows.length > pageSize,
  };
}

/** How much one evaluation reads of a project's arrivals: groups per page, and pages. */
export interface PageLimits {
  pageSize: number;
  maxPages: number;
}

/**
 * When each of these groups first arrived, per environment: from
 * PostgreSQL's alert_error_groups for the (fingerprint, environment)
 * pairs it knows, from ClickHouse's whole history for the fingerprints
 * with a pair it does not, which are then kept there.
 */
async function firstArrivals(
  db: Kysely<Database>,
  reader: Reader,
  projectId: string,
  pairs: { fingerprint: string; environment: string }[],
): Promise<Map<string, Map<string, Date>>> {
  const found = new Map<string, Map<string, Date>>();
  const add = (fingerprint: string, environment: string, first: Date) => {
    const byEnvironment = found.get(fingerprint) ?? new Map<string, Date>();
    const known = byEnvironment.get(environment);
    if (known === undefined || first < known) byEnvironment.set(environment, first);
    found.set(fingerprint, byEnvironment);
  };
  const fingerprints = [...new Set(pairs.map((pair) => pair.fingerprint))];
  for (let start = 0; start < fingerprints.length; start += CHUNK) {
    const known = await db
      .selectFrom("alert_error_groups")
      .select(["fingerprint", "environment", "first_arrival"])
      .where("project_id", "=", projectId)
      .where("fingerprint", "in", fingerprints.slice(start, start + CHUNK))
      .execute();
    for (const row of known) add(row.fingerprint, row.environment, row.first_arrival);
  }
  const unknown = [
    ...new Set(
      pairs
        .filter((pair) => found.get(pair.fingerprint)?.has(pair.environment) !== true)
        .map((pair) => pair.fingerprint),
    ),
  ];
  for (let start = 0; start < unknown.length; start += CHUNK) {
    const params = new QueryParams();
    const rows = await queryRows<{ fingerprint: string; environment: string; first: string }>(
      reader,
      `SELECT error_fingerprint AS fingerprint, environment, min(received_at) AS first
       FROM events
       WHERE project_id = ${params.add(projectId, "UUID")}
         AND name = '${ERROR}'
         AND error_fingerprint IN ${params.add(unknown.slice(start, start + CHUNK), "Array(String)")}
       GROUP BY fingerprint, environment`,
      params,
      DASHBOARD_SETTINGS,
    );
    if (rows.length === 0) continue;
    const values = rows.map((row) => ({
      project_id: projectId,
      fingerprint: row.fingerprint,
      environment: row.environment,
      first_arrival: fromClickHouseTime(row.first),
    }));
    for (const value of values) add(value.fingerprint, value.environment, value.first_arrival);
    await db
      .insertInto("alert_error_groups")
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(["project_id", "fingerprint", "environment"]).doUpdateSet({
          first_arrival: sql<Date>`least(alert_error_groups.first_arrival, excluded.first_arrival)`,
        }),
      )
      .execute();
  }
  return found;
}

/**
 * Each spike rule's count over its window up to `at`, with its window's
 * latest error type, message, and environment. Retries are counted once
 * by their event ID, so the query needs no FINAL, and PREWHERE reads the
 * other columns only for the rows in the longest window.
 */
async function spikeCounts(
  reader: Reader,
  projectId: string,
  rules: { settings: SpikeSettings }[],
  at: Date,
): Promise<{ count: number; type: string; message: string; environment: string }[]> {
  if (rules.length === 0) return [];
  const params = new QueryParams();
  const longest = Math.max(...rules.map((rule) => rule.settings.windowMinutes));
  const columns = rules.map(({ settings }, index) => {
    const start = new Date(at.getTime() - settings.windowMinutes * 60_000);
    const condition = [
      `occurred_at > ${params.time(start)}`,
      ...(settings.environment === null
        ? []
        : [`environment = ${params.add(settings.environment, "String")}`]),
      ...(settings.fingerprint === null
        ? []
        : [`error_fingerprint = ${params.add(settings.fingerprint, "String")}`]),
    ].join(" AND ");
    // The aliases are built from the index, never from input.
    return `uniqExactIf(event_id, ${condition}) AS c${index},
            argMaxIf(error_type, occurred_at, ${condition}) AS t${index},
            argMaxIf(error_message, occurred_at, ${condition}) AS m${index},
            argMaxIf(environment, occurred_at, ${condition}) AS e${index}`;
  });
  const [row] = await queryRows<Record<string, string>>(
    reader,
    `SELECT ${columns.join(",\n")}
     FROM events
     PREWHERE project_id = ${params.add(projectId, "UUID")}
       AND occurred_at > ${params.time(new Date(at.getTime() - longest * 60_000))}
       AND occurred_at <= ${params.time(at)}
     WHERE name = '${ERROR}'
       AND error_fingerprint != ''`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rules.map((_, index) => ({
    count: Number(row?.[`c${index}`] ?? 0),
    type: row?.[`t${index}`] ?? "",
    message: row?.[`m${index}`] ?? "",
    environment: row?.[`e${index}`] ?? "",
  }));
}

const errorText = (type: string, message: string) =>
  message === "" ? type || "An error" : `${type || "Error"}: ${cut(message, MESSAGE_CHARS)}`;

const errorLink = (context: AlertContext, projectId: string, fingerprint: string, env: string) =>
  dashboardLink(context.publicUrl, `/projects/${projectId}/errors/${fingerprint}`, { env });

const errorsLink = (context: AlertContext, projectId: string, env: string | null) =>
  dashboardLink(context.publicUrl, `/projects/${projectId}/errors`, env === null ? {} : { env });

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

/** What a project's evaluation did. */
export interface ErrorPass {
  projectId: string;
  from: Date;
  until: Date;
  /** Pages of arrivals read. */
  pages: number;
  /** More groups arrived than one evaluation reads: the rest wait for the next. */
  deferred: boolean;
  counts: Counts;
}

/** New and regressed errors among one page of arrivals. */
async function windowAlerts(
  context: AlertContext,
  reader: Reader,
  project: { id: string; name: string },
  rules: ErrorRule[],
  rows: Arrival[],
  window: { from: Date; until: Date },
  at: Date,
  counts: Counts,
) {
  const projectId = project.id;
  const newRules = rules.filter((rule) => rule.kind === "error_new");
  const firsts =
    newRules.length > 0 && rows.length > 0
      ? await firstArrivals(context.db, reader, projectId, rows)
      : new Map<string, Map<string, Date>>();
  for (const rule of newRules) {
    const { environment } = newErrorSettingsOf(rule.settings);
    // A group seen before the rule existed (or was turned on) is not new to it.
    const since = Math.max(window.from.getTime(), rule.activeSince.getTime());
    const seen = new Set<string>();
    for (const row of rows) {
      if (environment !== null && row.environment !== environment) continue;
      if (seen.has(row.fingerprint)) continue;
      seen.add(row.fingerprint);
      const byEnvironment = firsts.get(row.fingerprint);
      const times =
        environment === null
          ? [...(byEnvironment?.values() ?? [])]
          : [byEnvironment?.get(environment)].filter((time) => time !== undefined);
      const firstArrival = Math.min(...times.map((time) => time.getTime()));
      if (!(firstArrival > since && firstArrival <= window.until.getTime())) continue;
      counts[
        await fire(context, {
          ruleId: rule.id,
          rule: rule.read,
          subjectKey: row.fingerprint,
          subjectName: errorText(row.type, row.message),
          once: true,
          type: "error.new",
          message: `${project.name}: a new error in ${row.environment}. ${errorText(row.type, row.message)}`,
          url: errorLink(context, projectId, row.fingerprint, row.environment),
          subject: {
            type: "error",
            fingerprint: row.fingerprint,
            errorType: row.type,
            message: cut(row.message, MESSAGE_CHARS),
            environment: row.environment,
          },
          at,
        })
      ] += 1;
    }
  }
  const regressedRules = rules.filter((rule) => rule.kind === "error_regressed");
  if (regressedRules.length === 0 || rows.length === 0) return;
  const resolved = await resolutions(context.db, projectId, [
    ...new Set(rows.map((row) => row.fingerprint)),
  ]);
  // The latest occurrence among the arrivals, in any environment: a
  // status belongs to the project (errors/errors.ts).
  const latest = new Map<string, Arrival>();
  for (const row of rows) {
    const known = latest.get(row.fingerprint);
    if (known === undefined || row.lastOccurred > known.lastOccurred) {
      latest.set(row.fingerprint, row);
    }
  }
  for (const [fingerprint, row] of latest) {
    const resolution = resolved.get(fingerprint);
    if (resolution === undefined || statusOf(row.lastOccurred, resolution) !== "regressed") {
      continue;
    }
    for (const rule of regressedRules) {
      // What arrived before the rule existed (or was turned on) is not its to tell.
      if (row.lastArrival <= rule.activeSince) continue;
      counts[
        await fire(context, {
          ruleId: rule.id,
          rule: rule.read,
          subjectKey: fingerprint,
          subjectName: errorText(row.type, row.message),
          key: resolution.resolvedAt.toISOString(),
          once: true,
          type: "error.regressed",
          message: `${project.name}: an error resolved on ${resolution.resolvedAt.toISOString().slice(0, 10)} happened again, in ${row.environment}. ${errorText(row.type, row.message)}`,
          url: errorLink(context, projectId, fingerprint, row.environment),
          subject: {
            type: "error",
            fingerprint,
            errorType: row.type,
            message: cut(row.message, MESSAGE_CHARS),
            environment: row.environment,
            resolvedAt: resolution.resolvedAt.toISOString(),
          },
          at,
        })
      ] += 1;
    }
  }
}

/**
 * New and regressed errors: the arrivals since the project's cursor, a
 * page at a time, at most MAX_PAGES; when more are left, the cursor keeps
 * its time and the last group read, and the next minute goes on from it.
 */
async function evaluateWindow(
  context: AlertContext,
  reader: Reader,
  project: { id: string; name: string },
  rules: ErrorRule[],
  at: Date,
  counts: Counts,
  { pageSize, maxPages }: PageLimits,
): Promise<Omit<ErrorPass, "counts" | "projectId">> {
  const until = new Date(at.getTime() - ARRIVAL_LAG_MS);
  const cursor = await context.db
    .selectFrom("alert_evaluations")
    .selectAll()
    .where("project_id", "=", project.id)
    .executeTakeFirst();
  // A missing cursor, or one from before the rules were on (no error rule
  // was, for a while), starts where the earliest of them came on.
  const activeSince = Math.min(...rules.map((rule) => rule.activeSince.getTime()));
  const from = new Date(
    Math.max(
      cursor?.errors_until.getTime() ?? activeSince,
      activeSince,
      until.getTime() - MAX_CATCH_UP_MS,
    ),
  );
  // The last group read is a place within the arrivals since `from`: it
  // holds only while `from` is the cursor's time.
  let after: ArrivalKey | null =
    cursor !== undefined &&
    cursor.errors_until.getTime() === from.getTime() &&
    cursor.after_arrival !== null &&
    cursor.after_fingerprint !== null &&
    cursor.after_environment !== null
      ? {
          firstArrival: cursor.after_arrival,
          fingerprint: cursor.after_fingerprint,
          environment: cursor.after_environment,
        }
      : null;
  let pages = 0;
  let deferred = false;
  if (rules.length > 0 && until > from) {
    for (;;) {
      const page = await arrivals(reader, project.id, from, until, after, pageSize);
      pages += 1;
      await windowAlerts(context, reader, project, rules, page.rows, { from, until }, at, counts);
      const last = page.rows.at(-1);
      if (!page.truncated || last === undefined) {
        after = null;
        break;
      }
      after = {
        firstArrival: last.firstArrival,
        fingerprint: last.fingerprint,
        environment: last.environment,
      };
      if (pages >= maxPages) {
        deferred = true;
        break;
      }
    }
  }
  if (until > from || cursor === undefined) {
    const values = {
      errors_until: deferred ? from : until,
      after_arrival: after?.firstArrival ?? null,
      after_fingerprint: after?.fingerprint ?? null,
      after_environment: after?.environment ?? null,
    };
    await context.db
      .insertInto("alert_evaluations")
      .values({ project_id: project.id, ...values })
      .onConflict((conflict) => conflict.column("project_id").doUpdateSet(values))
      .execute();
  }
  return { from, until, pages, deferred };
}

/** Spike rules: each one's window counted now, fired or resolved. */
async function evaluateSpikes(
  context: AlertContext,
  reader: Reader,
  project: { id: string; name: string },
  rules: ErrorRule[],
  at: Date,
  counts: Counts,
) {
  const spikeRules = rules.map((rule) => ({ ...rule, settings: spikeSettingsOf(rule.settings) }));
  if (spikeRules.length === 0) return;
  const projectId = project.id;
  const results = await spikeCounts(reader, projectId, spikeRules, at);
  const states = await context.db
    .selectFrom("alert_states")
    .select(["rule_id", "firing", "clear_since"])
    .where(
      "rule_id",
      "in",
      spikeRules.map((rule) => rule.id),
    )
    .where("subject", "=", "")
    .execute();
  const stateOf = new Map(states.map((state) => [state.rule_id, state]));
  for (const [index, rule] of spikeRules.entries()) {
    const result = results[index] ?? { count: 0, type: "", message: "", environment: "" };
    const { count, type, message } = result;
    const { environment, fingerprint, windowMinutes, threshold } = rule.settings;
    const state = stateOf.get(rule.id);
    const where = environment === null ? "" : ` in ${environment}`;
    const what =
      fingerprint === null
        ? `errors${where}`
        : `occurrences of ${type === "" && message === "" ? `the error group ${fingerprint}` : errorText(type, message)}${where}`;
    const subject = { type: "errors", fingerprint, environment, count, threshold, windowMinutes };
    // One group in every environment: its page in the environment of its latest occurrence.
    const url =
      fingerprint === null
        ? errorsLink(context, projectId, environment)
        : errorLink(
            context,
            projectId,
            fingerprint,
            environment ?? (result.environment === "" ? "production" : result.environment),
          );
    if (count >= threshold) {
      if (state?.firing === true) {
        if (state.clear_since !== null) await setClearSince(context.db, rule.id, "", null);
        continue;
      }
      counts[
        await fire(context, {
          ruleId: rule.id,
          rule: rule.read,
          subjectKey: "",
          subjectName: fingerprint === null ? `Errors${where}` : errorText(type, message),
          type: "error.spike",
          message: `${project.name}: ${count} ${what} in the last ${minutes(windowMinutes)}, at or above the rule's threshold of ${threshold}.`,
          url,
          subject,
          at,
        })
      ] += 1;
    } else if (state?.firing === true) {
      if (state.clear_since === null) {
        await setClearSince(context.db, rule.id, "", at);
      } else if (at.getTime() - state.clear_since.getTime() >= windowMinutes * 60_000) {
        counts[
          await resolve(context, {
            ruleId: rule.id,
            rule: rule.read,
            subjectKey: "",
            type: "error.spike_resolved",
            message: `${project.name}: ${what} stayed below the threshold of ${threshold} for ${minutes(windowMinutes)}: ${count} in the last ${minutes(windowMinutes)}.`,
            url,
            subject,
            at,
          })
        ] += 1;
      }
    }
  }
}

/**
 * Evaluates the error rules that are on, of every project or one, at
 * `at`: one project after another, so the worker's queries are few at a
 * time. New and regressed errors, and spikes, are evaluated apart: a
 * failure of one (a query past its limits) is logged, and the other goes
 * on. A project's arrivals that failed are read again the next minute.
 */
export async function evaluateErrorRules(
  context: AlertContext,
  reader: Reader,
  at: Date,
  {
    projectId,
    pageSize = MAX_WINDOW_GROUPS,
    maxPages = MAX_PAGES,
  }: { projectId?: string } & Partial<PageLimits> = {},
): Promise<ErrorPass[]> {
  let query = context.db
    .selectFrom("alert_rules as r")
    .innerJoin("projects as p", "p.id", "r.project_id")
    .select([
      "r.id",
      "r.project_id",
      "p.name as project_name",
      "r.kind",
      "r.settings",
      "r.active_since",
    ])
    .where("r.enabled", "=", true)
    .where("r.kind", "in", ERROR_KINDS);
  if (projectId !== undefined) query = query.where("r.project_id", "=", projectId);
  const rows = await query
    .orderBy("r.project_id")
    .orderBy("r.created_at")
    .orderBy("r.id")
    .execute();
  const byProject = new Map<string, ErrorRule[]>();
  for (const row of rows) {
    if (!isRuleKind(row.kind)) continue;
    const list = byProject.get(row.project_id) ?? [];
    list.push({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      kind: row.kind,
      settings: row.settings,
      activeSince: row.active_since,
      read: { kind: row.kind, settings: row.settings },
    });
    byProject.set(row.project_id, list);
  }
  const passes: ErrorPass[] = [];
  for (const [id, rules] of byProject) {
    const project = { id, name: rules[0]?.projectName ?? "" };
    const counts: Counts = { sent: 0, held: 0, skipped: 0 };
    const windowRules = rules.filter((rule) => rule.kind !== "error_spike");
    let window: Omit<ErrorPass, "counts" | "projectId"> | null = null;
    if (windowRules.length > 0) {
      try {
        window = await evaluateWindow(context, reader, project, windowRules, at, counts, {
          pageSize,
          maxPages,
        });
        if (window.deferred) {
          context.log?.("info", "more error groups arrived than one alert evaluation reads", {
            project: id,
            pages: window.pages,
            groupsPerPage: pageSize,
          });
        }
      } catch (error) {
        context.log?.("error", "evaluating a project's new and regressed error rules failed", {
          project: id,
          err: String(error),
        });
      }
    }
    try {
      await evaluateSpikes(
        context,
        reader,
        project,
        rules.filter((rule) => rule.kind === "error_spike"),
        at,
        counts,
      );
    } catch (error) {
      context.log?.("error", "evaluating a project's error spike rules failed", {
        project: id,
        err: String(error),
      });
    }
    const until = new Date(at.getTime() - ARRIVAL_LAG_MS);
    passes.push({
      projectId: id,
      from: window?.from ?? until,
      until: window?.until ?? until,
      pages: window?.pages ?? 0,
      deferred: window?.deferred ?? false,
      counts,
    });
  }
  return passes;
}
