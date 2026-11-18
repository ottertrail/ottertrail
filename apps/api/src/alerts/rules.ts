import { type Kysely, sql, type Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import type { Problem } from "../outbound/url.ts";
import {
  checkIdOf,
  isRuleKind,
  KIND_INFO,
  MAX_RULE_NAME,
  MAX_RULES,
  type RuleKind,
  type RuleSettings,
  type SettingsInput,
  settingsOf,
  storedSettings,
} from "./kinds.ts";

/**
 * A project's alert rules in PostgreSQL (docs/uptime-alerts.md, "Alerts"):
 * what each watches and where it sends, its alerts firing now, and its
 * history. Deleting a check or a channel takes it out of the rules that
 * named it (forgetCheck, forgetChannel), in the transaction that deletes it.
 */

/** Days an alert stays in the history. */
export const HISTORY_RETENTION_DAYS = 90;
/** Alerts a page of the history holds at most. */
export const MAX_HISTORY_PAGE = 100;

/** A rule as the API answers it. */
export interface Rule {
  id: string;
  name: string;
  kind: RuleKind;
  settings: RuleSettings;
  channelIds: string[];
  enabled: boolean;
  /** Why the server turned it off, such as its last channel being deleted. */
  disabledReason: string | null;
  /** Subjects it is firing for now. */
  firing: number;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a user sets on a rule; every field optional on a change. */
export interface RuleInput {
  name?: string | undefined;
  kind?: string | undefined;
  settings?: SettingsInput | undefined;
  channelIds?: string[] | undefined;
  enabled?: boolean | undefined;
}

/** A rule's values, checked, as stored. */
export interface RuleValues {
  name: string;
  kind: RuleKind;
  settings: RuleSettings;
  channelIds: string[];
  enabled: boolean;
}

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;

/**
 * The values a rule would have with `input` over `base` (none for a new
 * rule), each checked; or the first problem. Whether its channels and
 * check exist is checked when it is saved (saveProblem).
 */
export function ruleValuesOf(input: RuleInput, base?: RuleValues): RuleValues | Problem {
  const kind = input.kind ?? base?.kind;
  if (!isRuleKind(kind)) {
    return { error: "invalid_kind", message: "Choose what the rule watches." };
  }
  const settings = settingsOf(kind, input.settings ?? {}, base?.kind === kind ? base.settings : {});
  if (isProblem(settings)) return settings;
  const name = (input.name ?? base?.name ?? "").trim() || KIND_INFO[kind].label;
  if (name.length > MAX_RULE_NAME || CONTROL.test(name)) {
    return {
      error: "invalid_name",
      message: `A rule's name has at most ${MAX_RULE_NAME} characters, and no control characters.`,
    };
  }
  const channelIds = [...new Set((input.channelIds ?? base?.channelIds ?? []).map(lower))];
  if (channelIds.length === 0) {
    return { error: "invalid_channels", message: "Choose at least one channel to send to." };
  }
  return { name, kind, settings, channelIds, enabled: input.enabled ?? base?.enabled ?? true };
}

const lower = (id: string) => id.toLowerCase();

const isProblem = (value: object): value is Problem => "error" in value && "message" in value;

export const valuesOfRule = (rule: Rule): RuleValues => ({
  name: rule.name,
  kind: rule.kind,
  settings: rule.settings,
  channelIds: rule.channelIds,
  enabled: rule.enabled,
});

/**
 * Why a rule cannot be saved in this project: a channel the instance does
 * not have, or a check of another project (or none). Locks what it found
 * until the transaction ends, so a deletion waits for the save.
 */
async function saveProblem(
  trx: Transaction<Database>,
  projectId: string,
  values: RuleValues,
): Promise<Problem | null> {
  const channels = await trx
    .selectFrom("notification_channels")
    .select("id")
    .where("id", "in", values.channelIds)
    .forShare()
    .execute();
  if (channels.length !== values.channelIds.length) {
    return {
      error: "channel_not_found",
      message: "This instance has no notification channel with one of these IDs.",
    };
  }
  const checkId = checkIdOf(values.settings);
  if (checkId !== null) {
    const check = await trx
      .selectFrom("uptime_checks")
      .select("id")
      .where("project_id", "=", projectId)
      .where("id", "=", checkId)
      .forShare()
      .executeTakeFirst();
    if (check === undefined) {
      return { error: "check_not_found", message: "The project has no check with this ID." };
    }
  }
  return null;
}

const ruleColumns = [
  "r.id",
  "r.name",
  "r.kind",
  "r.settings",
  "r.channel_ids",
  "r.enabled",
  "r.disabled_reason",
  "r.created_at",
  "r.updated_at",
] as const;

function ruleQuery(db: Kysely<Database> | Transaction<Database>, projectId: string) {
  return db
    .selectFrom("alert_rules as r")
    .select(ruleColumns)
    .select([
      sql<string>`(select count(*) from alert_states s where s.rule_id = r.id and s.firing)`.as(
        "firing",
      ),
      sql<Date | null>`(select max(h.fired_at) from alert_history h where h.rule_id = r.id)`.as(
        "last_fired_at",
      ),
    ])
    .where("r.project_id", "=", projectId);
}

type RuleRow = Awaited<ReturnType<ReturnType<typeof ruleQuery>["executeTakeFirstOrThrow"]>>;

function ruleOf(row: RuleRow): Rule {
  // Only the API writes kinds, from RULE_KINDS; a kind it no longer knows reads as off.
  const kind = isRuleKind(row.kind) ? row.kind : "check_down";
  return {
    id: row.id,
    name: row.name,
    kind,
    settings: storedSettings(kind, row.settings),
    channelIds: row.channel_ids,
    enabled: row.enabled && isRuleKind(row.kind),
    disabledReason: row.disabled_reason,
    firing: Number(row.firing),
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A project's rules, oldest first. */
export async function listRules(db: Kysely<Database>, projectId: string): Promise<Rule[]> {
  const rows = await ruleQuery(db, projectId).orderBy("r.created_at").orderBy("r.id").execute();
  return rows.map(ruleOf);
}

export async function findRule(
  db: Kysely<Database> | Transaction<Database>,
  projectId: string,
  ruleId: string,
): Promise<Rule | null> {
  const row = await ruleQuery(db, projectId).where("r.id", "=", ruleId).executeTakeFirst();
  return row === undefined ? null : ruleOf(row);
}

/** Adds a rule; refused when the project has MAX_RULES, or with the problem saveProblem finds. */
export async function createRule(
  db: Kysely<Database>,
  projectId: string,
  values: RuleValues,
  now: Date,
): Promise<{ rule: Rule } | { refused: "too_many" } | { problem: Problem }> {
  return db.transaction().execute(async (trx) => {
    // Adds to one project wait for each other here, so two at once
    // cannot both find room for the last rule.
    await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();
    const { count } = await trx
      .selectFrom("alert_rules")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_RULES) return { refused: "too_many" as const };
    const problem = await saveProblem(trx, projectId, values);
    if (problem !== null) return { problem };
    const row = await trx
      .insertInto("alert_rules")
      .values({
        project_id: projectId,
        name: values.name,
        kind: values.kind,
        settings: JSON.stringify(values.settings),
        channel_ids: values.channelIds,
        enabled: values.enabled,
        active_since: now,
        created_at: now,
        updated_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const rule = await findRule(trx, projectId, row.id);
    if (rule === null) throw new Error("The rule just added is missing");
    return { rule };
  });
}

/**
 * Forgets a rule's alerts: its states, and its open alerts end now, with
 * no notification. For a rule turned off, or one that watches something
 * else now; its history stays.
 */
async function forgetStates(trx: Transaction<Database>, ruleIds: string[], at: Date) {
  if (ruleIds.length === 0) return;
  await trx
    .updateTable("alert_history")
    .set({ resolved_at: at })
    .where(
      "id",
      "in",
      trx
        .selectFrom("alert_states")
        .select("history_id")
        .where("rule_id", "in", ruleIds)
        .where("firing", "=", true)
        .where("history_id", "is not", null)
        .$narrowType<{ history_id: string }>(),
    )
    .where("resolved_at", "is", null)
    .execute();
  await trx.deleteFrom("alert_states").where("rule_id", "in", ruleIds).execute();
}

/**
 * Changes a rule. Turning it off, or changing its kind or settings,
 * forgets its alerts (forgetStates): turned on again, it starts from what
 * is true then, and error rules read nothing that arrived before
 * (active_since). Turning it on clears the reason the server turned it
 * off. A rule the server turned off (its check or last channel deleted)
 * is turned on again by a save that fixes it, unless the save says
 * `enabled` itself (`enabledSent`): the save could only succeed with a
 * check that exists and a channel.
 */
export async function updateRule(
  db: Kysely<Database>,
  projectId: string,
  ruleId: string,
  values: RuleValues,
  now: Date,
  { enabledSent = true }: { enabledSent?: boolean } = {},
): Promise<{ rule: Rule } | { problem: Problem } | null> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("alert_rules")
      .select(["id", "kind", "settings", "enabled", "disabled_reason"])
      .where("project_id", "=", projectId)
      .where("id", "=", ruleId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) return null;
    const problem = await saveProblem(trx, projectId, values);
    if (problem !== null) return { problem };
    const settings = JSON.stringify(values.settings);
    // jsonb keeps its keys in an order of its own: compare them sorted.
    const watchesElse =
      current.kind !== values.kind || sortedJson(current.settings) !== sortedJson(values.settings);
    const fixed = !current.enabled && current.disabled_reason !== null && !enabledSent;
    const enabled = values.enabled || fixed;
    if (watchesElse || (current.enabled && !enabled)) {
      await forgetStates(trx, [ruleId], now);
    }
    await trx
      .updateTable("alert_rules")
      .set({
        name: values.name,
        kind: values.kind,
        settings,
        channel_ids: values.channelIds,
        enabled,
        ...(enabled ? { disabled_reason: null } : {}),
        ...(watchesElse || (enabled && !current.enabled) ? { active_since: now } : {}),
        updated_at: now,
      })
      .where("id", "=", ruleId)
      .execute();
    const rule = await findRule(trx, projectId, ruleId);
    return rule === null ? null : { rule };
  });
}

/** An object's JSON with its keys sorted, so two orders of the same keys compare equal. */
function sortedJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))),
  );
}

