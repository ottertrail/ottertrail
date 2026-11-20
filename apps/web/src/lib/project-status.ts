import { timeAgo } from "@/features/projects/format";

/** A day: a project whose last event is newer counts as receiving events. */
const RECEIVING_MS = 86_400_000;

export type EventState = "receiving" | "quiet" | "none";

/**
 * Whether a project's events arrive, for the dot beside its name in the
 * workspace sidebar: an event in the last day, an older one, or none yet.
 * `label` says it in words, for the accessible name and the tooltip.
 */
export function eventStatus(
  lastEventAt: string | null,
  now = new Date(),
): { state: EventState; label: string } {
  if (lastEventAt === null) return { state: "none", label: "No events yet" };
  const last = new Date(lastEventAt);
  if (now.getTime() - last.getTime() < RECEIVING_MS) {
    return { state: "receiving", label: "Receiving events" };
  }
  return { state: "quiet", label: `Last event ${timeAgo(last, now)}` };
}
