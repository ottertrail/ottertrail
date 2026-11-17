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
import { playerUrl } from "@/lib/replays-api";

import { formatMoment } from "../users/format";

/** Why a recent occurrence has no replay yet. */
export const ARRIVING_HINT = "The page sends its replay about 10 seconds after the error.";

/**
 * The replay of one occurrence, in a dialog that takes most of the screen.
 * The player is a page of the API's (docs/session-replay.md, "Playback"),
 * served with its own Content Security Policy, so this frame needs no
 * sandbox of its own and loosens nothing: nothing from the recording comes
 * into the dashboard's page.
 */
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
        {/* No sandbox: the player must run its script and read the replay as the
            signed-in user, and the page's own Content Security Policy keeps the
            recording from running anything (its frame inside is rrweb's sandbox). */}
        {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
        <iframe
          src={playerUrl(projectId, replayId, occurrence.occurredAt)}
          title={`Session replay around the error at ${when}`}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 rounded-lg border-0 bg-canvas ring-1 ring-border"
        />
      </DialogContent>
    </Dialog>
  );
}

/** The Replay column of the latest occurrences: play it, it is on its way, or none. */
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
  return (
    <>
      <span aria-hidden="true" className="text-ink-subtle">
        —
      </span>
      <span className="sr-only">No replay</span>
    </>
  );
}
