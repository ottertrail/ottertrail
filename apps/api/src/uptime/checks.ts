import { type Kysely, type Selectable, sql, type Transaction } from "kysely";

import type { CheckCause, Database, UptimeChecksTable } from "../db/schema.ts";
import type { CheckOutcome } from "./request.ts";
import { DEFAULT_STATUSES, formatStatuses, parseStatuses } from "./statuses.ts";

/**
 * A project's uptime checks in PostgreSQL (docs/uptime-alerts.md): what
 * each asks and expects, its state, and its incidents. The worker takes
 * due checks (takeDueChecks), runs them (request.ts), and records each
 * outcome (recordOutcome), the one place a check's state changes.
 */

/** How often a check may run, in seconds: every 1, 2, 5, 10, 15, 30, or 60 minutes. */
export const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600] as const;
export const DEFAULT_INTERVAL = 300;
export const DEFAULT_TIMEOUT = 10;
export const MAX_TIMEOUT = 30;
export const DEFAULT_FAILURES_BEFORE_DOWN = 2;
export const MAX_FAILURES_BEFORE_DOWN = 5;
/** Checks a project may have. */
export const MAX_CHECKS = 50;
export const MAX_NAME = 100;
export const MAX_URL = 2048;
export const MAX_WORD = 200;
/**
 * A new or resumed check's first run comes at a random moment within its
 * interval, at most this far off, so checks set up together do not all
 * fire at once, and an hourly check still answers within minutes.
 */
export const MAX_FIRST_RUN_DELAY_SECONDS = 300;

export type CheckState = "pending" | "up" | "down";

