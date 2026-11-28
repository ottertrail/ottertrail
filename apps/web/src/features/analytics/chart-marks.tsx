import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import * as React from "react";
import { usePlotArea, useXAxisScale } from "recharts";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { Analytics } from "@/lib/analytics-api";
import { annotationsQuery, releaseMarksQuery } from "@/lib/annotations-api";
import { loadChunk } from "@/lib/lazy-page";

import {
  groupMarks,
  hiddenKinds,
  type MarkKind,
  marksText,
  noteMeta,
  type PointMarks,
  releaseMeta,
  rememberHidden,
  whenText,
} from "./chart-marks-data";
import type { DayChartMarks } from "./day-chart";
import { formatDay } from "./format";
import { type TrendMarks, useAnalyticsScope } from "./scope";

/*
 * Notes and release marks on the Web analytics chart (docs/web-analytics.md,
 * "Notes and releases on the chart"), on the dashboard only: the shared
 * link's page never loads this file (scope.ts).
 */

/** A note's mark is a circle on a solid line; a release's a diamond on a dashed one. */
export function MarkGlyph({ kind, size = 10 }: { kind: MarkKind; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 10 10" className="shrink-0">
      {kind === "notes" ? (
        <circle cx="5" cy="5" r="4" className="fill-ink-subtle" />
      ) : (
        <path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" className="fill-ink-subtle" />
      )}
    </svg>
  );
}

const MARK_STROKE = "var(--ink-tertiary)";
const RING = "var(--block-surface, var(--background))";

/** The marks, drawn inside the chart at each point's x, under the lines. */
function MarksLayer({ groups }: { groups: ReadonlyMap<number, PointMarks> }) {
  const scale = useXAxisScale();
  const plot = usePlotArea();
  if (scale === undefined || plot === undefined) return null;
  const top = plot.y;
  const bottom = plot.y + plot.height;
  return (
    <g data-slot="chart-marks" pointerEvents="none">
      {[...groups]
        .toSorted(([a], [b]) => a - b)
        .map(([index, marks]) => {
          const x = scale(index);
          if (x === undefined) return null;
          const hasNotes = marks.notes.length > 0;
          const count = marks.notes.length + marks.releases.length;
          const releaseY = hasNotes ? top + 10 : top;
          return (
            <g
              key={index}
              data-mark-index={index}
              data-notes={marks.notes.length}
              data-releases={marks.releases.length}
            >
              <line
                x1={x}
                x2={x}
                y1={top}
                y2={bottom}
                stroke={MARK_STROKE}
                strokeWidth={1}
                strokeDasharray={hasNotes ? undefined : "3 3"}
              />
              {hasNotes && (
                <circle cx={x} cy={top} r={4} fill={MARK_STROKE} stroke={RING} strokeWidth={2} />
              )}
              {marks.releases.length > 0 && (
                <path
                  d={`M${x} ${releaseY - 5} L${x + 5} ${releaseY} L${x} ${releaseY + 5} L${x - 5} ${releaseY}Z`}
                  fill={MARK_STROKE}
                  stroke={RING}
                  strokeWidth={2}
                />
              )}
              {count > 1 && (
                <text x={x + 7} y={top} dy="0.35em" fontSize={10} className="fill-ink-subtle">
                  {count}
                </text>
              )}
            </g>
          );
        })}
    </g>
  );
}

