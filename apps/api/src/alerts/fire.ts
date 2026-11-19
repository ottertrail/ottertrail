import { type Kysely, sql, type Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import { notifyIn } from "../notifications/deliveries.ts";
import { type EventType, MAX_MESSAGE, type Subject } from "../notifications/events.ts";

/**
 * Firing and resolving alerts (docs/uptime-alerts.md, "Alerts"): each
 * change of an alert's state, its history, and its notification are
 * written in one transaction, with the rule's row locked, so two workers
 * or a restart never send one twice, and a crash before the commit leaves
 * the alert to the next evaluation. A rule sends at most RULE_HOURLY_CAP
 * notifications an hour; past it they are held back, counted, and kept
 * in the history, and one message says how many when the hour is over
 * (flushHeldBack).
 */

/** Notifications a rule sends in an hour; past it, they are held back. */
export const RULE_HOURLY_CAP = 20;
const HOUR_MS = 60 * 60 * 1000;

/** Where the dashboard is, for the links in notifications, and the clock. */
export interface AlertContext {
  db: Kysely<Database>;
  /** The instance's address (PUBLIC_URL). */
  publicUrl: string;
  log?:
    | ((level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void)
    | undefined;
}

/** Text cut to `max` characters, on one line, with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it replaces
  const line = text.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** A dashboard link: the path under the instance's address, with a query. */
export function dashboardLink(
  publicUrl: string,
  path: string,
  query: Record<string, string> = {},
): string {
  const url = new URL(path, publicUrl);
  // The dashboard reads its query values as JSON when they are JSON (router.tsx).
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, JSON.stringify(value));
  return url.href;
}

interface LockedRule {
  id: string;
  project_id: string;
  project_name: string;
  name: string;
  kind: string;
  channel_ids: string[];
  enabled: boolean;
  cap_window_start: Date | null;
  cap_sent: number;
  cap_held: number;
}

async function lockRule(trx: Transaction<Database>, ruleId: string): Promise<LockedRule | null> {
  const row = await trx
    .selectFrom("alert_rules")
    .select([
      "id",
      "project_id",
      "name",
      "kind",
      "channel_ids",
      "enabled",
      "cap_window_start",
      "cap_sent",
      "cap_held",
    ])
    .where("id", "=", ruleId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return null;
  const project = await trx
    .selectFrom("projects")
    .select("name")
    .where("id", "=", row.project_id)
    .executeTakeFirst();
  return { ...row, project_name: project?.name ?? "" };
}

/** What a notification says, before the rule's name and project are added. */
interface Message {
  type: EventType;
  message: string;
  url: string;
  subject: Subject;
  at: Date;
}

/** The message summing up what a rule held back in its hour. */
async function sendSummary(trx: Transaction<Database>, rule: LockedRule, at: Date, url: string) {
  const held = rule.cap_held;
  await notifyIn(trx, {
    channelIds: rule.channel_ids,
    type: "alert.held_back",
    project: { id: rule.project_id, name: rule.project_name },
    subject: { type: "rule", id: rule.id, name: rule.name, held, cap: RULE_HOURLY_CAP },
    message: cut(
      `${rule.project_name}: the alert rule "${rule.name}" held back ${held} more ${held === 1 ? "notification" : "notifications"} after sending ${RULE_HOURLY_CAP} in an hour, which is its limit. The rule's alert history in the dashboard lists every alert.`,
      MAX_MESSAGE,
    ),
    url,
    time: at,
  });
}

/**
 * Sends a notification within the rule's hourly cap, or holds it back and
 * counts it; returns the notification's ID, or null when held back. When
 * an hour has passed since the first notification counted, the count
 * starts again, after the summary of what was held back, if anything was.
 */
async function sendCapped(
  trx: Transaction<Database>,
  context: AlertContext,
  rule: LockedRule,
  message: Message,
): Promise<string | null> {
  let { cap_window_start: start, cap_sent: sent, cap_held: held } = rule;
  if (start === null || message.at.getTime() - start.getTime() >= HOUR_MS) {
    if (held > 0) await sendSummary(trx, rule, message.at, alertsLink(context, rule.project_id));
    start = message.at;
    sent = 0;
    held = 0;
  }
  let notificationId: string | null = null;
  if (sent < RULE_HOURLY_CAP) {
    const recorded = await notifyIn(trx, {
      channelIds: rule.channel_ids,
      type: message.type,
      project: { id: rule.project_id, name: rule.project_name },
      subject: { ...message.subject, ruleId: rule.id, ruleName: rule.name },
      message: cut(message.message, MAX_MESSAGE),
      url: message.url,
      time: message.at,
    });
    notificationId = recorded.notificationId;
    sent += 1;
  } else {
    held += 1;
  }
  await trx
    .updateTable("alert_rules")
    .set({ cap_window_start: start, cap_sent: sent, cap_held: held })
    .where("id", "=", rule.id)
    .execute();
  return notificationId;
}

export const alertsLink = (context: AlertContext, projectId: string) =>
  dashboardLink(context.publicUrl, `/projects/${projectId}/alerts`);

/** How a transition went: sent, held back by the cap, or not needed (already in that state). */
export type Outcome = "sent" | "held" | "skipped";

export interface FireInput extends Message {
  ruleId: string;
  /** The state's subject: a check's ID, a fingerprint, or "" for a spike rule. */
  subjectKey: string;
  /** What the history shows for the subject, such as a check's name. */
  subjectName: string;
  /**
   * What it fires for: it fires again only for another key (a
   * certificate's new expiry, a new resolution), never twice for one.
   */
  key?: string;
  /**
   * Fires once and does not stay firing, for kinds that never resolve
   * (new and regressed errors): the state only remembers the key.
   */
  once?: boolean;
  /** Whether what it fires for is still true, read again in the transaction (Guard). */
  still?: Guard | undefined;
}

/**
 * Reads again, in the alert's transaction and after the rule's lock, what
 * the evaluation read before it, such as the check (with FOR SHARE): the
 * alert goes ahead only when it is still true. Locks follow one order,
 * the rule, then what it watches, as deleting a check takes them
 * (rules.ts, forgetCheck).
 */
export type Guard = (trx: Transaction<Database>) => Promise<boolean>;

/**
 * Fires an alert for one rule and subject, unless it already fired for
 * the same key (firing now, or, for `once`, ever). A firing alert for
 * another key is ended without a notification first. Nothing happens for
 * a rule deleted or turned off meanwhile.
 */
export async function fire(context: AlertContext, input: FireInput): Promise<Outcome> {
  const key = input.key ?? "";
  return context.db.transaction().execute(async (trx) => {
    const rule = await lockRule(trx, input.ruleId);
    if (rule === null || !rule.enabled) return "skipped";
    if (input.still !== undefined && !(await input.still(trx))) return "skipped";
    const state = await trx
      .selectFrom("alert_states")
      .selectAll()
      .where("rule_id", "=", rule.id)
      .where("subject", "=", input.subjectKey)
      .executeTakeFirst();
    if (state !== undefined && state.key === key && (input.once === true || state.firing)) {
      return "skipped";
    }
    if (state?.firing === true && state.history_id !== null) {
      await trx
        .updateTable("alert_history")
        .set({ resolved_at: input.at })
        .where("id", "=", state.history_id)
        .where("resolved_at", "is", null)
        .execute();
    }
    const notificationId = await sendCapped(trx, context, rule, input);
    const history = await trx
      .insertInto("alert_history")
      .values({
        rule_id: rule.id,
        project_id: rule.project_id,
        subject: input.subjectKey,
        subject_name: cut(input.subjectName, 300),
        fired_at: input.at,
        message: cut(input.message, MAX_MESSAGE),
        notification_id: notificationId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const values = {
      firing: input.once !== true,
      key,
      since: input.at,
      clear_since: null,
      last_notified_at: notificationId === null ? (state?.last_notified_at ?? null) : input.at,
      history_id: history.id,
    };
    await trx
      .insertInto("alert_states")
      .values({ rule_id: rule.id, subject: input.subjectKey, ...values })
      .onConflict((conflict) => conflict.columns(["rule_id", "subject"]).doUpdateSet(values))
      .execute();
    return notificationId === null ? "held" : "sent";
  });
}

export interface ResolveInput extends Message {
  ruleId: string;
  subjectKey: string;
  /** Whether it is still resolved, read again in the transaction. */
  still?: Guard | undefined;
}

/**
 * Resolves a firing alert: its state stops firing, its history records
 * when, and a notification says so. Skipped when it is not firing.
 */
export async function resolve(context: AlertContext, input: ResolveInput): Promise<Outcome> {
  return context.db.transaction().execute(async (trx) => {
    const rule = await lockRule(trx, input.ruleId);
    if (rule === null || !rule.enabled) return "skipped";
    if (input.still !== undefined && !(await input.still(trx))) return "skipped";
    const state = await trx
      .selectFrom("alert_states")
      .selectAll()
      .where("rule_id", "=", rule.id)
      .where("subject", "=", input.subjectKey)
      .executeTakeFirst();
    if (state === undefined || !state.firing) return "skipped";
    const notificationId = await sendCapped(trx, context, rule, input);
    if (state.history_id !== null) {
      await trx
        .updateTable("alert_history")
        .set({ resolved_at: input.at, resolve_notification_id: notificationId })
        .where("id", "=", state.history_id)
        .execute();
    }
    await trx
      .updateTable("alert_states")
      .set({
        firing: false,
        since: input.at,
        clear_since: null,
        history_id: null,
        ...(notificationId === null ? {} : { last_notified_at: input.at }),
      })
      .where("rule_id", "=", rule.id)
      .where("subject", "=", input.subjectKey)
      .execute();
    return notificationId === null ? "held" : "sent";
  });
}

/**
 * Sends the summary of each rule whose hour of notifications is over with
 * some held back, and starts its count again. Run every minute, so the
 * summary goes out within a minute of the hour's end even when the rule
 * has nothing more to send. Returns how many summaries were sent.
 */
export async function flushHeldBack(context: AlertContext, at: Date): Promise<number> {
  const due = await context.db
    .selectFrom("alert_rules")
    .select("id")
    .where("cap_held", ">", 0)
    .where("cap_window_start", "<=", new Date(at.getTime() - HOUR_MS))
    .execute();
  let sent = 0;
  for (const { id } of due) {
    const done = await context.db.transaction().execute(async (trx) => {
      const rule = await lockRule(trx, id);
      if (
        rule === null ||
        rule.cap_held === 0 ||
        rule.cap_window_start === null ||
        at.getTime() - rule.cap_window_start.getTime() < HOUR_MS
      ) {
        return false;
      }
      await sendSummary(trx, rule, at, alertsLink(context, rule.project_id));
      await trx
        .updateTable("alert_rules")
        .set({ cap_window_start: null, cap_sent: 0, cap_held: 0 })
        .where("id", "=", rule.id)
        .execute();
      return true;
    });
    if (done) sent += 1;
  }
  return sent;
}

/**
 * Sets when a firing spike's count went below its threshold, or clears it
 * (null) when the count is back up; it resolves once that has lasted a
 * whole window.
 */
export async function setClearSince(
  db: Kysely<Database>,
  ruleId: string,
  subjectKey: string,
  clearSince: Date | null,
): Promise<void> {
  await db
    .updateTable("alert_states")
    .set({ clear_since: clearSince })
    .where("rule_id", "=", ruleId)
    .where("subject", "=", subjectKey)
    .where("firing", "=", true)
    .where(
      clearSince === null
        ? sql<boolean>`clear_since is not null`
        : sql<boolean>`clear_since is null`,
    )
    .execute();
}