/** Deletes a rule with its states and history; false when the project has none with this ID. */
export async function deleteRule(
  db: Kysely<Database>,
  projectId: string,
  ruleId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom("alert_rules")
    .where("project_id", "=", projectId)
    .where("id", "=", ruleId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

export const CHECK_DELETED_REASON =
  "Turned off: the check it watched was deleted. Choose another check to turn it on again.";
export const CHANNELS_DELETED_REASON =
  "Turned off: its last channel was deleted. Choose a channel to turn it on again.";

/**
 * A check is being deleted, in `trx`, before the check itself: rules that
 * watch only it are turned off, with the reason; every rule's alerts
 * about it end, without a notification, and their states go.
 *
 * It locks first: the project's rules (in ID order), then the check. The
 * order is the one firing uses (rule, then check: fire.ts), so neither
 * waits for the other in a circle. An alert being fired for the check
 * finishes first and its state is forgotten here, or waits and then finds
 * no check; a rule being saved with this check finishes first and is
 * turned off here, or waits and then finds no check.
 */
export async function forgetCheck(
  trx: Transaction<Database>,
  projectId: string,
  checkId: string,
  at: Date,
): Promise<void> {
  // IDs are stored and compared as lower-case text.
  const id = checkId.toLowerCase();
  await trx
    .selectFrom("alert_rules")
    .select("id")
    .where("project_id", "=", projectId)
    .orderBy("id")
    .forUpdate()
    .execute();
  await trx
    .selectFrom("uptime_checks")
    .select("id")
    .where("project_id", "=", projectId)
    .where("id", "=", id)
    .forUpdate()
    .execute();
  const watching = await trx
    .updateTable("alert_rules")
    .set({ enabled: false, disabled_reason: CHECK_DELETED_REASON, updated_at: at })
    .where("project_id", "=", projectId)
    .where(sql<boolean>`settings->>'checkId' = ${id}`)
    .returning("id")
    .execute();
  const rules = await trx
    .selectFrom("alert_rules")
    .select("id")
    .where("project_id", "=", projectId)
    .execute();
  const ruleIds = rules.map((rule) => rule.id);
  await forgetStates(
    trx,
    watching.map((rule) => rule.id),
    at,
  );
  if (ruleIds.length === 0) return;
  await trx
    .updateTable("alert_history")
    .set({ resolved_at: at })
    .where("rule_id", "in", ruleIds)
    .where("subject", "=", id)
    .where("resolved_at", "is", null)
    .execute();
  await trx
    .deleteFrom("alert_states")
    .where("rule_id", "in", ruleIds)
    .where("subject", "=", id)
    .execute();
}

/**
 * A channel is being deleted, in `trx`, before the channel itself: every
 * rule drops it, and a rule left with no channel is turned off, with the
 * reason, its alerts ended. It locks first: the rules that name it (in
 * ID order, as firing locks a rule before its channels), then the
 * channel, so a rule being saved with it finishes first and is changed
 * here, or waits and then finds no channel.
 */
export async function forgetChannel(
  trx: Transaction<Database>,
  channelId: string,
  at: Date,
): Promise<void> {
  await trx
    .selectFrom("alert_rules")
    .select("id")
    .where(sql<boolean>`channel_ids @> array[${channelId}::uuid]`)
    .orderBy("id")
    .forUpdate()
    .execute();
  await trx
    .selectFrom("notification_channels")
    .select("id")
    .where("id", "=", channelId)
    .forUpdate()
    .execute();
  const updated = await trx
    .updateTable("alert_rules")
    .set({
      channel_ids: sql<string[]>`array_remove(channel_ids, ${channelId}::uuid)`,
      enabled: sql<boolean>`enabled and cardinality(array_remove(channel_ids, ${channelId}::uuid)) > 0`,
      disabled_reason: sql<string | null>`case
        when cardinality(array_remove(channel_ids, ${channelId}::uuid)) = 0
        then ${CHANNELS_DELETED_REASON}::text else disabled_reason end`,
      updated_at: at,
    })
    .where(sql<boolean>`channel_ids @> array[${channelId}::uuid]`)
    .returning(["id", "enabled"])
    .execute();
  await forgetStates(
    trx,
    updated.filter((rule) => !rule.enabled).map((rule) => rule.id),
    at,
  );
}

/** One alert, as the history lists it. */
export interface HistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  kind: string;
  subject: string;
  subjectName: string;
  firedAt: Date;
  resolvedAt: Date | null;
  message: string;
  /** Whether a notification went out when it fired: false when the rule's hourly cap held it back. */
  notified: boolean;
}

/**
 * Alerts of a project, or of one of its rules, from the last
 * HISTORY_RETENTION_DAYS, newest first, `limit` at a time: `before` is the
 * last ID of the page before, `next` the ID that asks for the next page.
 */
export async function listHistory(
  db: Kysely<Database>,
  projectId: string,
  { ruleId, before, limit }: { ruleId?: string; before?: string | undefined; limit: number },
): Promise<{ alerts: HistoryEntry[]; next: string | null }> {
  let query = db
    .selectFrom("alert_history as h")
    .innerJoin("alert_rules as r", "r.id", "h.rule_id")
    .select([
      "h.id",
      "h.rule_id",
      "r.name as rule_name",
      "r.kind",
      "h.subject",
      "h.subject_name",
      "h.fired_at",
      "h.resolved_at",
      "h.message",
      "h.notification_id",
    ])
    .where("h.project_id", "=", projectId)
    .where("h.fired_at", ">=", sql<Date>`now() - make_interval(days => ${HISTORY_RETENTION_DAYS})`);
  if (ruleId !== undefined) query = query.where("h.rule_id", "=", ruleId);
  if (before !== undefined) {
    query = query.where(
      sql<boolean>`(h.fired_at, h.id) < (
        select fired_at, id from alert_history where id = ${before} and project_id = ${projectId}
      )`,
    );
  }
  const rows = await query
    .orderBy("h.fired_at", "desc")
    .orderBy("h.id", "desc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  return {
    alerts: page.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      kind: row.kind,
      subject: row.subject,
      subjectName: row.subject_name,
      firedAt: row.fired_at,
      resolvedAt: row.resolved_at,
      message: row.message,
      notified: row.notification_id !== null,
    })),
    next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** An alert firing now. */
