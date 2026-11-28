import type { ChartPoint } from "@/lib/analytics-api";
import type { Annotation, ReleaseMark } from "@/lib/annotations-api";

import { formatDay } from "./format";

/** The marks of one point, grouped. */
export interface PointMarks {
  notes: Annotation[];
  releases: ReleaseMark[];
}

export type MarkKind = "notes" | "releases";

/** The local moment to compare by: a day starts at 00:00. */
const minuteKey = (local: string) => (local.length === 10 ? `${local}T00:00` : local);

/**
 * The point a local moment ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm") falls on,
 * or null outside the chart. A whole day on an hour chart that starts mid-day
 * falls on its first point.
 */
export function pointIndexOf(chart: readonly ChartPoint[], local: string): number | null {
  const key = minuteKey(local);
  const last = chart.length - 1;
  for (let index = last; index >= 0; index -= 1) {
    const point = chart[index];
    if (point === undefined) continue;
    if (key >= minuteKey(point.start)) {
      return index === last && key > `${point.end}T23:59` ? null : index;
    }
  }
  const first = chart[0];
  return first !== undefined && local.length === 10 && local === first.start.slice(0, 10)
    ? 0
    : null;
}

/** The chart's marks by point, without the kinds hidden. */
export function groupMarks(
  chart: readonly ChartPoint[],
  notes: readonly Annotation[],
  releases: readonly ReleaseMark[],
): Map<number, PointMarks> {
  const groups = new Map<number, PointMarks>();
  const groupAt = (index: number) => {
    let group = groups.get(index);
    if (group === undefined) {
      group = { notes: [], releases: [] };
      groups.set(index, group);
    }
    return group;
  };
  for (const note of notes) {
    const index = pointIndexOf(chart, note.time === null ? note.day : `${note.day}T${note.time}`);
    if (index !== null) groupAt(index).notes.push(note);
  }
  for (const release of releases) {
    const index = pointIndexOf(chart, release.local);
    if (index !== null) groupAt(index).releases.push(release);
  }
  return groups;
}

const HIDDEN_KEY = "ottertrail.chart-marks.hidden";

/** The kinds this browser hid last; none by default. */
export function hiddenKinds(): Set<MarkKind> {
  try {
    const stored = window.localStorage.getItem(HIDDEN_KEY) ?? "";
    return new Set(
      stored.split(",").filter((kind): kind is MarkKind => kind === "notes" || kind === "releases"),
    );
  } catch {
    return new Set();
  }
}

export function rememberHidden(hidden: ReadonlySet<MarkKind>) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, [...hidden].join(","));
  } catch {
    // Storage can be off or full; both kinds then show next time.
  }
}

/** "Tue 10 Nov, 14:30", or the day alone. */
export function whenText(day: string, time: string | null): string {
  const date = formatDay(day, { weekday: true });
  return time === null ? date : `${date}, ${time}`;
}

/** Who wrote a note, when it is, and its environment when it has one. */
export const noteMeta = (note: Annotation) =>
  [note.author?.name, whenText(note.day, note.time), note.environment ?? undefined]
    .filter((part) => part !== undefined)
    .join(" · ");

export const releaseMeta = (release: ReleaseMark) =>
  `first seen ${whenText(release.local.slice(0, 10), release.local.slice(11, 16))}`;

/** A point's marks as one sentence, for the keyboard readout. */
export function marksText(marks: PointMarks | undefined): string {
  if (marks === undefined) return "";
  return [
    ...marks.notes.map((note) => `Note: ${note.text} (${noteMeta(note)})`),
    ...marks.releases.map((release) => `Release ${release.release}, ${releaseMeta(release)}`),
  ].join(". ");
}
