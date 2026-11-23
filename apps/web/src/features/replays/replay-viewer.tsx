import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkbenchPane } from "@/components/workbench-pane";
import {
  pauseMessage,
  playerUrlInTheme,
  readTimeMessage,
  seekMessage,
  themeMessage,
} from "@/lib/replay-messages";
import { type ReplayTimeline, replayTimelineQuery } from "@/lib/replays-api";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { currentIndex, describeItem, formatClock, timelineItems } from "./format";

/** Use only masked recording data (docs/session-replay.md), never typed or displayed content. */
function TimelineList({
  query,
  currentMs,
  onSeek,
}: {
  query: UseQueryResult<ReplayTimeline>;
  currentMs: number | null;
  onSeek: (offsetMs: number) => void;
}) {
  const [withScrolls, setWithScrolls] = React.useState(false);
  const id = React.useId();
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the timeline">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>The timeline could not load</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const answer = query.data;
  const scrolls = answer.timeline.items.filter((item) => item.kind === "scroll").length;
  const items = timelineItems(answer, withScrolls);
  const current = currentIndex(items, currentMs);
  const firstPage = items.findIndex((item) => item.kind === "page");
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {scrolls > 0 && (
        <div className="flex items-center gap-2 px-1">
          <Checkbox
            id={`${id}-scrolls`}
            checked={withScrolls}
            onCheckedChange={(checked) => setWithScrolls(checked)}
          />
          <Label htmlFor={`${id}-scrolls`}>Show scrolls ({scrolls.toLocaleString("en-US")})</Label>
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-1 text-sm text-ink-subtle">
          The recording has no page changes, clicks, or typing to display in the timeline.
        </p>
      ) : (
        <ol aria-label="Timeline of the replay" className="flex min-h-0 flex-col overflow-y-auto">
          {items.map((item, index) => {
            const text = describeItem(item, index === firstPage);
            return (
              <li key={`${item.kind}-${item.at}-${String(index)}`}>
                <button
                  type="button"
                  onClick={() => onSeek(item.at)}
                  aria-current={index === current ? "true" : undefined}
                  aria-label={`${formatClock(item.at)}: ${text}. Play from here`}
                  className={cn(
                    "flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    index === current && "bg-muted",
                    item.kind === "error" && "text-status-critical",
                  )}
                >
                  <span className="w-10 shrink-0 font-mono text-xs text-ink-subtle tabular-nums">
                    {formatClock(item.at)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 break-words",
                      item.kind === "page" && "font-mono text-xs",
                      item.kind === "error" && "font-medium",
                    )}
                  >
                    {text}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {answer.timeline.truncated !== false && (
        <p className="px-1 text-xs text-ink-subtle">
          {answer.timeline.truncated === "scrolls"
            ? "Some earlier scrolls are omitted. A timeline keeps 500 moments."
            : "All scrolls and the earliest moments are omitted. A timeline keeps the latest 500 moments."}
        </p>
      )}
    </div>
  );
}

/** The API player page has its own CSP (docs/session-replay.md, "Playback"). Frame messages must match this origin and frame (lib/replay-messages.ts). */
export function ReplayViewer({
  projectId,
  replayId,
  playerSrc,
  title,
  className,
}: {
  projectId: string;
  replayId: string;
  playerSrc: string;
  title: string;
  className?: string;
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const { theme } = useTheme();
  /** Capture the initial theme in the URL; send later changes as messages to avoid reloading the replay. */
  const [opened, setOpened] = React.useState({ playerSrc, theme });
  if (opened.playerSrc !== playerSrc) setOpened({ playerSrc, theme });
  const frameSrc = playerUrlInTheme(opened.playerSrc, opened.theme);
  const timeline = useQuery(replayTimelineQuery(projectId, replayId));
  const [currentMs, setCurrentMs] = React.useState<number | null>(null);
  /** Resend pending seeks after frame load until the player acknowledges them. */
  const asked = React.useRef<number | null>(null);
  const loadedSrc = React.useRef<string | null>(null);

  const post = (offsetMs: number) =>
    frameRef.current?.contentWindow?.postMessage(seekMessage(offsetMs), window.location.origin);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const time = readTimeMessage(event, frameRef.current?.contentWindow, window.location.origin);
      if (time === null) return;
      setCurrentMs(time.offsetMs);
      const src = frameRef.current?.getAttribute("src");
      if (loadedSrc.current !== null && loadedSrc.current === src) asked.current = null;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Pause playback when CSS hides the workbench pane.
  const { shown } = useWorkbenchPane();
  React.useEffect(() => {
    if (!shown) {
      frameRef.current?.contentWindow?.postMessage(pauseMessage(), window.location.origin);
    }
  }, [shown]);

  const seek = (offsetMs: number) => {
    asked.current = offsetMs;
    post(offsetMs);
    setCurrentMs(offsetMs);
  };

  const postTheme = React.useCallback(
    (value: Theme) =>
      frameRef.current?.contentWindow?.postMessage(themeMessage(value), window.location.origin),
    [],
  );
  React.useEffect(() => postTheme(theme), [theme, postTheme]);

  const onLoad = () => {
    loadedSrc.current = frameRef.current?.getAttribute("src") ?? null;
    if (asked.current !== null) post(asked.current);
    // The theme may have changed while the page loaded.
    postTheme(theme);
  };

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,12rem)] gap-3 @4xl:grid-cols-[minmax(0,1fr)_18rem] @4xl:grid-rows-1",
        className,
      )}
    >
      {/* The player needs scripts and authenticated replay access. Its CSP and rrweb's inner sandbox isolate the recording. */}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
      <iframe
        ref={frameRef}
        src={frameSrc}
        onLoad={onLoad}
        title={title}
        referrerPolicy="no-referrer"
        className="h-full min-h-64 w-full rounded-lg border-0 bg-canvas ring-1 ring-border"
      />
      <aside aria-label="Timeline" className="flex min-h-0 flex-col gap-2">
        <h3 className="px-1 text-sm font-medium text-ink">What the visitor did</h3>
        <TimelineList query={timeline} currentMs={currentMs} onSeek={seek} />
      </aside>
    </div>
  );
}
