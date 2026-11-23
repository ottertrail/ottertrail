import type { Kysely } from "kysely";

import { checkProjectAccess } from "../access/access.ts";
import { avatarUrlOf } from "../avatars/avatars.ts";
import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import { MAX_FUTURE_MS } from "../collection/server-events.ts";
import type { Database } from "../db/schema.ts";
import { enqueueAccountEmail } from "../notifications/account-emails.ts";
import { errorTitle, recordPersonal } from "../notifications/inbox.ts";
import type { LinkSealer } from "../notifications/link-sealer.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { ERROR } from "../visits/visits.ts";

/**
 * Assignments require access to project errors; removal or lost access
 * clears them (access/grants.ts). Resolution keeps the assignee.
 * Notify other assignees through the inbox and SMTP, when configured;
 * notify regressions through the inbox (docs/errors.md, "Assignment").
 */

export interface Assignee {
  id: string;
  name: string;
  avatarUrl: string | null;
}

const MESSAGE_CHARS = 120;
const ARRIVAL_PAGE = 1000;
const CHUNK = 200;

const cutMessage = (message: string) =>
  message.length <= MESSAGE_CHARS ? message : `${message.slice(0, MESSAGE_CHARS - 1)}…`;

export async function assigneesOf(
  db: Kysely<Database>,
  projectId: string,
  fingerprints: readonly string[],
): Promise<Map<string, Assignee>> {
  const found = new Map<string, Assignee>();
  for (let start = 0; start < fingerprints.length; start += CHUNK) {
    const rows = await db
      .selectFrom("error_assignments as a")
      .innerJoin("dashboard_users as u", "u.id", "a.assignee_id")
      .select(["a.fingerprint", "u.id", "u.name", "u.avatar_key"])
      .where("a.project_id", "=", projectId)
      .where("a.fingerprint", "in", fingerprints.slice(start, start + CHUNK))
      .execute();
    for (const row of rows) {
      found.set(row.fingerprint, {
        id: row.id,
        name: row.name,
        avatarUrl: avatarUrlOf(row.avatar_key),
      });
    }
  }
  return found;
}

/** Return null if the project has no occurrence since `since`. */
async function latestError(
  reader: Reader,
  projectId: string,
  fingerprint: string,
  since: Date,
): Promise<string | null> {
  const params = new QueryParams();
  const [row] = await queryRows<{ type: string; message: string; seen: string }>(
    reader,
    `SELECT argMax(error_type, occurred_at) AS type,
            argMax(error_message, occurred_at) AS message,
            count() AS seen
     FROM events
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND occurred_at >= ${params.time(since)}
       AND name = '${ERROR}'
       AND error_fingerprint = ${params.add(fingerprint, "String")}`,
    params,
    DASHBOARD_SETTINGS,
  );
  if (row === undefined || Number(row.seen) === 0) return null;
  return errorTitle(row.type, cutMessage(row.message));
}

export type AssignResult =
  | { ok: true; assignee: Assignee | null }
  /** The user does not exist, or cannot see the project's errors. */
  | { ok: false; reason: "not_assignable" }
  /** The project has no occurrence of the group since `seenSince`. */
  | { ok: false; reason: "no_occurrences" };

/**
 * Notify a changed assignee unless they assigned themselves. Repeated
 * assignments send nothing, including concurrent requests.
 */
