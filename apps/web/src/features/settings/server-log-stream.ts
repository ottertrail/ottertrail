import * as React from "react";

import { parseLine, type ServerLine } from "./server-log-lines";

/** Stream route: apps/api/src/server-log/routes.ts. */
export const SERVER_LOG_URL = "/api/settings/server-log";
/** EventSource hides refusal status. This request uses the same permission, so 401 or 403 means the session or owner access ended. */
const ACCESS_PROBE_URL = "/api/settings";

export const SERVER_LOG_TIMING = {
  /** Cap line count and bytes; discard the oldest first. */
  maxLines: 5000,
  maxBytes: 8 * 1024 * 1024,
  /** Batch incoming lines so bursts cause one render. */
  flushMs: 100,
  /** Double reconnect delays from the first value to the last. */
  retryMs: { first: 1000, max: 30_000 },
};

export type EndReason = "busy" | "access" | "slow";

export type Connection =
  | { state: "connecting" }
  | { state: "live" }
  | { state: "reconnecting"; inSeconds: number }
  | { state: "closed"; reason: EndReason; maxStreams?: number };

export interface ServerLogStream {
  lines: readonly ServerLine[];
  connection: Connection;
  apiLevel: string | null;
  maxLines: number | null;
  reconnect: () => void;
}

const isEndReason = (value: unknown): value is EndReason =>
  value === "busy" || value === "access" || value === "slow";

function parseObject(data: unknown): Record<string, unknown> {
  if (typeof data !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
}

/** Retry lost connections after 1, 2, 4, then up to 30 seconds, using the last cursor. Keep existing lines. API closures wait for manual reconnect. */
export function useServerLog({ enabled }: { enabled: boolean }): ServerLogStream {
  const [lines, setLines] = React.useState<readonly ServerLine[]>([]);
  const [connection, setConnection] = React.useState<Connection>({ state: "connecting" });
  const [apiLevel, setApiLevel] = React.useState<string | null>(null);
  const [maxLines, setMaxLines] = React.useState<number | null>(null);
  const restart = React.useRef<(() => void) | null>(null);
  const lastId = React.useRef<string | null>(null);
  const counter = React.useRef(0);
  const retryMs = React.useRef(SERVER_LOG_TIMING.retryMs.first);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let source: EventSource | null = null;
    let pending: ServerLine[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const flush = () => {
      flushTimer = undefined;
      if (pending.length === 0) return;
      const arrived = pending;
      pending = [];
      setLines((previous) => {
        const next = [...previous, ...arrived];
        let from = Math.max(0, next.length - SERVER_LOG_TIMING.maxLines);
        let bytes = 0;
        for (let index = next.length - 1; index >= from; index -= 1) {
          bytes += next[index]?.bytes ?? 0;
          if (bytes > SERVER_LOG_TIMING.maxBytes) {
            from = index + 1;
            break;
          }
        }
        return from === 0 ? next : next.slice(from);
      });
    };

    const open = () => {
      if (stopped) return;
      setConnection((previous) =>
        previous.state === "reconnecting" ? previous : { state: "connecting" },
      );
      const query = lastId.current === null ? "" : `?after=${encodeURIComponent(lastId.current)}`;
      const opened = new EventSource(`${SERVER_LOG_URL}${query}`);
      source = opened;
      opened.addEventListener("hello", (event) => {
        const hello = parseObject(event.data);
        if (typeof hello.apiLevel === "string") setApiLevel(hello.apiLevel);
        if (typeof hello.maxLines === "number") setMaxLines(hello.maxLines);
      });
      opened.addEventListener("message", (event) => {
        if (event.lastEventId !== "") lastId.current = event.lastEventId;
        counter.current += 1;
        const line = parseLine(String(event.data), counter.current);
        if (line === null) return;
        pending.push(line);
        flushTimer ??= setTimeout(flush, SERVER_LOG_TIMING.flushMs);
      });
      opened.addEventListener("ready", () => {
        retryMs.current = SERVER_LOG_TIMING.retryMs.first;
        flush();
        setConnection({ state: "live" });
      });
      opened.addEventListener("end", (event) => {
        const end = parseObject(event.data);
        opened.close();
        flush();
        if (isEndReason(end.reason)) {
          setConnection({
            state: "closed",
            reason: end.reason,
            ...(typeof end.maxStreams === "number" ? { maxStreams: end.maxStreams } : {}),
          });
        }
      });
      opened.addEventListener("error", () => {
        // Use this backoff instead of EventSource's automatic retry.
        opened.close();
        if (stopped || source !== opened) return;
        source = null;
        flush();
        const wait = retryMs.current;
        retryMs.current = Math.min(wait * 2, SERVER_LOG_TIMING.retryMs.max);
        setConnection({ state: "reconnecting", inSeconds: Math.max(1, Math.round(wait / 1000)) });
        retryTimer = setTimeout(open, wait);
        // Do not retry an expired session or revoked permission.
        void fetch(ACCESS_PROBE_URL, { credentials: "same-origin" }).then(
          (response) => {
            if (stopped || source !== null) return;
            if (response.status === 401 || response.status === 403) {
              clearTimeout(retryTimer);
              setConnection({ state: "closed", reason: "access" });
            }
          },
          // Keep retrying while the API is unreachable.
          () => undefined,
        );
      });
    };

    restart.current = () => {
      clearTimeout(retryTimer);
      source?.close();
      source = null;
      retryMs.current = SERVER_LOG_TIMING.retryMs.first;
      setConnection({ state: "connecting" });
      open();
    };
    open();
    return () => {
      stopped = true;
      restart.current = null;
      source?.close();
      clearTimeout(retryTimer);
      clearTimeout(flushTimer);
      flush();
    };
  }, [enabled]);

  const reconnect = () => restart.current?.();

  return { lines, connection, apiLevel, maxLines, reconnect };
}
