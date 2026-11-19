import { type Kysely, sql } from "kysely";

import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import { ERROR } from "../visits/visits.ts";

/**
 * Links each joined replay to the error events that carry its ID
 * (ClickHouse `events.replay_id`), and keeps in PostgreSQL what the Replays
 * page lists and filters by: the first error's time, group, type, and
 * message, the known user, the environment, and the browser, OS, and
 * device (docs/session-replay.md, "Finding replays"). The list then reads
 * PostgreSQL alone, a page at a time.
 *
 * The page sends its error before its replay, so the error is usually
 * there at the first try. A replay whose error is not found is tried again
 * later each time (nextLinkAt), and given up LINK_WAIT_MS after it was
 * joined. Each run takes at most LINK_PER_PROJECT replays of one project,
 * the most due first, so a project whose errors never come cannot keep
 * another's replays waiting.
 */

/** How long after its join a replay's error is still looked for. */
export const LINK_WAIT_MS = 60 * 60_000;
/** The most replays of one project a run looks at. */
export const LINK_PER_PROJECT = 20;
/** Waits between tries: half the replay's age, from 10 seconds to 10 minutes. */
const MIN_RETRY_MS = 10_000;
const MAX_RETRY_MS = 10 * 60_000;

/** When a replay joined at `createdAt`, its error not found `now`, is looked for again. */
export function nextLinkAt(createdAt: Date, now: Date): Date {
  const age = Math.max(0, now.getTime() - createdAt.getTime());
  const wait = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, age / 2));
  return new Date(now.getTime() + wait);
}
/** How far around a replay its error is looked for, on the server's clock. */
const LINK_MARGIN_MS = 60 * 60_000;
/** Lengths kept, as the replays table's checks allow. */
const MAX_TYPE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 1000;

interface LinkRow {
  replay: string;
  error_at: string;
  fingerprint: string;
  type: string;
  message: string;
  environment: string;
  user_id: string;
  browser: string;
  os: string;
  device_type: string;
}

/** The first `max` characters (code points, as PostgreSQL counts them). */
const truncate = (text: string, max: number) => Array.from(text).slice(0, max).join("");

const orNull = (text: string) => (text === "" ? null : text);

/** The first value among the replay's errors that is not null; "" when none is. */
const firstOf = (column: string) =>
  `argMinIf(ifNull(${column}, ''), (occurred_at, event_id), ${column} IS NOT NULL)`;

/**
 * Looks for the errors of up to `limit` replays not yet linked, oldest
 * first; returns how many were linked and how many given up.
 */
export async function linkReplays(
  db: Kysely<Database>,
  reader: Reader,
  {
    now = new Date(),
    limit = 200,
    onlyProjectId,
  }: {
    now?: Date;
    limit?: number;
    /** One project's replays only (the development seed); every project's when left out. */
    onlyProjectId?: string;
  } = {},
): Promise<{ linked: number; givenUp: number }> {
  // The due replays, at most LINK_PER_PROJECT of each project, the most due first.
  const waiting = await db
    .selectFrom((eb) => {
      let replays = eb.selectFrom("replays");
      if (onlyProjectId !== undefined) replays = replays.where("project_id", "=", onlyProjectId);
      return replays
        .select([
          "project_id",
          "replay_id",
          "created_at",
          "started_at",
          "ended_at",
          "next_link_at",
          sql<string>`row_number() over (partition by project_id order by next_link_at, replay_id)`.as(
            "place",
          ),
        ])
        .where("linked", "=", false)
        .where("next_link_at", "<=", now)
        .as("due");
    })
    .select(["project_id", "replay_id", "created_at", "started_at", "ended_at"])
    .where("place", "<=", String(LINK_PER_PROJECT))
    .orderBy("next_link_at")
    .orderBy("replay_id")
    .limit(limit)
    .execute();
  const byProject = Map.groupBy(waiting, (row) => row.project_id);

  let linked = 0;
  let givenUp = 0;
  for (const [projectId, replays] of byProject) {
    const times = replays.flatMap((row) => [row.created_at, row.started_at, row.ended_at]);
    const from = new Date(Math.min(...times.map(Number)) - LINK_MARGIN_MS);
    const to = new Date(Math.max(...times.map(Number)) + LINK_MARGIN_MS);
    const params = new QueryParams();
    const rows = await queryRows<LinkRow>(
      reader,
      // Not "AS replay_id": ClickHouse would read the alias in WHERE.
      `SELECT toString(replay_id) AS replay,
              min(occurred_at) AS error_at,
              argMin(error_fingerprint, (occurred_at, event_id)) AS fingerprint,
              argMin(error_type, (occurred_at, event_id)) AS type,
              argMin(error_message, (occurred_at, event_id)) AS message,
              argMin(environment, (occurred_at, event_id)) AS environment,
              ${firstOf("user_id")} AS user_id,
              ${firstOf("browser")} AS browser,
              ${firstOf("os")} AS os,
              ${firstOf("device_type")} AS device_type
       FROM events
       WHERE project_id = ${params.add(projectId, "UUID")}
         AND occurred_at >= ${params.time(from)}
         AND occurred_at < ${params.time(to)}
         AND name = '${ERROR}'
         AND replay_id IN ${params.add(
           replays.map((row) => row.replay_id),
           "Array(UUID)",
         )}
       GROUP BY replay_id`,
      params,
    );
    const found = new Map(rows.map((row) => [row.replay, row]));
    for (const replay of replays) {
      const row = found.get(replay.replay_id);
      if (row !== undefined) {
        await db
          .updateTable("replays")
          .set({
            linked: true,
            error_at: fromClickHouseTime(row.error_at),
            error_fingerprint: orNull(row.fingerprint),
            error_type: truncate(row.type, MAX_TYPE_LENGTH),
            error_message: truncate(row.message, MAX_MESSAGE_LENGTH),
            environment: orNull(row.environment),
            user_id: orNull(row.user_id),
            browser: orNull(row.browser),
            os: orNull(row.os),
            device_type: orNull(row.device_type),
          })
          .where("project_id", "=", projectId)
          .where("replay_id", "=", replay.replay_id)
          .execute();
        linked += 1;
      } else if (now.getTime() - replay.created_at.getTime() >= LINK_WAIT_MS) {
        await db
          .updateTable("replays")
          .set({ linked: true })
          .where("project_id", "=", projectId)
          .where("replay_id", "=", replay.replay_id)
          .execute();
        givenUp += 1;
      } else {
        // Not there yet: later, so the next runs look at others first.
        await db
          .updateTable("replays")
          .set({ next_link_at: nextLinkAt(replay.created_at, now) })
          .where("project_id", "=", projectId)
          .where("replay_id", "=", replay.replay_id)
          .execute();
      }
    }
  }
  return { linked, givenUp };
}