export async function assignError(
  db: Kysely<Database>,
  reader: Reader,
  {
    projectId,
    fingerprint,
    assigneeId,
    actor,
    seenSince,
    email,
  }: {
    projectId: string;
    fingerprint: string;
    assigneeId: string | null;
    actor: { id: string; name: string };
    /** The group must have happened since then: the longest range a page shows. */
    seenSince: Date;
    /** With SMTP: the queue's sealer and the instance's address, for the email's link. */
    email: { sealer: LinkSealer; publicUrl: string } | null;
  },
): Promise<AssignResult> {
  if (assigneeId === null) {
    await db
      .deleteFrom("error_assignments")
      .where("project_id", "=", projectId)
      .where("fingerprint", "=", fingerprint)
      .execute();
    return { ok: true, assignee: null };
  }
  // Reject inaccessible assignees before querying ClickHouse; recheck
  // under the lock below.
  if (
    !(await checkProjectAccess(db, assigneeId, projectId, { area: "errors", level: "view" })).ok
  ) {
    return { ok: false, reason: "not_assignable" };
  }
  // Query ClickHouse before opening the transaction to avoid holding locks.
  const title = await latestError(reader, projectId, fingerprint, seenSince);
  if (title === null) return { ok: false, reason: "no_occurrences" };
  return db.transaction().execute(async (trx): Promise<AssignResult> => {
    // Block concurrent user removal or access changes.
    const user = await trx
      .selectFrom("dashboard_users")
      .select(["id", "name", "email", "avatar_key"])
      .where("id", "=", assigneeId)
      .forShare()
      .executeTakeFirst();
    if (user === undefined) return { ok: false, reason: "not_assignable" };
    // Recheck access under the lock; access/grants.ts clears revoked assignments.
    const checked = await checkProjectAccess(trx, user.id, projectId, {
      area: "errors",
      level: "view",
    });
    if (!checked.ok) return { ok: false, reason: "not_assignable" };
    const assignee = { id: user.id, name: user.name, avatarUrl: avatarUrlOf(user.avatar_key) };
    // Only a changed assignee gets a row and notification, including races.
    const changed = await trx
      .insertInto("error_assignments")
      .values({
        project_id: projectId,
        fingerprint,
        assignee_id: user.id,
        assigned_by: actor.id,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["project_id", "fingerprint"])
          .doUpdateSet({
            assignee_id: user.id,
            assigned_by: actor.id,
            assigned_at: new Date(),
            regression_told_for: null,
          })
          .where("error_assignments.assignee_id", "is distinct from", user.id),
      )
      .returning("fingerprint")
      .executeTakeFirst();
    if (changed === undefined || user.id === actor.id) return { ok: true, assignee };
    const link = `/projects/${projectId}/errors/${fingerprint}`;
    await recordPersonal(trx, {
      kind: "error.assigned",
      projectId,
      userId: user.id,
      areas: ["errors"],
      title: `${actor.name} assigned you ${title}`,
      link,
    });
    if (email !== null) {
      const project = await trx
        .selectFrom("projects")
        .select("name")
        .where("id", "=", projectId)
        .executeTakeFirstOrThrow();
      await enqueueAccountEmail(
        trx,
        {
          kind: "error_assigned",
          to: user.email,
          params: {
            by: actor.name,
            error: title,
            project: project.name,
            link: `${email.publicUrl}${link}`,
          },
        },
        email.sealer,
      );
    }
    return { ok: true, assignee };
  });
}

interface Arrived {
  fingerprint: string;
  last: string;
  type: string;
  message: string;
}

/**
 * Page arrivals in (from, until] by fingerprint, with one extra row when
 * more remain. Bound event days as in alerts/error-rules.ts.
 */
