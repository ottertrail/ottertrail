/**
 * The Server log's lines as the tab reads them (docs/dashboard.md, "Server
 * log"): the API's pino lines and the worker's own, each as the stream
 * sends it (`{ process, line }`, apps/api/src/server-log/routes.ts).
 */

export type ServerProcess = "api" | "worker";

/** Levels, quietest first; trace counts with debug. */
export const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LevelName = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<LevelName, string> = {
  debug: "Debug",
  info: "Info",
  warn: "Warning",
  error: "Error",
  fatal: "Fatal",
};

export const PROCESS_LABELS: Record<ServerProcess, string> = { api: "API", worker: "Worker" };

export interface ServerLine {
  /** Counts up in this browser: the order lines arrived in, and each line's key. */
  n: number;
  process: ServerProcess;
  level: LevelName;
  /** Milliseconds since 1970, or null when the line has no time. */
  time: number | null;
  msg: string;
  /** A request's line: Fastify's "incoming request" and "request completed". */
  request: { method: string; url: string; status: number | null; ms: number | null } | null;
  /** The line as the process wrote it, masked (redact.ts). */
  raw: Record<string, unknown>;
}

const PINO_LEVELS: Record<number, LevelName> = {
  10: "debug",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

function levelOf(value: unknown): LevelName {
  if (typeof value === "number") return PINO_LEVELS[value] ?? (value > 60 ? "fatal" : "info");
  if (typeof value === "string") {
    const name = value.toLowerCase();
    if (name === "trace") return "debug";
    if (name === "warning") return "warn";
    const known = LEVELS.find((level) => level === name);
    if (known !== undefined) return known;
  }
  return "info";
}

/** A LOG_LEVEL's rank among LEVELS: "silent" above them all. */
export function levelRank(level: string): number {
  if (level === "trace") return 0;
  if (level === "silent") return LEVELS.length;
  const rank = (LEVELS as readonly string[]).indexOf(level);
  return rank === -1 ? 0 : rank;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function requestOf(raw: Record<string, unknown>): ServerLine["request"] {
  const source = isObject(raw.res) ? raw.res : isObject(raw.req) ? raw.req : null;
  if (source === null || typeof source.method !== "string" || typeof source.url !== "string") {
    return null;
  }
  return {
    method: source.method,
    url: source.url,
    status: typeof source.statusCode === "number" ? source.statusCode : null,
    ms: typeof raw.responseTime === "number" ? raw.responseTime : null,
  };
}

/** One event's data as a line, or null when it is not one. */
export function parseLine(data: string, n: number): ServerLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isObject(parsed.line)) return null;
  const raw = parsed.line;
  const process: ServerProcess = parsed.process === "worker" ? "worker" : "api";
  return {
    n,
    process,
    level: levelOf(raw.level),
    time: timeOf(raw.time),
    msg: typeof raw.msg === "string" ? raw.msg : "",
    request: requestOf(raw),
    raw,
  };
}

/** Warnings and worse, grouped by process, level, and message, newest group first. */
export interface LineGroup {
  key: string;
  count: number;
  /** The group's newest line. */
  latest: ServerLine;
}

export function groupProblems(lines: readonly ServerLine[]): LineGroup[] {
  const groups = new Map<string, LineGroup>();
  for (const line of lines) {
    if (levelRank(line.level) < levelRank("warn")) continue;
    const key = `${line.process}\u0000${line.level}\u0000${line.msg}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { key, count: 1, latest: line });
    } else {
      group.count += 1;
      if (line.n > group.latest.n) group.latest = line;
    }
  }
  return [...groups.values()].toSorted((a, b) => b.latest.n - a.latest.n);
}

export interface LineFilters {
  process: ServerProcess | "all";
  /** The quietest level shown. */
  level: LevelName;
  text: string;
}

export function filterLines(lines: readonly ServerLine[], filters: LineFilters): ServerLine[] {
  const lowest = levelRank(filters.level);
  const text = filters.text.trim().toLowerCase();
  return lines.filter(
    (line) =>
      (filters.process === "all" || line.process === filters.process) &&
      levelRank(line.level) >= lowest &&
      (text === "" || JSON.stringify(line.raw).toLowerCase().includes(text)),
  );
}

/**
 * What LOG_LEVEL keeps the API from writing that the view would show, or
 * null: "warn" with "info and above" shown leaves no info lines.
 */
export function missingNote(apiLevel: string | null, lowestShown: LevelName): string | null {
  if (apiLevel === null) return null;
  const written = levelRank(apiLevel);
  const missing = LEVELS.filter((_level, rank) => rank >= levelRank(lowestShown) && rank < written);
  if (missing.length === 0) return null;
  // Loudest first: "no info or debug lines".
  const names = missing.map((level) => (level === "warn" ? "warning" : level)).toReversed();
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} or ${names.at(-1)}`;
  return apiLevel === "silent"
    ? "LOG_LEVEL is silent on this server, so the API writes no lines."
    : `LOG_LEVEL is ${apiLevel} on this server, so the API writes no ${listed} lines.`;
}

/** The lines as a .jsonl file's text: one JSON object per line, each with its process. */
export function toJsonl(lines: readonly ServerLine[]): string {
  return lines
    .map((line) => `${JSON.stringify({ process: line.process, ...line.raw })}\n`)
    .join("");
}
