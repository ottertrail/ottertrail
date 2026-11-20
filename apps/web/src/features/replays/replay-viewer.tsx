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

/**
 * What the visitor did, each with its time: a button moves the player there.
 * Every text here is derived from the masked recording (docs/session-replay.md):
 * paths and tags, never what was typed or shown.
 */
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

/**
 * A replay: the player beside its timeline. The player is a page of the
 * API's (docs/session-replay.md, "Playback"), served with its own Content
 * Security Policy, so this frame needs no sandbox of its own and loosens
 * nothing: nothing from the recording comes into the dashboard's page.
 * The timeline moves the player with a message to its frame, and hears
 * where it is from the same frame: both on this origin, and checked
 * (lib/replay-messages.ts). The timeline sits beside the player where the
 * nearest `@container` is 56rem wide or more, and under it otherwise (the
 * pane beside the replays list), where the player scales the recorded
 * page down to its width.
 */
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
  /**
   * The frame opens in the theme of the moment its replay was chosen, for
   * its first paint; later changes go to it as a message, so switching the
   * theme does not load the replay again.
   */
  const [opened, setOpened] = React.useState({ playerSrc, theme });
  if (opened.playerSrc !== playerSrc) setOpened({ playerSrc, theme });
  const frameSrc = playerUrlInTheme(opened.playerSrc, opened.theme);
  const timeline = useQuery(replayTimelineQuery(projectId, replayId));
  const [currentMs, setCurrentMs] = React.useState<number | null>(null);
  /**
   * The last moment asked for, until the player has surely heard it: one
   * asked for before its script listened would be lost, so it is sent again
   * when the frame (re)loads, and kept until the loaded player speaks.
   */
  const asked = React.useRef<number | null>(null);
  /** The frame address that last loaded: a new one has not loaded yet. */
  const loadedSrc = React.useRef<string | null>(null);

  /** Only to the player's frame, and only on this origin. */
  const post = (offsetMs: number) =>
    frameRef.current?.contentWindow?.postMessage(seekMessage(offsetMs), window.location.origin);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const time = readTimeMessage(event, frameRef.current?.contentWindow, window.location.origin);
      if (time === null) return;
      setCurrentMs(time.offsetMs);
      // The loaded player listens: what was asked has reached it.
      const src = frameRef.current?.getAttribute("src");
      if (loadedSrc.current !== null && loadedSrc.current === src) asked.current = null;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Beside the replays list, a pane that CSS hides (the window narrowed) pauses the player.
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
      {/* No sandbox: the player must run its script and read the replay as the
          signed-in user, and the page's own Content Security Policy keeps the
          recording from running anything (its frame inside is rrweb's sandbox). */}
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