export interface FiringAlert {
  ruleId: string;
  ruleName: string;
  kind: string;
  subject: string;
  subjectName: string;
  since: Date;
  message: string;
}

/** The project's alerts firing now, of rules that are on, longest first. */
export async function firingAlerts(
  db: Kysely<Database>,
  projectId: string,
): Promise<FiringAlert[]> {
  const rows = await db
    .selectFrom("alert_states as s")
    .innerJoin("alert_rules as r", "r.id", "s.rule_id")
    .leftJoin("alert_history as h", "h.id", "s.history_id")
    .select([
      "s.rule_id",
      "r.name as rule_name",
      "r.kind",
      "s.subject",
      "h.subject_name",
      "s.since",
      "h.message",
    ])
    .where("r.project_id", "=", projectId)
    .where("r.enabled", "=", true)
    .where("s.firing", "=", true)
    .orderBy("s.since")
    .orderBy("s.rule_id")
    .limit(MAX_RULES * 50)
    .execute();
  return rows.map((row) => ({
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    kind: row.kind,
    subject: row.subject,
    subjectName: row.subject_name ?? row.subject,
    since: row.since,
    message: row.message ?? "",
  }));
}

/**
 * Deletes alerts older than HISTORY_RETENTION_DAYS, except those still
 * firing, and the old states of check rules and new-error rules, which
 * only guard against firing twice within an evaluation's reach. A
 * regressed-error rule's state guards its group for as long as the
 * resolution it fired for stands, so it is kept until the resolution
 * changes or goes (forgetRegressions; and here, when it no longer
 * matches). Returns how many alerts were deleted.
 */
