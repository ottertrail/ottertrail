import * as React from "react";

import { parseLine, type ServerLine } from "./server-log-lines";

/** The stream (apps/api/src/server-log/routes.ts). */
export const SERVER_LOG_URL = "/api/settings/server-log";

/** The stream's pace and limits. Tests make them shorter. */
export const SERVER_LOG_TIMING = {
  /** The most lines the browser keeps; older ones go first. */
  maxLines: 5000,
  /** New lines are shown together, at most this often, so a burst is one render. */
  flushMs: 100,
  /** Waits before reconnecting, doubling from the first to the last. */
  retryMs: { first: 1000, max: 30_000 },
};

/** Why the API closed the stream (`end`), or "lost" while the tab reconnects. */
export type EndReason = "busy" | "access" | "slow";

export type Connection =
  | { state: "connecting" }
  | { state: "live" }
  | { state: "reconnecting"; inSeconds: number }
  | { state: "closed"; reason: EndReason; maxStreams?: number };

export interface ServerLogStream {
  lines: readonly ServerLine[];
  connection: Connection;
  /** The API's LOG_LEVEL, from the stream's hello; null until it arrives. */
  apiLevel: string | null;
  /** How many lines the API keeps, from the hello. */
  maxLines: number | null;
  /** Connects again now: after a close, or while waiting to reconnect. */
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

/**
 * The Server log's live stream, while `enabled` (its tab is shown): the
 * lines the API keeps, then each new one. A lost connection reconnects
 * after 1 second, then 2, 4, and up to 30, asking for the lines after the
 * last one it got; the lines already here stay, whatever happens. The API
 * closing the stream (too many open, the session ended, too slow) waits
 * for `reconnect`. Leaving the tab closes it; coming back reconnects.
 */
export function useServerLog({ enabled }: { enabled: boolean }): ServerLogStream {
  const [lines, setLines] = React.useState<readonly ServerLine[]>([]);
  const [connection, setConnection] = React.useState<Connection>({ state: "connecting" });
  const [apiLevel, setApiLevel] = React.useState<string | null>(null);
  const [maxLines, setMaxLines] = React.useState<number | null>(null);
  /** Opens the stream again at once, while the effect runs: what reconnect() calls. */
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
        return next.length > SERVER_LOG_TIMING.maxLines
          ? next.slice(next.length - SERVER_LOG_TIMING.maxLines)
          : next;
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
        // The API went away (a restart) or never answered: this code retries,
        // with its backoff, rather than the browser's own retry.
        opened.close();
        if (stopped || source !== opened) return;
        source = null;
        flush();
        const wait = retryMs.current;
        retryMs.current = Math.min(wait * 2, SERVER_LOG_TIMING.retryMs.max);
        setConnection({ state: "reconnecting", inSeconds: Math.max(1, Math.round(wait / 1000)) });
        retryTimer = setTimeout(open, wait);
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
