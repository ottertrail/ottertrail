import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, FilmIcon, OctagonAlertIcon } from "lucide-react";
import type * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { Missing } from "@/components/missing";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { WhenAllowed } from "@/components/when-allowed";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { playerUrlAt, replayTimelineQuery } from "@/lib/replays-api";
import { cn } from "@/lib/utils";

import { formatMoment } from "../users/format";
import { clientText, formatReplayDuration, pagesText } from "./format";
import { ReplayErrorLink } from "./replay-error-link";
import { ReplayViewer } from "./replay-viewer";

/**
 * One replay's detail with its loading, missing, and failed states: what it
 * shows (its error, user, pages, browser), then the player beside its
 * timeline (ReplayViewer), side by side where its container has room and
 * one above the other where it has not. On the replay's own page, and in
 * the Replays workbench beside the list, where `actions` links to the page
 * and a missing replay's link clears the selection instead.
 */
export function ReplayView({
  projectId,
  replayId,
  actions,
  inWorkbench = false,
}: {
  projectId: string;
  replayId: string;
  /** Beside the replay's title, such as a link to its own page. */
  actions?: React.ReactNode;
  /** Beside the replays list: the player takes a fixed height in the scrolling pane. */
  inWorkbench?: boolean;
}) {
  const query = useQuery(replayTimelineQuery(projectId, replayId));

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FilmIcon />
            </EmptyMedia>
            <EmptyTitle>No such replay</EmptyTitle>
            <EmptyDescription>
              The project has no replay with this ID. It may have expired after 30 days or been
              deleted.
            </EmptyDescription>
          </EmptyHeader>
          {inWorkbench && (
            <EmptyContent>
              <ButtonLink
                variant="outline"
                to="/projects/$projectId/replays"
                params={{ projectId }}
                search={(previous) => ({ ...previous, replay: undefined })}
              >
                All replays
              </ButtonLink>
            </EmptyContent>
          )}
        </Empty>
      );
    }
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>The replay could not load</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  const { replay, timeZone, errorOffsetMs, recordingStartMs } = query.data;
  const when = formatMoment(replay.startedAt, timeZone);
  const client = clientText(replay);
  return (
    <div
      className={cn("@container flex min-h-0 flex-col gap-4", inWorkbench ? undefined : "flex-1")}
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h2 className="text-xl font-semibold text-ink">
            Replay at <time dateTime={replay.startedAt}>{when}</time>
          </h2>
          {actions}
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div className="max-w-md min-w-0">
            <dt className="text-ink-subtle">Error</dt>
            <dd>
              <ReplayErrorLink projectId={projectId} replay={replay} timeZone={timeZone} />
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Length</dt>
            <dd className="flex items-center gap-2 tabular-nums">
              {formatReplayDuration(replay.durationMs)}
              {replay.cut && <StatusBadge tone="neutral">Cut</StatusBadge>}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-subtle">User</dt>
            <dd>
              {replay.userId === null ? (
                "Anonymous"
              ) : (
                <WhenAllowed
                  area="users"
                  fallback={<span className="font-mono text-xs break-all">{replay.userId}</span>}
                >
                  <Link
                    to="/projects/$projectId/users/$userId"
                    params={{ projectId, userId: replay.userId }}
                    search={
                      replay.environment === null || replay.environment === DEFAULT_ENVIRONMENT
                        ? {}
                        : { env: replay.environment }
                    }
                    className="font-mono text-xs break-all text-link hover:underline"
                  >
                    {replay.userId}
                  </Link>
                </WhenAllowed>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle">Environment</dt>
            <dd>{replay.environment ?? "Not known"}</dd>
          </div>
          {client !== "" && (
            <div>
              <dt className="text-ink-subtle">Browser</dt>
              <dd>{client}</dd>
            </div>
          )}
          <div className="max-w-xl min-w-0">
            <dt className="text-ink-subtle">Pages</dt>
            <dd className="font-mono text-xs break-all">
              {replay.pages.length === 0 ? (
                <Missing label="None" className="font-sans" />
              ) : (
                pagesText(replay.pages)
              )}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-ink-subtle">
          Times in {timeZone}.
          {replay.cut &&
            " The recording is incomplete. It reached its size limit, or the visitor left before the entire recording was sent."}
        </p>
      </div>
      <ReplayViewer
        projectId={projectId}
        replayId={replay.id}
        playerSrc={playerUrlAt(
          projectId,
          replay.id,
          errorOffsetMs === null ? null : recordingStartMs + errorOffsetMs,
        )}
        title={`Session replay at ${when}`}
        className={inWorkbench ? "h-[38rem] flex-none" : undefined}
      />
    </div>
  );
}

/** One replay on its own page, for deep links and narrow screens. */
export function ReplayPage({ projectId, replayId }: { projectId: string; replayId: string }) {
  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[40rem] flex-col gap-4 px-gutter py-5">
      <Link
        to="/projects/$projectId/replays"
        params={{ projectId }}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All replays
      </Link>
      <ReplayView projectId={projectId} replayId={replayId} />
    </div>
  );
}
