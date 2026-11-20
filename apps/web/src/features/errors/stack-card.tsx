import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WhenAllowed } from "@/components/when-allowed";
import type {
  ErrorSource,
  OriginalPosition,
  ResolvedFrame,
  SourceContext,
  StackSourceMaps,
} from "@/lib/errors-api";

/** Unmapped frames in a row, from this many, fold behind a button: often a library's tail. */
const FOLD_FROM = 3;

/** "https://example.com/assets/app.js:1:2345", with whichever position is known. */
function minifiedLocation(frame: ResolvedFrame): string {
  return [frame.file, frame.line, frame.column].filter((part) => part !== null).join(":");
}

/** The frame as the browser reported it: its function, if any, and where. */
function MinifiedFrame({ frame, className }: { frame: ResolvedFrame; className: string }) {
  return (
    <p className={`font-mono break-all ${className}`}>
      {frame.function !== "" && <span>{frame.function} </span>}
      <span>{minifiedLocation(frame)}</span>
    </p>
  );
}

/**
 * The original source around a mapped frame's line, numbered. The frame's
 * line is marked three ways: a marker, a background, and words for screen readers.
 */
function ContextLines({
  original,
  context,
}: {
  original: OriginalPosition;
  context: SourceContext;
}) {
  const lastLine = context.firstLine + context.lines.length - 1;
  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">
        Lines {context.firstLine} to {lastLine} of {original.source}
      </figcaption>
      <pre className="overflow-x-auto rounded-lg bg-canvas py-2 font-mono text-code text-ink-muted ring-1 ring-border">
        <code className="grid min-w-max">
          {context.lines.map((text, i) => {
            const number = context.firstLine + i;
            const here = number === original.line;
            const cells = (
              <>
                <span
                  aria-hidden="true"
                  className="flex w-5 items-center justify-center text-warning select-none"
                >
                  {here && <PlayIcon className="size-2.5 fill-current" />}
                </span>
                <span className="w-10 pr-3 text-right text-ink-subtle tabular-nums select-none">
                  {number}
                </span>
                <span className="pr-4 whitespace-pre">{text}</span>
              </>
            );
            return here ? (
              <mark key={number} className="flex bg-warning/15 text-ink">
                <span className="sr-only">The error happened on this line: </span>
                {cells}
              </mark>
            ) : (
              <span key={number} className="flex">
                {cells}
              </span>
            );
          })}
        </code>
      </pre>
    </figure>
  );
}

/**
 * A frame a source map covers: the original file and line first, the
 * minified one after. The map's name at that position is not shown: it is
 * often not the enclosing function's, and the line itself is shown.
 */
function MappedFrame({ frame, original }: { frame: ResolvedFrame; original: OriginalPosition }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="font-mono text-sm font-semibold break-all text-ink">
        {original.source}:{original.line}:{original.column}
      </p>
      {original.context !== null && original.context.lines.length > 0 && (
        <ContextLines original={original} context={original.context} />
      )}
      <div className="flex gap-1 text-xs text-ink-subtle">
        <span className="shrink-0">Minified:</span>
        <MinifiedFrame frame={frame} className="min-w-0" />
      </div>
    </div>
  );
}

/** Several unmapped frames in a row, folded until asked for. */
function FoldedFrames({ frames }: { frames: ResolvedFrame[] }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  return (
    <li className="flex flex-col gap-2">
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open
            ? `Hide ${frames.length} frames without a source map`
            : `Show ${frames.length} more frames, without a source map`}
        </Button>
      </div>
      <ol id={listId} hidden={!open} className="flex flex-col gap-1 pl-3">
        {frames.map((frame, i) => (
          // A stack can repeat a frame: its place in the stack tells them apart.
          <li key={i}>
            <MinifiedFrame frame={frame} className="text-sm text-ink-muted" />
          </li>
        ))}
      </ol>
    </li>
  );
}

type Run =
  | { kind: "mapped"; frame: ResolvedFrame; original: OriginalPosition }
  | { kind: "unmapped"; frames: ResolvedFrame[] };

/** The frames in order, with unmapped ones in a row grouped together. */
function runsOf(frames: ResolvedFrame[]): Run[] {
  const runs: Run[] = [];
  for (const frame of frames) {
    const last = runs.at(-1);
    if (frame.original !== null) {
      runs.push({ kind: "mapped", frame, original: frame.original });
    } else if (last?.kind === "unmapped") {
      last.frames.push(frame);
    } else {
      runs.push({ kind: "unmapped", frames: [frame] });
    }
  }
  return runs;
}

/** The stack's frames, top first, the mapped ones with their original source. */
function FrameList({ frames }: { frames: ResolvedFrame[] }) {
  return (
    <ol aria-label="Frames, top first" className="flex flex-col gap-4">
      {runsOf(frames).map((run, i) => {
        if (run.kind === "mapped") {
          return (
            <li key={i}>
              <MappedFrame frame={run.frame} original={run.original} />
            </li>
          );
        }
        if (run.frames.length >= FOLD_FROM) {
          return <FoldedFrames key={i} frames={run.frames} />;
        }
        return run.frames.map((frame, j) => (
          <li key={`${i}-${j}`}>
            <MinifiedFrame frame={frame} className="text-sm text-ink-muted" />
          </li>
        ));
      })}
    </ol>
  );
}

