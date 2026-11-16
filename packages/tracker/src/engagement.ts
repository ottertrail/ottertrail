/**
 * Measures engaged time: how long the current page has been visible. Time
 * in a background tab, or with the phone locked, does not count.
 */

/** Shorter visits to a page are not reported: they add noise, not insight. */
export const MIN_REPORTED_MS = 1000;

/** The API rejects an engagement event above 24 hours. */
export const MAX_ENGAGED_MS = 24 * 60 * 60 * 1000;

/** The event the tracker sends with engaged time. Reserved: pages cannot send it themselves. */
export const ENGAGEMENT = "engagement";

export interface EngagementTimer {
  /** The page is visible: start counting (no effect if already counting). */
  resume(): void;
  /** The page is hidden: stop counting (no effect if already stopped). */
  pause(): void;
  /** Engaged time since the last take(), in milliseconds; then starts again from 0. */
  take(): number;
}

export function createEngagementTimer(now: () => number = Date.now): EngagementTimer {
  let collected = 0;
  let visibleSince: number | undefined;

  const pause = () => {
    if (visibleSince !== undefined) {
      collected += Math.max(0, now() - visibleSince);
      visibleSince = undefined;
    }
  };
  const resume = () => {
    visibleSince ??= now();
  };

  return {
    resume,
    pause,
    take() {
      const counting = visibleSince !== undefined;
      pause();
      const engaged = collected;
      collected = 0;
      if (counting) resume();
      return engaged;
    },
  };
}
