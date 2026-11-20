import { cn } from "cn";

import type { EventState } from "@/lib/project-status";
import { initialOf, projectTile } from "@/lib/project-tile";

/**
 * A project's initial on its own color, from its ID (lib/project-tile.ts).
 * Decoration: the project's name is always beside it, or in its tooltip.
 */
export function ProjectTile({
  projectId,
  name,
  className,
}: {
  projectId: string;
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="project-tile"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] leading-none font-semibold",
        projectTile(projectId).className,
        className,
      )}
    >
      {initialOf(name)}
    </span>
  );
}

const DOT = {
  receiving: "bg-status-good",
  quiet: "bg-ink-tertiary",
  none: "ring-1 ring-ink-tertiary ring-inset",
} as const;

/**
 * Whether a project's events arrive, as a dot: green for an event in the
 * last day, grey for an older one, a grey ring for none yet. Color is
 * never the only cue: the item's accessible name and tooltip say it in
 * words, so the dot is hidden from screen readers.
 */
export function EventDot({ state, className }: { state: EventState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="event-dot"
      data-state={state}
      className={cn("size-2 shrink-0 rounded-full", DOT[state], className)}
    />
  );
}
