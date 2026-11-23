import { useQuery } from "@tanstack/react-query";
import { PlayIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Occurrence } from "@/lib/errors-api";
import { playerUrl, playerUrlAt, replayTimelineQuery } from "@/lib/replays-api";

import { ReplayViewer } from "../replays/replay-viewer";
import { formatMoment } from "../users/format";

export const ARRIVING_HINT = "The page sends its replay about 10 seconds after the error.";

/** Use the recording clock for the error marker: recording start plus error offset. Fall back to occurrence time while the timeline loads or is missing. */
function OccurrenceReplayViewer({
  projectId,
  replayId,
  occurredAt,
  title,
}: {
  projectId: string;
  replayId: string;
  occurredAt: string;
  title: string;
}) {
  const timeline = useQuery(replayTimelineQuery(projectId, replayId));
  const offset = timeline.data?.errorOffsetMs ?? null;
  const playerSrc =
    timeline.data === undefined || offset === null
      ? playerUrl(projectId, replayId, occurredAt)
      : playerUrlAt(projectId, replayId, timeline.data.recordingStartMs + offset);
  return (
    <ReplayViewer projectId={projectId} replayId={replayId} playerSrc={playerSrc} title={title} />
  );
}

function ReplayDialog({
  projectId,
  replayId,
  occurrence,
  timeZone,
}: {
  projectId: string;
  replayId: string;
  occurrence: Occurrence;
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  const when = formatMoment(occurrence.occurredAt, timeZone);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        aria-label={`Play replay of the error at ${when}`}
        onClick={() => setOpen(true)}
      >
        <PlayIcon aria-hidden="true" />
        Play replay
      </Button>
      <DialogContent className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-3 sm:max-w-none lg:h-[90dvh] lg:w-[90vw]">
        <DialogHeader className="pr-10">
          <DialogTitle>Session replay</DialogTitle>
          <DialogDescription>
            Around the error at {when}, in {timeZone}
            {occurrence.path === "" ? "" : `, on ${occurrence.path}`}.
          </DialogDescription>
        </DialogHeader>
        <OccurrenceReplayViewer
          projectId={projectId}
          replayId={replayId}
          occurredAt={occurrence.occurredAt}
          title={`Session replay around the error at ${when}`}
        />
      </DialogContent>
    </Dialog>
  );
}

export function OccurrenceReplayCell({
  projectId,
  occurrence,
  timeZone,
}: {
  projectId: string;
  occurrence: Occurrence;
  timeZone: string;
}) {
  const { replay } = occurrence;
  if (replay?.status === "ready") {
    return (
      <ReplayDialog
        projectId={projectId}
        replayId={replay.id}
        occurrence={occurrence}
        timeZone={timeZone}
      />
    );
  }
  if (replay?.status === "pending") {
    return (
      <span className="text-ink-subtle" title={ARRIVING_HINT}>
        Arriving…<span className="sr-only"> {ARRIVING_HINT}</span>
      </span>
    );
  }
  return <span className="text-ink-subtle">No replay</span>;
}
