import { type ExpressionBuilder, type Kysely, type Selectable, sql } from "kysely";

import type { Database, ReplaysTable } from "../db/schema.ts";
import { isTimelineItem, type Timeline } from "./derive.ts";

/**
 * Read replay lists and timelines from PostgreSQL, populated by derive.ts
 * and link.ts (docs/session-replay.md, "Finding replays"). Scope every query
 * to the project and parameterize request values.
 */

export const REPLAYS_PAGE_SIZE = 50;
export const MAX_REPLAYS_PAGE_SIZE = 100;
const MAX_CHOICES = 50;
export const USER_REPLAYS = 10;
/**
 * How far past the recording's end an error's time may fall and still mark
 * its end, as the player allows (packages/replay-player/src/format.ts).
 */
const ERROR_AFTER_END_MS = 15_000;

/** "1795003200123_<replay UUID>": the last row of a page, its start in ms and its ID. */
export const REPLAY_CURSOR_PATTERN =
  "^[0-9]{1,15}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export interface ReplayCursor {
  startedAt: Date;
  replayId: string;
}

export const replayCursorText = (cursor: ReplayCursor) =>
  `${String(cursor.startedAt.getTime())}_${cursor.replayId}`;

/** Return null when the cursor matches the pattern but has an invalid time. */
export function replayCursorOf(text: string): ReplayCursor | null {
  const [ms = "", replayId = ""] = text.split("_");
  const startedAt = new Date(Number(ms));
  return Number.isNaN(startedAt.getTime()) ? null : { startedAt, replayId };
}

export interface ReplayFilters {
  /** Started from `from` until before `to`. */
  from?: Date | undefined;
  to?: Date | undefined;
  /** Its error's environment; replays whose error is not found are in every one. */
  environment?: string | undefined;
  /** One of its paths contains this, case ignored. */
  path?: string | undefined;
  userId?: string | undefined;
  fingerprint?: string | undefined;
  minDurationMs?: number | undefined;
}

export interface ReplaySummary {
  id: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  /** The recording stopped at its size limit, or its end never came. */
  cut: boolean;
  pages: string[];
  clicks: number;
  pageChanges: number;
  /** Its first error; null while it is looked for (`linked` false), or when not found. */
  error: { fingerprint: string; type: string; message: string; occurredAt: Date } | null;
  linked: boolean;
  userId: string | null;
  environment: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
}

const SUMMARY_COLUMNS = [
  "replay_id",
  "started_at",
  "ended_at",
  "cut",
  "pages",
  "clicks",
  "page_changes",
  "linked",
  "error_at",
  "error_fingerprint",
  "error_type",
  "error_message",
  "user_id",
  "environment",
  "browser",
  "os",
  "device_type",
] as const;

type SummaryRow = Pick<Selectable<ReplaysTable>, (typeof SUMMARY_COLUMNS)[number]>;

const summaries = (db: Kysely<Database>, projectId: string) =>
  db.selectFrom("replays").select(SUMMARY_COLUMNS).where("project_id", "=", projectId);

export function toSummary(row: SummaryRow): ReplaySummary {
  return {
    id: row.replay_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.ended_at.getTime() - row.started_at.getTime(),
    cut: row.cut,
    pages: row.pages,
    clicks: row.clicks,
    pageChanges: row.page_changes,
    error:
      row.error_at === null || row.error_fingerprint === null
        ? null
        : {
            fingerprint: row.error_fingerprint,
            type: row.error_type ?? "",
            message: row.error_message ?? "",
            occurredAt: row.error_at,
          },
    linked: row.linked,
    userId: row.user_id,
    environment: row.environment,
    browser: row.browser,
    os: row.os,
    deviceType: row.device_type,
  };
}

function filtered(eb: ExpressionBuilder<Database, "replays">, filters: ReplayFilters) {
  const conditions = [];
  if (filters.from !== undefined) conditions.push(eb("started_at", ">=", filters.from));
  if (filters.to !== undefined) conditions.push(eb("started_at", "<", filters.to));
  if (filters.environment !== undefined) {
    conditions.push(
      eb.or([eb("environment", "=", filters.environment), eb("environment", "is", null)]),
    );
  }
  if (filters.userId !== undefined) conditions.push(eb("user_id", "=", filters.userId));
  if (filters.fingerprint !== undefined) {
    conditions.push(eb("error_fingerprint", "=", filters.fingerprint));
  }
  if (filters.minDurationMs !== undefined) {
    conditions.push(
      eb(
        sql`ended_at - started_at`,
        ">=",
        sql`${Math.round(filters.minDurationMs)}::integer * interval '1 millisecond'`,
      ),
    );
  }
  if (filters.path !== undefined && filters.path !== "") {
    // strpos treats search text literally, without wildcards.
    conditions.push(
      eb.exists(
        sql`(select 1 from unnest(pages) as page(path) where strpos(lower(page.path), lower(${filters.path})) > 0)`,
      ),
    );
  }
  return eb.and(conditions);
}