export async function pruneHistory(db: Kysely<Database>, now: Date): Promise<number> {
  const cutoff = sql<Date>`${now}::timestamptz - make_interval(days => ${HISTORY_RETENTION_DAYS})`;
  await db
    .deleteFrom("alert_states")
    .where("firing", "=", false)
    .where("since", "<", cutoff)
    .where(
      "rule_id",
      "not in",
      db.selectFrom("alert_rules").select("id").where("kind", "=", "error_regressed"),
    )
    .execute();
  // A regressed rule's state whose resolution has changed or gone guards nothing.
  await sql`
    delete from alert_states s
    using alert_rules r
    where r.id = s.rule_id
      and r.kind = 'error_regressed'
      and not exists (
        select 1 from error_resolutions e
        where e.project_id = r.project_id
          and e.fingerprint = s.subject
          and to_char(e.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = s.key
      )
  `.execute(db);
  const result = await db
    .deleteFrom("alert_history")
    .where("fired_at", "<", cutoff)
    .where(
      sql<boolean>`not exists (
        select 1 from alert_states s where s.history_id = alert_history.id
      )`,
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * A group's resolution changed or was removed: the regressed-error
 * rules' states for it, which guard only the resolution they fired for,
 * go, so the next regression after the new resolution fires.
 */
export async function forgetRegressions(
  db: Kysely<Database>,
  projectId: string,
  fingerprint: string,
): Promise<void> {
  await db
    .deleteFrom("alert_states")
    .where("subject", "=", fingerprint)
    .where(
      "rule_id",
      "in",
      db
        .selectFrom("alert_rules")
        .select("id")
        .where("project_id", "=", projectId)
        .where("kind", "=", "error_regressed"),
    )
    .execute();
}

/**
 * Ends, without a notification, the firing alerts of check rules whose
 * check no longer exists: a deletion normally ends them (forgetCheck),
 * and this catches any left behind, since the evaluation only looks at
 * checks that exist. Returns how many it ended.
 */
export async function endOrphanedCheckAlerts(db: Kysely<Database>, at: Date): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const orphans = await sql<{ rule_id: string; subject: string; history_id: string | null }>`
      select s.rule_id, s.subject, s.history_id
      from alert_states s
      join alert_rules r on r.id = s.rule_id
      where r.kind in ('check_down', 'certificate_expiring')
        and s.firing
        and not exists (select 1 from uptime_checks c where c.id::text = s.subject)
      for update of s
    `.execute(trx);
    for (const orphan of orphans.rows) {
      if (orphan.history_id !== null) {
        await trx
          .updateTable("alert_history")
          .set({ resolved_at: at })
          .where("id", "=", orphan.history_id)
          .where("resolved_at", "is", null)
          .execute();
      }
      await trx
        .deleteFrom("alert_states")
        .where("rule_id", "=", orphan.rule_id)
        .where("subject", "=", orphan.subject)
        .execute();
    }
    return orphans.rows.length;
  });
}