const code = (text: string) => <code className="font-mono">{text}</code>;

/** One line on how the stack was mapped, or why it was not. */
function SourceMapNote({
  projectId,
  sourceMaps,
}: {
  projectId: string;
  sourceMaps: StackSourceMaps;
}) {
  const release = sourceMaps.release ?? "";
  switch (sourceMaps.status) {
    case "applied":
      return (
        <p className="text-sm text-ink-muted">
          Mapped to your original files with the source maps of release {code(release)}.
        </p>
      );
    case "no_release":
      return (
        <p className="text-sm text-ink-muted">
          No release was sent, so source maps are unavailable. Set {code('data-release="1.4.2"')} on
          the tracker&apos;s script tag.
        </p>
      );
    case "no_files":
      return (
        <p className="text-sm text-ink-muted">
          No stack frame refers to a file that can have a source map. Examples include inline
          scripts and browser code.
        </p>
      );
    case "no_maps":
    case "not_mapped":
      return (
        <div className="flex flex-col gap-2 text-sm text-ink-muted">
          <p>
            {sourceMaps.status === "no_maps" ? (
              <>
                No source maps of release {code(release)} cover the files of this stack. Upload maps
                for these files to see your original code:
              </>
            ) : (
              <>
                Release {code(release)} has source maps for these files, but none covers where the
                error happened: they may be from another build of the release. Upload this
                build&apos;s maps again:
              </>
            )}
          </p>
          <ul className="flex flex-col gap-1 pl-4">
            {sourceMaps.paths.map((path) => (
              <li key={path} className="list-disc font-mono break-all">
                {path}
              </li>
            ))}
          </ul>
          <WhenAllowed permission="projects">
            <p>
              <Link
                to="/projects/$projectId/settings"
                params={{ projectId }}
                search={{ tab: "source-maps" }}
                className="text-link hover:underline"
              >
                Source maps settings
              </Link>
            </p>
          </WhenAllowed>
        </div>
      );
    case "not_configured":
      return (
        <p className="text-sm text-ink-muted">
          Source maps are disabled on this instance because it has no object store for them. Its
          operator can enable them by setting {code("OBJECT_STORE_URL")}.
        </p>
      );
  }
  // What is left: "unavailable".
  return (
    <p className="text-sm text-ink-muted">
      The source maps could not be read. The stack appears as the browser reported it. Reload the
      page to try again.
    </p>
  );
}

/** The raw stack, scrollable both ways. */
function RawStack({ stack, id, hidden }: { stack: string; id?: string; hidden?: boolean }) {
  return (
    <pre
      id={id}
      hidden={hidden}
      className="max-h-96 overflow-auto rounded-lg bg-canvas p-4 font-mono text-code text-ink-muted ring-1 ring-border"
    >
      {stack}
    </pre>
  );
}

/** The raw stack behind a button, under the mapped frames. */
function RawStackToggle({ stack }: { stack: string }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open
            ? "Hide the stack as the browser reported it"
            : "Show the stack as the browser reported it"}
        </Button>
      </div>
      <RawStack stack={stack} id={id} hidden={!open} />
    </div>
  );
}

/**
 * The latest occurrence's stack: a browser's mapped to the original source
 * where the release's source maps allow (docs/errors.md, "Source maps"),
 * else as the browser reported it, with a note on why; a server's as it was
 * sent.
 */
export function StackCard({
  projectId,
  source,
  stack,
  frames,
  sourceMaps,
  className,
}: {
  projectId: string;
  source: ErrorSource;
  stack: string | null;
  frames: ResolvedFrame[] | null;
  sourceMaps: StackSourceMaps | null;
  /** Such as a flat section's look inside a workbench. */
  className?: string;
}) {
  const mapped = frames?.some((frame) => frame.original !== null) === true ? frames : null;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>
          <h3>Stack trace</h3>
        </CardTitle>
        <CardDescription>Latest occurrence, top frame first.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {stack === null ? (
          <p className="text-sm text-ink-subtle">
            The {source} gave no stack trace for this error.
          </p>
        ) : source === "server" ? (
          <>
            <p className="text-sm text-ink-muted">
              Server stacks are shown as received. Source maps apply only to browser code.
            </p>
            <RawStack stack={stack} />
          </>
        ) : (
          <>
            {sourceMaps !== null && <SourceMapNote projectId={projectId} sourceMaps={sourceMaps} />}
            {mapped !== null ? (
              <>
                <FrameList frames={mapped} />
                <RawStackToggle stack={stack} />
              </>
            ) : (
              <RawStack stack={stack} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