/** Newest first; next is null on the last page. */
export async function listReplays(
  db: Kysely<Database>,
  projectId: string,
  filters: ReplayFilters,
  { before, limit = REPLAYS_PAGE_SIZE }: { before?: ReplayCursor | undefined; limit?: number } = {},
): Promise<{ replays: ReplaySummary[]; next: string | null }> {
  const size = Math.min(Math.max(1, limit), MAX_REPLAYS_PAGE_SIZE);
  let query = summaries(db, projectId).where((eb) => filtered(eb, filters));
  if (before !== undefined) {
    query = query.where(
      sql<boolean>`(started_at, replay_id) < (${before.startedAt}::timestamptz, ${before.replayId}::uuid)`,
    );
  }
  const rows = await query
    .orderBy("started_at", "desc")
    .orderBy("replay_id", "desc")
    .limit(size + 1)
    .execute();
  const page = rows.slice(0, size).map(toSummary);
  const last = page.at(-1);
  return {
    replays: page,
    next:
      rows.length > size && last !== undefined
        ? replayCursorText({ startedAt: last.startedAt, replayId: last.id })
        : null,
  };
}

/**
 * Filter choices include unlinked replays in every environment, matching
 * the list. Order environments and error groups by replay count.
 */
export async function replayChoices(
  db: Kysely<Database>,
  projectId: string,
  period: { from: Date; to: Date },
  environment: string,
): Promise<{
  environments: string[];
  errorGroups: { fingerprint: string; type: string; message: string; replays: number }[];
}> {
  const inPeriod = (eb: ExpressionBuilder<Database, "replays">) =>
    eb.and([
      eb("project_id", "=", projectId),
      eb("started_at", ">=", period.from),
      eb("started_at", "<", period.to),
    ]);
  const [environments, groups] = await Promise.all([
    db
      .selectFrom("replays")
      .select(["environment", sql<string>`count(*)`.as("count")])
      .where(inPeriod)
      .where("environment", "is not", null)
      .groupBy("environment")
      .orderBy(sql`count(*)`, "desc")
      .orderBy("environment")
      .limit(MAX_CHOICES)
      .execute(),
    db
      .selectFrom("replays")
      .select([
        "error_fingerprint",
        sql<string>`(array_agg(error_type order by error_at desc))[1]`.as("type"),
        sql<string>`(array_agg(error_message order by error_at desc))[1]`.as("message"),
        sql<string>`count(*)`.as("count"),
      ])
      .where(inPeriod)
      .where((eb) => eb.or([eb("environment", "=", environment), eb("environment", "is", null)]))
      .where("error_fingerprint", "is not", null)
      .groupBy("error_fingerprint")
      .orderBy(sql`count(*)`, "desc")
      .orderBy("error_fingerprint")
      .limit(MAX_CHOICES)
      .execute(),
  ]);
  return {
    environments: environments.flatMap((row) => row.environment ?? []),
    errorGroups: groups.flatMap((row) =>
      row.error_fingerprint === null
        ? []
        : [
            {
              fingerprint: row.error_fingerprint,
              type: row.type,
              message: row.message,
              replays: Number(row.count),
            },
          ],
    ),
  };
}

export async function userReplays(
  db: Kysely<Database>,
  projectId: string,
  userId: string,
  environment: string,
): Promise<ReplaySummary[]> {
  const rows = await summaries(db, projectId)
    .where("user_id", "=", userId)
    .where("environment", "=", environment)
    .orderBy("started_at", "desc")
    .orderBy("replay_id", "desc")
    .limit(USER_REPLAYS)
    .execute();
  return rows.map(toSummary);
}

export interface ReplayTimeline {
  replay: ReplaySummary;
  timeline: Timeline;
  /**
   * Milliseconds from recording start: prefer the recorder marker, then
   * the first error time. Null if unknown or outside the recording.
   */
  errorOffsetMs: number | null;
  /** The recording's start on its own clock (ms since 1970), as the player counts. */
  recordingStartMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function timelineOf(value: unknown): Timeline {
  if (!isRecord(value) || !Array.isArray(value.items)) return { items: [], truncated: false };
  const { truncated } = value;
  return {
    items: value.items.filter(isTimelineItem),
    truncated: truncated === "scrolls" || truncated === "earliest" ? truncated : false,
  };
}

/** Return null if the project has no matching replay. */
export async function replayTimeline(
  db: Kysely<Database>,
  projectId: string,
  replayId: string,
): Promise<ReplayTimeline | null> {
  const row = await summaries(db, projectId)
    .select(["timeline", "clock_offset_ms"])
    .where("replay_id", "=", replayId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const replay = toSummary(row);
  const timeline = timelineOf(row.timeline);
  const marker = timeline.items.find((item) => item.kind === "error");
  const fromEvent =
    replay.error === null ? null : replay.error.occurredAt.getTime() - replay.startedAt.getTime();
  const errorOffsetMs =
    marker !== undefined
      ? marker.at
      : fromEvent !== null && fromEvent >= 0 && fromEvent <= replay.durationMs + ERROR_AFTER_END_MS
        ? Math.min(fromEvent, replay.durationMs)
        : null;
  return {
    replay,
    timeline,
    errorOffsetMs,
    recordingStartMs: replay.startedAt.getTime() - Number(row.clock_offset_ms),
  };
}