/** A check as the API answers it. */
export interface Check {
  id: string;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatuses: string;
  word: string | null;
  wordMode: "present" | "absent";
  failuresBeforeDown: number;
  paused: boolean;
  state: CheckState;
  consecutiveFailures: number;
  /** Since when the current run of failures has lasted, and its first cause. */
  failingSince: Date | null;
  failingCause: CheckCause | null;
  lastCheckedAt: Date | null;
  lastUp: boolean | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  lastCause: CheckCause | null;
  tlsExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CheckRow = Selectable<UptimeChecksTable>;

export function checkOf(row: CheckRow): Check {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    intervalSeconds: row.interval_seconds,
    timeoutSeconds: row.timeout_seconds,
    expectedStatuses: row.expected_statuses,
    word: row.word,
    wordMode: row.word_mode,
    failuresBeforeDown: row.failures_before_down,
    paused: row.paused,
    state: row.state,
    consecutiveFailures: row.consecutive_failures,
    failingSince: row.failing_since,
    failingCause: row.failing_cause,
    lastCheckedAt: row.last_checked_at,
    lastUp: row.last_up,
    lastStatusCode: row.last_status_code,
    lastResponseMs: row.last_response_ms,
    lastCause: row.last_cause,
    tlsExpiresAt: row.tls_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What a member sets on a check; every field is optional on a change. */
export interface CheckInput {
  name?: string | undefined;
  url?: string | undefined;
  method?: "GET" | "HEAD" | undefined;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
  expectedStatuses?: string | undefined;
  word?: string | null | undefined;
  wordMode?: "present" | "absent" | undefined;
  failuresBeforeDown?: number | undefined;
}

/** A refused value: a code and a sentence the dashboard shows as it is. */
export interface Problem {
  error: string;
  message: string;
}

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** The URL a check may request, or why not: http or https, a host, no user or password. */
export function checkUrlOf(text: string): URL | Problem {
  const trimmed = text.trim();
  const url = URL.parse(trimmed);
  if (trimmed === "" || url === null) {
    return {
      error: "invalid_url",
      message: "Enter a full URL, such as https://example.com/health.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "invalid_url", message: "A check's URL starts with http:// or https://." };
  }
  if (url.hostname === "") {
    return { error: "invalid_url", message: "The URL has no host." };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      error: "invalid_url",
      message: "A check's URL holds no user name or password: they would be stored as plain text.",
    };
  }
  url.hash = "";
  if (url.href.length > MAX_URL) {
    return { error: "invalid_url", message: `A check's URL has at most ${MAX_URL} characters.` };
  }
  return url;
}

/** A check's stored values, after defaults; or the first problem with them. */
export interface CheckValues {
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatuses: string;
  word: string | null;
  wordMode: "present" | "absent";
  failuresBeforeDown: number;
}

/**
 * The values a check would have with `input` over `base` (its current
 * values, or none for a new check), each checked; or the first problem.
 * Fastify's schema has already checked the types and bounds it can.
 */
export function checkValuesOf(input: CheckInput, base?: CheckValues): CheckValues | Problem {
  const urlText = input.url ?? base?.url;
  if (urlText === undefined) {
    return { error: "invalid_url", message: "Enter the URL to check." };
  }
  const url = checkUrlOf(urlText);
  if (!(url instanceof URL)) return url;
  const name = (input.name ?? base?.name ?? "").trim() || url.hostname;
  if (name.length > MAX_NAME || CONTROL.test(name)) {
    return {
      error: "invalid_name",
      message: `A check's name has at most ${MAX_NAME} characters, and no control characters.`,
    };
  }
  const statusesText = input.expectedStatuses ?? base?.expectedStatuses ?? DEFAULT_STATUSES;
  const statuses = parseStatuses(statusesText);
  if (statuses === null) {
    return {
      error: "invalid_statuses",
      message:
        "The status codes that count as up are codes from 100 to 599 and ranges, separated by commas, such as 200-399 or 200, 204.",
    };
  }
  const rawWord = input.word === undefined ? (base?.word ?? null) : input.word;
  const word = rawWord === null || rawWord === "" ? null : rawWord;
  if (word !== null && (word.trim() === "" || word.length > MAX_WORD || CONTROL.test(word))) {
    return {
      error: "invalid_word",
      message: `The word has 1 to ${MAX_WORD} characters, not only spaces, and no control characters.`,
    };
  }
  const method = input.method ?? base?.method ?? "GET";
  if (word !== null && method === "HEAD") {
    return {
      error: "invalid_word",
      message: "A HEAD request gets no body to look for the word in: use GET.",
    };
  }
  const intervalSeconds = input.intervalSeconds ?? base?.intervalSeconds ?? DEFAULT_INTERVAL;
  if (!INTERVALS.some((interval) => interval === intervalSeconds)) {
    return {
      error: "invalid_interval",
      message: "A check runs every 1, 2, 5, 10, 15, 30, or 60 minutes.",
    };
  }
  const timeoutSeconds = input.timeoutSeconds ?? base?.timeoutSeconds ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT) {
    return {
      error: "invalid_timeout",
      message: `The timeout is a whole number of seconds from 1 to ${MAX_TIMEOUT}.`,
    };
  }
  const failuresBeforeDown =
    input.failuresBeforeDown ?? base?.failuresBeforeDown ?? DEFAULT_FAILURES_BEFORE_DOWN;
  if (
    !Number.isInteger(failuresBeforeDown) ||
    failuresBeforeDown < 1 ||
    failuresBeforeDown > MAX_FAILURES_BEFORE_DOWN
  ) {
    return {
      error: "invalid_failures",
      message: `A check is down after 1 to ${MAX_FAILURES_BEFORE_DOWN} failures in a row.`,
    };
  }
  return {
    name,
    url: url.href,
    method,
    intervalSeconds,
    timeoutSeconds,
    expectedStatuses: formatStatuses(statuses),
    word,
    wordMode: input.wordMode ?? base?.wordMode ?? "present",
    failuresBeforeDown,
  };
}

const valuesOfCheck = (check: Check): CheckValues => ({
  name: check.name,
  url: check.url,
  method: check.method,
  intervalSeconds: check.intervalSeconds,
  timeoutSeconds: check.timeoutSeconds,
  expectedStatuses: check.expectedStatuses,
  word: check.word,
  wordMode: check.wordMode,
  failuresBeforeDown: check.failuresBeforeDown,
});

export { valuesOfCheck };

const columnsOf = (values: CheckValues) => ({
  name: values.name,
  url: values.url,
  method: values.method,
  interval_seconds: values.intervalSeconds,
  timeout_seconds: values.timeoutSeconds,
  expected_statuses: values.expectedStatuses,
  word: values.word,
  word_mode: values.wordMode,
  failures_before_down: values.failuresBeforeDown,
});

/** When a new or resumed check first runs: a random moment within its interval, at most 5 minutes off. */
export function firstRunAt(now: Date, intervalSeconds: number, random = Math.random): Date {
  const spread = Math.min(intervalSeconds, MAX_FIRST_RUN_DELAY_SECONDS) * 1000;
  return new Date(now.getTime() + Math.floor(random() * spread));
}

/** A project's checks, oldest first (the order they were added in), then by name. */
export async function listChecks(db: Kysely<Database>, projectId: string): Promise<Check[]> {
  const rows = await db
    .selectFrom("uptime_checks")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at")
    .orderBy("name")
    .orderBy("id")
    .execute();
  return rows.map(checkOf);
}

export async function findCheck(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
): Promise<Check | null> {
  const row = await db
    .selectFrom("uptime_checks")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("id", "=", checkId)
    .executeTakeFirst();
  return row === undefined ? null : checkOf(row);
}

/** Adds a check, due at a random moment soon; or refuses when the project has MAX_CHECKS. */
export async function createCheck(
  db: Kysely<Database>,
  projectId: string,
  values: CheckValues,
  now: Date,
): Promise<{ check: Check } | { refused: "too_many" }> {
  return db.transaction().execute(async (trx) => {
    // Adds to one project wait for each other here, so two at once
    // cannot both find room for the last check.
    await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();
    const { count } = await trx
      .selectFrom("uptime_checks")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_CHECKS) return { refused: "too_many" as const };
    const row = await trx
      .insertInto("uptime_checks")
      .values({
        project_id: projectId,
        ...columnsOf(values),
        next_due_at: firstRunAt(now, values.intervalSeconds),
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { check: checkOf(row) };
  });
}

/** Ends a check's open incident, if it has one, at `at`. */
async function closeIncident(trx: Transaction<Database>, checkId: string, at: Date) {
  return trx
    .updateTable("uptime_incidents")
    .set({ ended_at: at })
    .where("check_id", "=", checkId)
    .where("ended_at", "is", null)
    .returning("id")
    .executeTakeFirst();
}

/**
 * Changes a check's values, and pauses or resumes it. A changed interval
 * or a resumed check is due again at a random moment soon. Pausing ends
 * an open incident and forgets the state: nothing is known of the check
 * while it does not run, and it starts again as pending. A changed URL
 * does the same, and forgets the old URL's certificate; a run of the old
 * URL still under way is not recorded (recordOutcome).
 */
export async function updateCheck(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
  values: CheckValues,
  paused: boolean | undefined,
  now: Date,
): Promise<Check | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("uptime_checks")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("id", "=", checkId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return null;
    const pausing = paused === true && !row.paused;
    const resuming = paused === false && row.paused;
    const rescheduled = resuming || values.intervalSeconds !== row.interval_seconds;
    // Another URL is another check: what was known of the old one does not carry over.
    const moved = values.url !== row.url;
    if (pausing || moved) await closeIncident(trx, checkId, now);
    const updated = await trx
      .updateTable("uptime_checks")
      .set({
        ...columnsOf(values),
        ...(paused === undefined ? {} : { paused }),
        ...(rescheduled ? { next_due_at: firstRunAt(now, values.intervalSeconds) } : {}),
        ...(pausing || moved
          ? {
              state: "pending" as const,
              consecutive_failures: 0,
              failing_since: null,
              failing_cause: null,
              failing_detail: null,
            }
          : {}),
        ...(moved ? { tls_expires_at: null, url_changed_at: now } : {}),
        updated_at: now,
      })
      .where("id", "=", checkId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return checkOf(updated);
  });
}

/** Deletes a check with its incidents; false when the project has none with this ID. */
export async function deleteCheck(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom("uptime_checks")
    .where("project_id", "=", projectId)
    .where("id", "=", checkId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** A due check, as the worker runs it. */
export type DueCheck = Pick<
  CheckRow,
  | "id"
  | "project_id"
  | "url"
  | "method"
  | "interval_seconds"
  | "timeout_seconds"
  | "expected_statuses"
  | "word"
  | "word_mode"
  | "next_due_at"
> & {
  /** When it was due, before it was moved on. */
  due_at: Date;
  /** When it was taken, by PostgreSQL's clock. */
  taken_at: Date;
};

/** Due checks one statement looks at, before the per-project limit picks among them. */
const DUE_CANDIDATES = 1000;

export interface TakeOptions {
  /** Checks to take at most. */
  limit: number;
  /** Checks one project may have running at once, those already running included. */
  perProject: number;
  /** Checks running now, by project. */
  running?: ReadonlyMap<string, number>;
  /** The moment to take them at; PostgreSQL's now() when left out (tests fix it). */
  now?: Date | undefined;
}

/**
 * Takes up to `limit` due checks, at most `perProject` running at once for
 * any one project, oldest due first, and moves each one's next due time
 * on by whole intervals past now, keeping its place in the interval, in
 * the same statement: the worker commits that before any request, so a
 * crash during one skips that run instead of repeating it, and the check
 * is due again one interval later. FOR UPDATE SKIP LOCKED: two workers at
 * once never take the same check.
 *
 * Time is PostgreSQL's, not the worker's: a worker whose clock jumped
 * ahead cannot push checks into the future. A next due time further
 * ahead than one interval, as a clock that jumped back leaves, is brought
 * back to one interval from now first.
 */
export async function takeDueChecks(
  db: Kysely<Database>,
  { limit, perProject, running = new Map(), now }: TakeOptions,
): Promise<DueCheck[]> {
  if (limit <= 0) return [];
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  await sql`
    update uptime_checks
    set next_due_at = ${at} + make_interval(secs => interval_seconds)
    where next_due_at > ${at} + make_interval(secs => interval_seconds)
  `.execute(db);
  const busy = [...running].filter(([, count]) => count > 0);
  const { rows } = await sql<DueCheck>`
    with candidates as (
      select id, project_id, next_due_at from uptime_checks
      where not paused and next_due_at <= ${at}
      order by next_due_at
      limit ${DUE_CANDIDATES}
      for update skip locked
    ),
    ranked as (
      select candidates.*,
        row_number() over (partition by project_id order by next_due_at, id) as place
      from candidates
    ),
    busy as (
      select * from unnest(
        ${busy.map(([projectId]) => projectId)}::uuid[],
        ${busy.map(([, count]) => count)}::int[]
      ) as busy (project_id, running)
    ),
    chosen as (
      select ranked.id, ranked.next_due_at from ranked
      left join busy on busy.project_id = ranked.project_id
      where ranked.place <= ${perProject} - coalesce(busy.running, 0)
      order by ranked.next_due_at, ranked.id
      limit ${limit}
    )
    update uptime_checks as c
    set next_due_at = c.next_due_at + make_interval(secs => c.interval_seconds * (
      floor(extract(epoch from (${at} - c.next_due_at)) / c.interval_seconds) + 1
    ))
    from chosen
    where c.id = chosen.id
    returning c.id, c.project_id, c.url, c.method, c.interval_seconds, c.timeout_seconds,
      c.expected_statuses, c.word, c.word_mode, c.next_due_at,
      chosen.next_due_at as due_at, ${at} as taken_at
  `.execute(db);
  return rows;
}

/**
 * A check going down or coming back up: what recordOutcome returns, for
 * whatever acts on it (alerts, when they exist; docs/uptime-alerts.md).
 */
export interface StateChange {
  checkId: string;
  projectId: string;
  from: CheckState;
  to: "up" | "down";
  at: Date;
  /** The incident it opened (down) or ended (up). */
  incidentId: string;
  /** The incident's first cause. */
  cause: CheckCause;
  detail: string;
}

/**
 * Records one run's outcome on its check, and changes the check's state
 * when it should (unless a later run or a URL change came first): down
 * after failuresBeforeDown failures in a row, with
 * an incident from the first of them; up again after one success, which
 * ends the incident. Each time down is one incident. The one place a
 * check's state changes; it returns the change, or null when there was
 * none (nothing is recorded for a check paused or deleted meanwhile).
 */
export async function recordOutcome(
  db: Kysely<Database>,
  checkId: string,
  outcome: CheckOutcome,
  at: Date,
): Promise<StateChange | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("uptime_checks")
      .selectAll()
      .where("id", "=", checkId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined || row.paused) return null;
    // A run that started before the latest recorded one, or before the URL
    // changed, is out of date: two overlapping runs never record out of order.
    if (
      (row.last_checked_at !== null && at < row.last_checked_at) ||
      (row.url_changed_at !== null && at < row.url_changed_at)
    ) {
      return null;
    }
    const last = {
      last_checked_at: at,
      last_up: outcome.up,
      last_status_code: outcome.statusCode,
      last_response_ms: outcome.responseMs,
      last_cause: outcome.cause,
      ...(outcome.tlsExpiresAt === null ? {} : { tls_expires_at: outcome.tlsExpiresAt }),
    };
    if (outcome.up) {
      await trx
        .updateTable("uptime_checks")
        .set({
          ...last,
          state: "up",
          consecutive_failures: 0,
          failing_since: null,
          failing_cause: null,
          failing_detail: null,
        })
        .where("id", "=", checkId)
        .execute();
      if (row.state !== "down") return null;
      const ended = await closeIncident(trx, checkId, at);
      return {
        checkId,
        projectId: row.project_id,
        from: "down",
        to: "up",
        at,
        incidentId: ended?.id ?? "",
        cause: row.failing_cause ?? "connection",
        detail: row.failing_detail ?? "",
      };
    }
    const failures = row.consecutive_failures + 1;
    const since = row.failing_since ?? at;
    const cause = row.failing_cause ?? outcome.cause ?? "connection";
    const detail = row.failing_detail ?? outcome.detail;
    const goesDown = failures >= row.failures_before_down && row.state !== "down";
    await trx
      .updateTable("uptime_checks")
      .set({
        ...last,
        consecutive_failures: failures,
        failing_since: since,
        failing_cause: cause,
        failing_detail: detail,
        ...(goesDown ? { state: "down" as const } : {}),
      })
      .where("id", "=", checkId)
      .execute();
    if (!goesDown) return null;
    const incident = await trx
      .insertInto("uptime_incidents")
      .values({
        check_id: checkId,
        project_id: row.project_id,
        started_at: since,
        cause,
        detail,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return {
      checkId,
      projectId: row.project_id,
      from: row.state,
      to: "down",
      at,
      incidentId: incident.id,
      cause,
      detail,
    };
  });
}

/** One time a check was down, as the API answers it. */
export interface Incident {
  id: string;
  startedAt: Date;
  /** null while it is still down. */
  endedAt: Date | null;
  cause: CheckCause;
  detail: string;
}

/** Incidents most shown on a check's page: the latest. */
export const MAX_INCIDENTS = 100;

/** A check's incidents that overlap [from, to), newest first, at most MAX_INCIDENTS. */
export async function incidentsIn(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
  from: Date,
  to: Date,
): Promise<{ incidents: Incident[]; truncated: boolean }> {
  const rows = await db
    .selectFrom("uptime_incidents")
    .select(["id", "started_at", "ended_at", "cause", "detail"])
    .where("project_id", "=", projectId)
    .where("check_id", "=", checkId)
    .where("started_at", "<", to)
    .where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", from)]))
    .orderBy("started_at", "desc")
    .limit(MAX_INCIDENTS + 1)
    .execute();
  return {
    incidents: rows.slice(0, MAX_INCIDENTS).map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      cause: row.cause,
      detail: row.detail,
    })),
    truncated: rows.length > MAX_INCIDENTS,
  };
}

