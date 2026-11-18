import { sql } from "kysely";

import {
  type AlertContext,
  dashboardLink,
  fire,
  type Guard,
  type Outcome,
  resolve,
} from "./fire.ts";
import { DEFAULT_CERTIFICATE_DAYS } from "./kinds.ts";

/**
 * Check rules (docs/uptime-alerts.md, "Alerts"): "check down" and
 * "certificate expiring", evaluated from what PostgreSQL holds about the
 * checks. The worker calls them for one check as soon as recordOutcome
 * reports a change or a run records a new certificate, and for every
 * check each minute (down) and each hour (certificates): a change the
 * worker stopped before acting on is caught up then, and since alerts fire
 * only when their state differs, nothing goes twice.
 */

/** Which checks to look at: all, a project's, or one. */
export interface CheckScope {
  projectId?: string | undefined;
  checkId?: string | undefined;
}

const DAY_MS = 86_400_000;

const minutesText = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
};

const checkLink = (context: AlertContext, projectId: string, checkId: string) =>
  dashboardLink(context.publicUrl, `/projects/${projectId}/uptime/${checkId}`);

/**
 * A guard (fire.ts) that reads the check again, FOR SHARE, after the
 * rule's lock: the alert goes ahead only while the check still exists and
 * still has what the evaluation read (its state, whether it is paused,
 * its certificate's expiry). A check deleted, recovered, or renewed
 * meanwhile is left to the next evaluation.
 */
function checkStill(
  checkId: string,
  read: { state?: string; paused: boolean; tlsExpiresAt?: Date | null },
): Guard {
  return async (trx) => {
    const row = await trx
      .selectFrom("uptime_checks")
      .select(["state", "paused", "tls_expires_at"])
      .where("id", "=", checkId)
      .forShare()
      .executeTakeFirst();
    if (row === undefined || row.paused !== read.paused) return false;
    if (read.state !== undefined && row.state !== read.state) return false;
    return (
      read.tlsExpiresAt === undefined ||
      (row.tls_expires_at?.getTime() ?? null) === (read.tlsExpiresAt?.getTime() ?? null)
    );
  };
}

/** Counts what a pass did, for the worker's log and the tests. */
export type Counts = Record<Outcome, number>;
const counted = (): Counts => ({ sent: 0, held: 0, skipped: 0 });

/**
 * Fires "check down" rules for watched checks that are down and not yet
 * alerted, and resolves them for checks that are no longer down (up
 * again, paused, or with a new URL). Only rules that are on.
 */
export async function evaluateCheckDown(
  context: AlertContext,
  scope: CheckScope,
  at: Date,
): Promise<Counts> {
  let query = context.db
    .selectFrom("alert_rules as r")
    .innerJoin("projects as p", "p.id", "r.project_id")
    .innerJoin("uptime_checks as c", (join) =>
      join
        .onRef("c.project_id", "=", "r.project_id")
        .on(sql<boolean>`(r.settings->>'checkId' is null or c.id::text = r.settings->>'checkId')`),
    )
    .leftJoin("alert_states as s", (join) =>
      join.onRef("s.rule_id", "=", "r.id").on(sql<boolean>`s.subject = c.id::text`),
    )
    .select([
      "r.id as rule_id",
      "p.id as project_id",
      "p.name as project_name",
      "c.id as check_id",
      "c.name",
      "c.url",
      "c.state",
      "c.paused",
      "c.failing_detail",
      sql<Date | null>`(
        select i.started_at from uptime_incidents i
        where i.check_id = c.id order by i.started_at desc limit 1
      )`.as("incident_started"),
      sql<Date | null>`(
        select i.ended_at from uptime_incidents i
        where i.check_id = c.id order by i.started_at desc limit 1
      )`.as("incident_ended"),
    ])
    .where("r.enabled", "=", true)
    .where("r.kind", "=", "check_down")
    // Only where the alert's state and the check's differ.
    .where(sql<boolean>`(c.state = 'down') <> coalesce(s.firing, false)`);
  if (scope.projectId !== undefined) query = query.where("r.project_id", "=", scope.projectId);
  if (scope.checkId !== undefined) query = query.where("c.id", "=", scope.checkId);
  const rows = await query.orderBy("r.id").orderBy("c.id").execute();
  const counts = counted();
  for (const row of rows) {
    const subject = { type: "check", id: row.check_id, name: row.name, url: row.url };
    const url = checkLink(context, row.project_id, row.check_id);
    const outcome =
      row.state === "down"
        ? await fire(context, {
            ruleId: row.rule_id,
            subjectKey: row.check_id,
            subjectName: row.name,
            type: "check.down",
            message: `${row.project_name}: the check "${row.name}" (${row.url}) is down.${row.failing_detail === null || row.failing_detail === "" ? "" : ` ${row.failing_detail}`}`,
            url,
            subject,
            at,
            still: checkStill(row.check_id, { state: row.state, paused: row.paused }),
          })
        : await resolve(context, {
            ruleId: row.rule_id,
            subjectKey: row.check_id,
            type: "check.up",
            message:
              row.state === "up"
                ? `${row.project_name}: the check "${row.name}" (${row.url}) is up again${row.incident_started === null ? "" : `, after ${minutesText((row.incident_ended ?? at).getTime() - row.incident_started.getTime())} down`}.`
                : `${row.project_name}: the check "${row.name}" (${row.url}) is no longer down: it was paused, or its URL changed.`,
            url,
            subject,
            at,
            still: checkStill(row.check_id, { state: row.state, paused: row.paused }),
          });
    counts[outcome] += 1;
  }
  return counts;
}

