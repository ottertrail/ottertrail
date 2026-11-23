import * as React from "react";

import { ApiError } from "@/lib/api";
import { fetchLiveLogs, type LiveLogs, type LogFilters, type LogSummary } from "@/lib/logs-api";

import { formatWhole } from "../analytics/format";

/** Poll by arrival time while visible (docs/dashboard.md, "Live"). Hold arrivals while the reader uses the list. */

/** Tests override these timing limits. */
export const LIVE_TIMING = {
  pollMs: 2000,
  /** Minimum delay applies even when pollMs is shorter. */
  minGapMs: 250,
  /** Stop after this duration from start or resume. */
  stopAfterMs: 15 * 60_000,
  /** Cap shown and held records separately; discard the oldest first. */
  maxRecords: 1000,
};

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

export function useDocumentVisible(): boolean {
  return React.useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/** Insert before `before`; an empty ID places the gap at the end. */
export interface LiveNote {
  id: string;
  before: string;
  text: string;
}

interface Records {
  /** Newest arrivals first. */
  shown: LogSummary[];
  /** Held arrivals, newest first. */
  held: LogSummary[];
  /** True when arrivals exceeded the held-record cap. */
  heldOverflow: boolean;
  notes: LiveNote[];
}

type Change =
  | { type: "arrive"; logs: LogSummary[]; hold: boolean; keep: string | undefined }
  | { type: "show"; keep: string | undefined }
  | { type: "note"; text: string };

/** Trim oldest records to LIVE_TIMING.maxRecords while keeping the selection. Remove notes whose anchors were trimmed. */
function trimmed(records: Records, keep: string | undefined): Records {
  const max = LIVE_TIMING.maxRecords;
  let shown = records.shown.slice(0, max);
  const kept = keep === undefined ? undefined : records.shown.find((log) => log.id === keep);
  if (kept !== undefined && !shown.includes(kept)) shown = [...shown.slice(0, max - 1), kept];
  const ids = new Set([...shown, ...records.held].map((log) => log.id));
  return {
    ...records,
    shown,
    notes: records.notes.filter((note) => note.before === "" || ids.has(note.before)),
  };
}

function change(records: Records, next: Change): Records {
  if (next.type === "note") {
    // Place the gap before the newest known record; skipped records are newer.
    const before = records.held[0]?.id ?? records.shown[0]?.id ?? "";
    const id = `note-${records.notes.length}-${before}-${next.text}`;
    return { ...records, notes: [...records.notes, { id, before, text: next.text }] };
  }
  if (next.type === "show") {
    if (records.held.length === 0) return records;
    return trimmed(
      {
        ...records,
        shown: [...records.held, ...records.shown],
        held: [],
        heldOverflow: false,
      },
      next.keep,
    );
  }
  // Deduplicate retried or reread records by ID.
  const ids = new Set([...records.shown, ...records.held].map((log) => log.id));
  const fresh = next.logs.filter((log) => {
    if (ids.has(log.id)) return false;
    ids.add(log.id);
    return true;
  });
  if (fresh.length === 0) return records;
  if (next.hold) {
    // Cap held records separately so they cannot displace displayed records.
    const held = [...fresh, ...records.held];
    return {
      ...records,
      held: held.slice(0, LIVE_TIMING.maxRecords),
      heldOverflow: records.heldOverflow || held.length > LIVE_TIMING.maxRecords,
    };
  }
  return trimmed({ ...records, shown: [...fresh, ...records.shown] }, next.keep);
}

const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();

function clockTime(iso: string, timeZone: string, seconds: boolean): string {
  const name = `${timeZone} ${seconds}`;
  let format = TIME_FORMATS.get(name);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hourCycle: "h23",
    });
    TIME_FORMATS.set(name, format);
  }
  return format.format(new Date(iso));
}

function notesOf(answer: LiveLogs): string[] {
  const notes: string[] = [];
  if (answer.gap !== null) {
    const { from, to } = answer.gap;
    // Include seconds for gaps under a minute to avoid identical endpoint labels.
    const seconds =
      clockTime(from, answer.timeZone, false) === clockTime(to, answer.timeZone, false) ||
      Date.parse(to) - Date.parse(from) < 60_000;
    notes.push(
      `Records between ${clockTime(from, answer.timeZone, seconds)} and ${clockTime(to, answer.timeZone, seconds)} aren't shown, because Live looks back only 5 minutes. Turn Live off to search the period.`,
    );
  }
  if (answer.skipped > 0) {
    notes.push(
      `${formatWhole(answer.skipped)} ${answer.skipped === 1 ? "record" : "records"} skipped, because more arrived at once than Live shows. Turn Live off to search them.`,
    );
  }
  return notes;
}