/** A period uptime is worked out over. */
export interface Window {
  from: Date;
  to: Date;
}

/**
 * Each check's uptime over each window: the share of the window not
 * inside one of its incidents (an open one lasts until `now`), counted
 * from when the check was created if that is later. null for a window the
 * check did not exist in. Paused time is not inside an incident, so it
 * counts as up.
 */
export async function uptimes(
  db: Kysely<Database>,
  projectId: string,
  checks: readonly Pick<Check, "id" | "createdAt">[],
  windows: readonly Window[],
  now: Date,
): Promise<Map<string, (number | null)[]>> {
  const result = new Map<string, (number | null)[]>();
  if (checks.length === 0 || windows.length === 0) return result;
  const earliest = new Date(Math.min(...windows.map((window) => window.from.getTime())));
  const ids = checks.map((check) => check.id);
  // Incidents start after their check was created, so only the window's
  // length needs that cut; an open incident lasts until now.
  const rows = await db
    .selectFrom("uptime_incidents")
    .select("check_id")
    .select(
      windows.map((window, index) =>
        sql<number>`coalesce(sum(greatest(0, extract(epoch from (
          least(coalesce(ended_at, ${now}::timestamptz), ${window.to}::timestamptz, ${now}::timestamptz)
          - greatest(started_at, ${window.from}::timestamptz)
        )))), 0)::float8`.as(`down_${index}`),
      ),
    )
    .where("project_id", "=", projectId)
    .where("check_id", "in", ids)
    .where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">", earliest)]))
    .groupBy("check_id")
    .execute();
  const downOf = new Map(
    rows.map((row) => {
      const record = row as Record<string, unknown>;
      return [row.check_id, windows.map((_, index) => Number(record[`down_${index}`] ?? 0))];
    }),
  );
  for (const check of checks) {
    const down = downOf.get(check.id);
    result.set(
      check.id,
      windows.map((window, index) => {
        const from = Math.max(window.from.getTime(), check.createdAt.getTime());
        const to = Math.min(window.to.getTime(), now.getTime());
        if (to <= from) return null;
        const seconds = down?.[index] ?? 0;
        return Math.min(1, Math.max(0, 1 - (seconds * 1000) / (to - from)));
      }),
    );
  }
  return result;
}