/** A day as "YYYY-MM-DD" in UTC. */
const dayOf = (moment: Date) => moment.toISOString().slice(0, 10);

/**
 * Fires "certificate expiring" rules for watched checks whose certificate
 * expires within the rule's days, once per certificate (its expiry), and
 * resolves them when the expiry moves past the window (renewed), or the
 * check no longer has one (paused, or a new URL).
 */
export async function evaluateCertificates(
  context: AlertContext,
  scope: CheckScope,
  at: Date,
): Promise<Counts> {
  let query = context.db
    .selectFrom("alert_rules as r")
    .innerJoin("projects as p", "p.id", "r.project_id")
    .innerJoin("uptime_checks as c", (join) =>
      join
        .onRef("c.project_id", "=", "r.project_id")
        .on(sql<boolean>`(r.settings->>'checkId' is null or c.id::text = r.settings->>'checkId')`),
    )
    .leftJoin("alert_states as s", (join) =>
      join.onRef("s.rule_id", "=", "r.id").on(sql<boolean>`s.subject = c.id::text`),
    )
    .select([
      "r.id as rule_id",
      sql<number | null>`(r.settings->>'days')::int`.as("days"),
      "p.id as project_id",
      "p.name as project_name",
      "c.id as check_id",
      "c.name",
      "c.url",
      "c.paused",
      "c.tls_expires_at",
      "s.firing",
      "s.key",
    ])
    .where("r.enabled", "=", true)
    .where("r.kind", "=", "certificate_expiring");
  if (scope.projectId !== undefined) query = query.where("r.project_id", "=", scope.projectId);
  if (scope.checkId !== undefined) query = query.where("c.id", "=", scope.checkId);
  const rows = await query.orderBy("r.id").orderBy("c.id").execute();
  const counts = counted();
  for (const row of rows) {
    const days = row.days ?? DEFAULT_CERTIFICATE_DAYS;
    const expires = row.paused ? null : row.tls_expires_at;
    const expiring = expires !== null && expires.getTime() - at.getTime() <= days * DAY_MS;
    const firing = row.firing === true;
    const host = URL.parse(row.url)?.hostname ?? row.url;
    const url = checkLink(context, row.project_id, row.check_id);
    const subject = {
      type: "certificate",
      checkId: row.check_id,
      checkName: row.name,
      url: row.url,
      host,
      expiresAt: expires?.toISOString() ?? null,
    };
    if (expiring && (!firing || row.key !== expires.toISOString())) {
      const left = Math.floor((expires.getTime() - at.getTime()) / DAY_MS);
      const when =
        expires <= at
          ? `expired on ${dayOf(expires)}`
          : `expires on ${dayOf(expires)}, in ${left <= 0 ? "less than a day" : left === 1 ? "1 day" : `${left} days`}`;
      counts[
        await fire(context, {
          ruleId: row.rule_id,
          subjectKey: row.check_id,
          subjectName: row.name,
          key: expires.toISOString(),
          type: "certificate.expiring",
          message: `${row.project_name}: the TLS certificate of ${host}, checked by "${row.name}", ${when}.`,
          url,
          subject: { ...subject, days },
          at,
          still: checkStill(row.check_id, { paused: row.paused, tlsExpiresAt: row.tls_expires_at }),
        })
      ] += 1;
    } else if (!expiring && firing) {
      counts[
        await resolve(context, {
          ruleId: row.rule_id,
          subjectKey: row.check_id,
          type: "certificate.renewed",
          message:
            expires === null
              ? `${row.project_name}: the check "${row.name}" no longer reports a certificate: it was paused, or its URL changed.`
              : `${row.project_name}: the TLS certificate of ${host}, checked by "${row.name}", was renewed: it now expires on ${dayOf(expires)}.`,
          url,
          subject,
          at,
          still: checkStill(row.check_id, { paused: row.paused, tlsExpiresAt: row.tls_expires_at }),
        })
      ] += 1;
    }
  }
  return counts;
}
