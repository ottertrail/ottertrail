import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { projectQuery } from "@/lib/projects-api";
import {
  deleteReplays,
  type ReplayMode,
  type ReplayOverview,
  replaysKey,
  replaysQuery,
  setReplayMode,
} from "@/lib/replays-api";
import { formatBytes } from "@/lib/source-maps-api";

/** The attribute that makes the tracker record, on the site's script tag. */
export const REPLAY_ATTRIBUTE = 'data-replay="errors"';

const code = (text: string) => <code className="font-mono">{text}</code>;

const MODES: { value: ReplayMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Nothing is recorded. Any recordings sent are rejected." },
  {
    value: "errors",
    label: "Around errors",
    hint: "Each page keeps its last 30 to 60 seconds in memory. It sends the recording only when an error occurs.",
  },
];

/** Off or around errors, saved as soon as it is chosen. */
function ModeChoice({ projectId, mode }: { projectId: string; mode: ReplayMode }) {
  const queryClient = useQueryClient();
  const name = React.useId();
  const save = useMutation({
    mutationFn: (next: ReplayMode) => setReplayMode(projectId, next),
    onSuccess: (project) => {
      queryClient.setQueryData(projectQuery(projectId).queryKey, project);
      queryClient.setQueryData<ReplayOverview>(replaysKey(projectId), (overview) =>
        overview === undefined ? undefined : { ...overview, mode: project.replayMode },
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    },
  });
  // While saving, the choice made; after a failure, what is saved.
  const shown = save.isPending ? save.variables : mode;
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2" disabled={save.isPending}>
        <legend className="mb-2 text-sm font-medium text-ink">Record replays</legend>
        {MODES.map((choice) => (
          <div key={choice.value} className="flex items-start gap-2.5 text-sm">
            <input
              type="radio"
              id={`${name}-${choice.value}`}
              name={name}
              value={choice.value}
              checked={shown === choice.value}
              onChange={() => save.mutate(choice.value)}
              aria-describedby={`${name}-${choice.value}-hint`}
              className="mt-0.5 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            <div className="flex flex-col">
              <label htmlFor={`${name}-${choice.value}`} className="text-ink">
                {choice.label}
              </label>
              <span id={`${name}-${choice.value}-hint`} className="text-ink-subtle">
                {choice.hint}
              </span>
            </div>
          </div>
        ))}
      </fieldset>
      <output aria-live="polite" className="text-sm text-ink-muted">
        {save.isPending ? (
          <span className="inline-flex items-center gap-1.5">
            <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
            Saving…
          </span>
        ) : save.isSuccess ? (
          "Saved."
        ) : (
          ""
        )}
      </output>
      {save.error !== null && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>The change was not saved: {save.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** What a site adds to its tag, and what stays private. */
function SiteHelp() {
  return (
    <div className="flex flex-col gap-3 border-t pt-4 text-sm text-ink-muted">
      <h4 className="text-sm font-medium text-ink">On your site</h4>
      <p>
        Enable this setting. Add this attribute to the tracker's script tag under Install above.
        Both are required. If your site requests consent, add the attribute only after the visitor
        agrees to recording.
      </p>
      <CopyableCode text={REPLAY_ATTRIBUTE} copyLabel="Copy the replay attribute" />
      <h4 className="pt-1 text-sm font-medium text-ink">Private by default</h4>
      <p>
        The visitor's browser masks page text, typed text, images, and media before sending the
        recording. Masked content never reaches Ottertrail. Nobody can recover it later. Your site's
        HTML can allow more content:
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>
          {code('data-replay-text="show"')} on the script tag shows the page&apos;s text. Typed
          values stay masked.
        </li>
        <li>
          {code('data-replay-media="show"')} on the script tag shows images, video, and audio.
        </li>
        <li>
          {code("data-ottertrail-mask")} on an element masks its text, even when text is shown.
        </li>
        <li>{code("data-ottertrail-block")} on an element records only a box of its size.</li>
        <li>
          {code("data-ottertrail-unmask")} on an element shows its text, even when text is masked.
        </li>
      </ul>
    </div>
  );
}

/** Asks before deleting every replay of the project; its errors stay. */
function DeleteAllDialog({
  projectId,
  count,
  returnFocus,
}: {
  projectId: string;
  count: number;
  /** Where focus goes once deleted: this button leaves with the replays. */
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const deleted = React.useRef(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteReplays(projectId),
    onSuccess: () => {
      deleted.current = true;
      setOpen(false);
      // None left at once, even should fetching the overview again fail.
      queryClient.setQueryData<ReplayOverview>(replaysKey(projectId), (overview) =>
        overview === undefined
          ? undefined
          : {
              ...overview,
              replays: { count: 0, bytes: 0 },
              ...(overview.instance === undefined
                ? {}
                : {
                    instance: {
                      ...overview.instance,
                      storedBytes: Math.max(
                        0,
                        overview.instance.storedBytes - overview.replays.bytes,
                      ),
                    },
                  }),
            },
      );
      void queryClient.invalidateQueries({ queryKey: replaysKey(projectId) });
      // Error pages show which occurrences still have a replay.
      void queryClient.invalidateQueries({ queryKey: ["error", projectId] });
    },
  });
  const replays =
    count === 1
      ? "The project's 1 replay is"
      : `All ${count.toLocaleString("en")} replays of the project are`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
    >
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Trash2Icon aria-hidden="true" />
          Delete all replays
        </Button>
      </div>
      <DialogContent
        className="sm:max-w-md"
        finalFocus={() => (deleted.current && returnFocus.current) || true}
      >
        <DialogHeader>
          <DialogTitle>Delete all replays?</DialogTitle>
          <DialogDescription>
            {replays} permanently deleted. This cannot be undone. The errors are retained without
            their replays.
          </DialogDescription>
        </DialogHeader>
        {remove.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Delete all replays
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Usage({
  projectId,
  overview,
  returnFocus,
}: {
  projectId: string;
  overview: ReplayOverview;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
}) {
  const { count, bytes } = overview.replays;
  const { instance } = overview;
  return (
    <div className="flex flex-col gap-3 border-t pt-4 text-sm text-ink-muted">
      <h4 className="text-sm font-medium text-ink">Stored</h4>
      <p>
        <span className="text-ink tabular-nums">
          {count === 0
            ? "No replays"
            : `${count.toLocaleString("en")} ${count === 1 ? "replay" : "replays"}, ${formatBytes(bytes)}`}
        </span>{" "}
        in this project.
        {instance !== undefined && (
          <>
            {" "}
            <span className="text-ink tabular-nums">
              {formatBytes(instance.storedBytes)} of {formatBytes(instance.limitBytes)}
            </span>{" "}
            used, by all projects together.
          </>
        )}
      </p>
      <p>Replays are kept for 30 days, then deleted.</p>
      {count > 0 && (
        <DeleteAllDialog projectId={projectId} count={count} returnFocus={returnFocus} />
      )}
    </div>
  );
}

/**
 * The project's session replays (docs/session-replay.md): off or around
 * errors, what the site adds to its tag, what stays private, and what is
 * stored. On an install without an object store, only that they are off.
 */
export function ReplaysCard({ projectId }: { projectId: string }) {
  const query = useQuery(replaysQuery(projectId));
  // Where focus goes when the delete dialog closes: its button is gone.
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <Card id="session-replay" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h3 ref={headingRef} tabIndex={-1} className="outline-none">
            Session replay
          </h3>
        </CardTitle>
        <CardDescription>
          Record what a visitor saw and did in the minute before an error. Play the replay from the
          error's page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>Session replay settings could not load</AlertTitle>
            <AlertDescription>{query.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : !query.data.configured ? (
          <p className="text-sm text-ink-muted">
            Session replay is disabled on this instance because it has no object store for
            recordings. Its operator can enable it by setting {code("OBJECT_STORE_URL")}.
          </p>
        ) : (
          <>
            <ModeChoice projectId={projectId} mode={query.data.mode} />
            <SiteHelp />
            <Usage projectId={projectId} overview={query.data} returnFocus={headingRef} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