/** A point's marks as a list: in the tooltip, the table, and the dialog. */
export function MarksList({ marks, className }: { marks: PointMarks; className?: string }) {
  return (
    <ul className={className ?? "flex flex-col gap-1"}>
      {marks.notes.map((note) => (
        <li key={note.id} className="flex min-w-0 items-baseline gap-2">
          <MarkGlyph kind="notes" size={8} />
          <span className="min-w-0 text-pretty">
            <span className="text-ink">{note.text}</span>{" "}
            <span className="text-ink-subtle">{noteMeta(note)}</span>
          </span>
        </li>
      ))}
      {marks.releases.map((release) => (
        <li key={release.release} className="flex min-w-0 items-baseline gap-2">
          <MarkGlyph kind="releases" size={8} />
          <span className="min-w-0 text-pretty">
            <span className="text-ink">Release {release.release}</span>{" "}
            <span className="text-ink-subtle">{releaseMeta(release)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Each point's marks as a list, or null for a point without any. */
function listsOf(groups: ReadonlyMap<number, PointMarks>, className?: string) {
  return (index: number): React.ReactNode => {
    const marks = groups.get(index);
    return marks === undefined ? null : (
      <MarksList marks={marks} {...(className === undefined ? {} : { className })} />
    );
  };
}

/** The dialog that adds, changes, and deletes notes: loaded on its first opening. */
const NotesDialog = React.lazy(async () => ({
  default: (await loadChunk(() => import("./chart-notes-dialog"))).NotesDialog,
}));

/** Where the dialog opened: a point of the chart, or the Add note button. */
interface Opened {
  index: number;
  /** Straight to a new note, without the point's list. */
  adding: boolean;
}

const NO_MARKS: PointMarks = { notes: [], releases: [] };

/**
 * The chart's notes and releases for the shown environment and range, with
 * their switches and the Add note button, handed to the chart (`children`).
 * The dashboard's scope provides it (dashboard-analytics-page.tsx).
 */
export function ChartMarks({
  analytics,
  children,
}: {
  analytics: Analytics;
  children: (marks: TrendMarks) => React.ReactNode;
}) {
  const { dashboard } = useAnalyticsScope();
  const projectId = dashboard?.projectId ?? "";
  const canManage = dashboard?.canManageGoals ?? false;
  const [hidden, setHidden] = React.useState(hiddenKinds);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const { chart, interval, environment } = analytics;
  const range = { from: analytics.firstDay, to: analytics.lastDay, environment };
  const notesShown = !hidden.has("notes");
  const releasesShown = !hidden.has("releases");
  const notes = useQuery({ ...annotationsQuery(projectId, range), enabled: notesShown });
  const releases = useQuery({ ...releaseMarksQuery(projectId, range), enabled: releasesShown });
  const groups = groupMarks(
    chart,
    notesShown ? (notes.data ?? []) : [],
    releasesShown ? (releases.data ?? []) : [],
  );

  const toggle = (kind: MarkKind, shown: boolean) => {
    const next = new Set(hidden);
    if (shown) next.delete(kind);
    else next.add(kind);
    rememberHidden(next);
    setHidden(next);
  };

  const point = opened === null ? undefined : chart[opened.index];
  const controls = (
    <>
      <Toggle
        size="sm"
        variant="outline"
        pressed={notesShown}
        onPressedChange={(pressed) => toggle("notes", pressed)}
        aria-label="Show notes"
      >
        <MarkGlyph kind="notes" />
        Notes
      </Toggle>
      <Toggle
        size="sm"
        variant="outline"
        pressed={releasesShown}
        onPressedChange={(pressed) => toggle("releases", pressed)}
        aria-label="Show releases"
      >
        <MarkGlyph kind="releases" />
        Releases
      </Toggle>
      {canManage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpened({ index: chart.length - 1, adding: true })}
        >
          <PlusIcon aria-hidden="true" />
          Add note
        </Button>
      )}
      {opened !== null && point !== undefined && (
        <React.Suspense fallback={null}>
          <NotesDialog
            projectId={projectId}
            environment={environment}
            point={
              // Add note starts on the range's last day, not on a week's or month's first.
              opened.adding
                ? { label: whenText(analytics.lastDay, null), day: analytics.lastDay, time: null }
                : {
                    label:
                      interval === "hour" || interval === "day" || point.start === point.end
                        ? whenText(
                            point.start.slice(0, 10),
                            interval === "hour" ? point.start.slice(11, 16) : null,
                          )
                        : `${formatDay(point.start)} to ${formatDay(point.end)}`,
                    day: point.start.slice(0, 10),
                    time: interval === "hour" ? point.start.slice(11, 16) : null,
                  }
            }
            marks={groups.get(opened.index) ?? NO_MARKS}
            adding={opened.adding}
            onClose={() => setOpened(null)}
          />
        </React.Suspense>
      )}
    </>
  );

  const chartMarks: DayChartMarks = {
    layer: <MarksLayer groups={groups} />,
    text: (index) => marksText(groups.get(index)),
    tooltip: listsOf(groups, "mt-1.5 flex flex-col gap-1 border-t pt-1.5"),
    ...(canManage ? { onSelect: (index: number) => setOpened({ index, adding: false }) } : {}),
  };

  return children({
    controls,
    chart: chartMarks,
    column:
      groups.size === 0
        ? null
        : {
            heading: "Notes and releases",
            cell: listsOf(groups),
          },
  });
}