async function arrivedErrors(
  reader: Reader,
  projectId: string,
  { from, until }: { from: Date; until: Date },
  after: string | null,
  pageSize: number,
): Promise<Arrived[]> {
  const params = new QueryParams();
  return queryRows<Arrived>(
    reader,
    `SELECT error_fingerprint AS fingerprint,
            max(occurred_at) AS last,
            argMax(error_type, occurred_at) AS type,
            argMax(error_message, occurred_at) AS message
     FROM events
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND occurred_at >= ${params.time(new Date(from.getTime() - MAX_EVENT_AGE_MS))}
       AND occurred_at <= ${params.time(new Date(until.getTime() + MAX_FUTURE_MS))}
       AND received_at > ${params.time(from)}
       AND received_at <= ${params.time(until)}
       AND name = '${ERROR}'
       AND error_fingerprint != ''
       ${after === null ? "" : `AND error_fingerprint > ${params.add(after, "String")}`}
     GROUP BY error_fingerprint
     ORDER BY error_fingerprint
     LIMIT ${pageSize + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
}

async function tellPage(
  db: Kysely<Database>,
  projectId: string,
  page: readonly Arrived[],
): Promise<number> {
  const candidates = await db
    .selectFrom("error_assignments as a")
    .innerJoin("error_resolutions as r", (join) =>
      join.onRef("r.project_id", "=", "a.project_id").onRef("r.fingerprint", "=", "a.fingerprint"),
    )
    .select(["a.fingerprint", "a.assignee_id", "a.assigned_at", "r.resolved_at"])
    .where("a.project_id", "=", projectId)
    .where(
      "a.fingerprint",
      "in",
      page.map((row) => row.fingerprint),
    )
    .where((eb) =>
      eb.or([
        eb("a.regression_told_for", "is", null),
        eb("a.regression_told_for", "<>", eb.ref("r.resolved_at")),
      ]),
    )
    .execute();
  const byFingerprint = new Map(page.map((row) => [row.fingerprint, row]));
  let told = 0;
  for (const group of candidates) {
    const seen = byFingerprint.get(group.fingerprint);
    if (seen === undefined) continue;
    const last = fromClickHouseTime(seen.last);
    // Only an occurrence after both the resolution and the assignment.
    if (last <= group.resolved_at || last <= group.assigned_at) continue;
    const done = await db.transaction().execute(async (trx) => {
      // Notify once per resolution. Copy its timestamp within PostgreSQL;
      // a JavaScript Date loses microseconds and would never match.
      const marked = await trx
        .updateTable("error_assignments as a")
        .from("error_resolutions as r")
        .set((eb) => ({ regression_told_for: eb.ref("r.resolved_at") }))
        .whereRef("r.project_id", "=", "a.project_id")
        .whereRef("r.fingerprint", "=", "a.fingerprint")
        .where("a.project_id", "=", projectId)
        .where("a.fingerprint", "=", group.fingerprint)
        .where("a.assignee_id", "=", group.assignee_id)
        .where("a.assigned_at", "<", last)
        .where("r.resolved_at", "<", last)
        .where((eb) =>
          eb.or([
            eb("a.regression_told_for", "is", null),
            eb("a.regression_told_for", "<>", eb.ref("r.resolved_at")),
          ]),
        )
        .returning("a.fingerprint")
        .executeTakeFirst();
      if (marked === undefined) return false;
      await recordPersonal(trx, {
        kind: "error.regressed",
        projectId,
        userId: group.assignee_id,
        areas: ["errors"],
        title: `Regressed: ${errorTitle(seen.type, cutMessage(seen.message))}`,
        link: `/projects/${projectId}/errors/${group.fingerprint}`,
      });
      return true;
    });
    if (done) told += 1;
  }
  return told;
}

/**
 * Notify once per resolution for occurrences after both resolution and
 * assignment, excluding regressions before assignment. The worker runs this
 * after alerts/evaluator.ts each minute, paging arrivals in window for
 * projects with resolved assignments that have not been notified.
 */
export async function tellAssigneesOfRegressions(
  db: Kysely<Database>,
  reader: Reader,
  window: { from: Date; until: Date },
  pageSize = ARRIVAL_PAGE,
): Promise<number> {
  const projects = await db
    .selectFrom("error_assignments as a")
    .innerJoin("error_resolutions as r", (join) =>
      join.onRef("r.project_id", "=", "a.project_id").onRef("r.fingerprint", "=", "a.fingerprint"),
    )
    .select("a.project_id")
    .distinct()
    .where((eb) =>
      eb.or([
        eb("a.regression_told_for", "is", null),
        eb("a.regression_told_for", "<>", eb.ref("r.resolved_at")),
      ]),
    )
    .execute();
  let told = 0;
  for (const { project_id: projectId } of projects) {
    let after: string | null = null;
    for (;;) {
      const rows = await arrivedErrors(reader, projectId, window, after, pageSize);
      const page = rows.slice(0, pageSize);
      if (page.length > 0) told += await tellPage(db, projectId, page);
      if (rows.length <= pageSize) break;
      after = page.at(-1)?.fingerprint ?? null;
    }
  }
  return told;
}
