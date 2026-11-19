import * as React from "react";

import { ApiError } from "@/lib/api";
import { fetchLiveLogs, type LiveLogs, type LogFilters, type LogSummary } from "@/lib/logs-api";

import { formatWhole } from "../analytics/format";

/**
 * The Logs page's live view (docs/dashboard.md, "Live"): it polls for
 * records that arrived after the last poll, while the tab shows, puts each
 * new one at the top, or holds them while the reader is busy with the
 * list, says where records were left out, and stops by itself after a
 * while.
 */

/** The live view's pace and limits. Tests make them shorter. */
export const LIVE_TIMING = {
  /** Between polls. */
  pollMs: 2000,
  /** The least time between two polls, whatever pollMs says. */
  minGapMs: 250,
  /** Live stops by itself this long after it started or resumed. */
  stopAfterMs: 15 * 60_000,
  /** Records the list keeps, and, apart, records held under "N new records"; the oldest go first. */
  maxRecords: 1000,
};

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the tab shows: a hidden tab polls nothing. */
export function useDocumentVisible(): boolean {
  return React.useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/** A line in the list where records were left out, before the record `before` ("" at the end). */
export interface LiveNote {
  id: string;
  before: string;
  text: string;
}

interface Records {
  /** Newest arrival first. */
  shown: LogSummary[];
  /** Arrived while held, newest first. */
  held: LogSummary[];
  /** More arrived while held than `held` keeps. */
  heldOverflow: boolean;
  notes: LiveNote[];
}

type Change =
  | { type: "arrive"; logs: LogSummary[]; hold: boolean; keep: string | undefined }
  | { type: "show"; keep: string | undefined }
  | { type: "note"; text: string };

/**
 * The list cut to LIVE_TIMING.maxRecords, the oldest first, but never the
 * record `keep` (the one selected), and the notes whose place is gone.
 */
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
    // Before the newest record so far: the records left out are newer than it.
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
  // A record ID already here is a retried copy, or a record read again: dropped.
  const ids = new Set([...records.shown, ...records.held].map((log) => log.id));
  const fresh = next.logs.filter((log) => {
    if (ids.has(log.id)) return false;
    ids.add(log.id);
    return true;
  });
  if (fresh.length === 0) return records;
  if (next.hold) {
    // Held records never push the list out; past the limit, the oldest held go.
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

/** "12:01", or "12:01:05" with `seconds`, in the timezone set in Settings, for a gap's line. */
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

/** The lines a poll adds where records were left out. */
function notesOf(answer: LiveLogs): string[] {
  const notes: string[] = [];
  if (answer.gap !== null) {
    const { from, to } = answer.gap;
    // Under a minute apart, minutes alone could read "12:01 and 12:01".
    const seconds =
      clockTime(from, answer.timeZone, false) === clockTime(to, answer.timeZone, false) ||
      Date.parse(to) - Date.parse(from) < 60_000;
    notes.push(
      `Records between ${clockTime(from, answer.timeZone, seconds)} and ${clockTime(to, answer.timeZone, seconds)} aren't shown. Turn Live off to search the period.`,
    );
  }
  if (answer.skipped > 0) {
    notes.push(
      `${formatWhole(answer.skipped)} ${answer.skipped === 1 ? "record" : "records"} skipped; turn Live off to search them.`,
    );
  }
  return notes;
}

export interface LiveState extends Records {
  /** The instance's timezone, from the first answer. */
  timeZone: string | undefined;
  /** The services of the records seen, for the service filter. */
  services: string[];
  /** Live stopped by itself after LIVE_TIMING.stopAfterMs. */
  stopped: boolean;
  /** The last poll failed: live waits for Retry. */
  error: Error | null;
  /** The first poll has answered. */
  started: boolean;
  /** Puts the held records at the top. */
  showHeld: () => void;
  /** Starts again after it stopped or failed, from the last poll's cursor. */
  resume: () => void;
}

/**
 * Polls the live view from its first render, while the tab shows, at most
 * one poll a LIVE_TIMING.minGapMs. New records join the top of `shown`, or
 * `held` while the reader is busy: paused, scrolled away from the top
 * (`away`), or with a listed record selected (`selected`, which trimming
 * always keeps). They join the top once nothing holds them, or on
 * showHeld. A poll that skipped records, or found a gap since the last
 * (after a stop, or a tab hidden past the API's window), adds a line
 * where they would have been. A busy API (503) is asked again at the next
 * poll, quietly; any other failure stops it until resume. Render it again
 * (a new key) for other filters.
 */
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
  /** When live stops by itself: set at the start, and again on each resume. */
  const [deadline, setDeadline] = React.useState(() => Date.now() + LIVE_TIMING.stopAfterMs);
  const cursor = React.useRef<string | null>(null);
  const request = React.useRef({ projectId, environment, filters });
  /** When the last poll started: the floor between polls holds across restarts too. */
  const lastPoll = React.useRef(Number.NEGATIVE_INFINITY);
  // Held only for a record the list shows: one that left it holds nothing.
  const selectedListed = selected !== undefined && records.shown.some((log) => log.id === selected);
  const hold = paused || away || selectedListed;
  const holdRef = React.useRef({ hold, selected });

  React.useEffect(() => {
    holdRef.current = { hold, selected };
    // Held records join the list once nothing holds them.
    if (!hold) dispatch({ type: "show", keep: selected });
  }, [hold, selected]);

  // The stop: LIVE_TIMING.stopAfterMs after the start or a resume, shown or hidden.
  React.useEffect(() => {
    if (stopped) return undefined;
    const timer = setTimeout(() => setStopped(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [stopped, deadline]);

  // The polls, one after another, while live runs and the tab shows.
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
        // Busy: the API's places are taken. Quietly, at the next poll.
        if (failure instanceof ApiError && failure.status === 503) {
          next();
          return;
        }
        setError(failure instanceof Error ? failure : new Error(String(failure)));
      }
    };
    // At once, unless the last poll (before Show, Resume, Retry, or a tab hidden a moment)
    // was less than LIVE_TIMING.minGapMs ago.
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

/**
 * Whether the element's scroller is at its top: the nearest ancestor that
 * scrolls (the list's pane from 64rem), else the window.
 */
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