export interface LiveState extends Records {
  timeZone: string | undefined;
  services: string[];
  stopped: boolean;
  error: Error | null;
  started: boolean;
  showHeld: () => void;
  resume: () => void;
}

/** Keep selected records when trimming. Retry 503 on the next poll; other failures wait for resume. Remount for new filters. */
export function useLiveLogs({
  projectId,
  environment,
  filters,
  paused,
  away,
  selected,
}: {
  projectId: string;
  environment: string;
  filters: LogFilters;
  paused: boolean;
  away: boolean;
  selected: string | undefined;
}): LiveState {
  const visible = useDocumentVisible();
  const [records, dispatch] = React.useReducer(change, {
    shown: [],
    held: [],
    heldOverflow: false,
    notes: [],
  });
  const [stopped, setStopped] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const [started, setStarted] = React.useState(false);
  const [timeZone, setTimeZone] = React.useState<string | undefined>(undefined);
  const [services, setServices] = React.useState<string[]>([]);
  /** Reset the automatic stop deadline on resume. */
  const [deadline, setDeadline] = React.useState(() => Date.now() + LIVE_TIMING.stopAfterMs);
  const cursor = React.useRef<string | null>(null);
  const request = React.useRef({ projectId, environment, filters });
  /** Preserve the minimum poll delay across restarts. */
  const lastPoll = React.useRef(Number.NEGATIVE_INFINITY);
  // Only a selection still in the list holds arrivals.
  const selectedListed = selected !== undefined && records.shown.some((log) => log.id === selected);
  const hold = paused || away || selectedListed;
  const holdRef = React.useRef({ hold, selected });

  React.useEffect(() => {
    holdRef.current = { hold, selected };
    if (!hold) dispatch({ type: "show", keep: selected });
  }, [hold, selected]);

  // The stop deadline applies even while the tab is hidden.
  React.useEffect(() => {
    if (stopped) return undefined;
    const timer = setTimeout(() => setStopped(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [stopped, deadline]);

  React.useEffect(() => {
    if (stopped || error !== null || !visible) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      timer = setTimeout(() => void poll(), Math.max(LIVE_TIMING.minGapMs, LIVE_TIMING.pollMs));
    };
    const poll = async () => {
      lastPoll.current = Date.now();
      try {
        const asked = request.current;
        const answer = await fetchLiveLogs(
          asked.projectId,
          asked.environment,
          asked.filters,
          cursor.current,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        cursor.current = answer.cursor;
        for (const text of notesOf(answer)) dispatch({ type: "note", text });
        dispatch({
          type: "arrive",
          logs: answer.logs,
          hold: holdRef.current.hold,
          keep: holdRef.current.selected,
        });
        setTimeZone(answer.timeZone);
        setServices((known) => {
          const all = new Set([...known, ...answer.logs.map((log) => log.service)]);
          all.delete("");
          return all.size === known.length ? known : [...all].toSorted();
        });
        setStarted(true);
        next();
      } catch (failure) {
        if (controller.signal.aborted) return;
        // Retry a busy API quietly on the next poll.
        if (failure instanceof ApiError && failure.status === 503) {
          next();
          return;
        }
        setError(failure instanceof Error ? failure : new Error(String(failure)));
      }
    };
    // Keep LIVE_TIMING.minGapMs between polls, including after Show, Resume, Retry, or a brief tab hide.
    timer = setTimeout(
      () => void poll(),
      Math.max(0, lastPoll.current + LIVE_TIMING.minGapMs - Date.now()),
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [stopped, error, visible]);

  const showHeld = React.useCallback(
    () => dispatch({ type: "show", keep: holdRef.current.selected }),
    [],
  );
  const resume = React.useCallback(() => {
    setDeadline(Date.now() + LIVE_TIMING.stopAfterMs);
    setStopped(false);
    setError(null);
  }, []);

  return { ...records, timeZone, services, stopped, error, started, showHeld, resume };
}

/** Use the nearest scrolling ancestor (the list pane from 64rem), or the window. */
export function useAtTop(element: HTMLElement | null): boolean {
  const [atTop, setAtTop] = React.useState(true);
  React.useEffect(() => {
    if (element === null) return undefined;
    let scroller: HTMLElement | null = element.parentElement;
    while (scroller !== null) {
      const { overflowY } = getComputedStyle(scroller);
      if (overflowY === "auto" || overflowY === "scroll") break;
      scroller = scroller.parentElement;
    }
    const pane = scroller;
    const target: HTMLElement | Window = pane ?? window;
    const read = () => setAtTop((pane === null ? window.scrollY : pane.scrollTop) <= 8);
    read();
    target.addEventListener("scroll", read, { passive: true });
    return () => target.removeEventListener("scroll", read);
  }, [element]);
  return atTop;
}
