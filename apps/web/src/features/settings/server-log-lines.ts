/** Read API and worker lines as { process, line } (apps/api/src/server-log/routes.ts; docs/dashboard.md, "Server log"). */

export type ServerProcess = "api" | "worker";

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
  n: number;
  process: ServerProcess;
  level: LevelName;
  time: number | null;
  msg: string;
  request: { method: string; url: string; status: number | null; ms: number | null } | null;
  /** Preserve the masked process output (redact.ts). */
  raw: Record<string, unknown>;
  search: string;
  bytes: number;
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
    search: JSON.stringify(raw).toLowerCase(),
    bytes: data.length,
  };
}

export interface LineGroup {
  key: string;
  count: number;
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
      (text === "" || line.search.includes(text)),
  );
}

/** Report levels hidden by LOG_LEVEL, such as info lines when LOG_LEVEL is warn. */
export function missingNote(apiLevel: string | null, lowestShown: LevelName): string | null {
  if (apiLevel === null) return null;
  const written = levelRank(apiLevel);
  const missing = LEVELS.filter((_level, rank) => rank >= levelRank(lowestShown) && rank < written);
  if (missing.length === 0) return null;
  const names = missing.map((level) => (level === "warn" ? "warning" : level)).toReversed();
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} or ${names.at(-1)}`;
  return apiLevel === "silent"
    ? "LOG_LEVEL is silent on this server, so the API writes no lines."
    : `LOG_LEVEL is ${apiLevel} on this server, so the API writes no ${listed} lines.`;
}

export function toJsonl(lines: readonly ServerLine[]): string {
  return lines
    .map((line) => `${JSON.stringify({ process: line.process, ...line.raw })}\n`)
    .join("");
}
