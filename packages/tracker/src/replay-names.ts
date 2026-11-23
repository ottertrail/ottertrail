/**
 * Shared with script.ts without importing replay.ts, which would bundle rrweb in the tracker.
 */

/** The property the tracker sets on the recorder's script element: a ReplayConfig. */
export const REPLAY_PROPERTY = "ottertrailReplay";
export interface ReplayConfig {
  /** The data host's /api/replays URL. */
  endpoint: string;
  key: string;
  /** data-replay-text="show": page text is recorded as it is. */
  text: boolean;
  /** data-replay-media="show": images, video, audio, and SVG are recorded. */
  media: boolean;
  /** The recorder gives the tracker its controls once it runs. */
  register: (recorder: Recorder) => void;
}

/** The recorder's controls, for the tracker. Neither ever throws. */
export interface Recorder {
  /**
   * An error happened. Returns the ID of the replay that will be sent with
   * it: the first error of the page load starts one, and later errors share
   * it while it still records. Undefined when no replay goes with this error.
   */
  error: () => string | undefined;
  /** Stops recording and drops what was recorded. */
  stop: () => void;
  /**
   * After stop(): starts a new, empty recording, which registers itself as
   * the tracker's recorder. Only once, and not when the recorder stopped
   * itself (the API refused it, or the filter failed).
   */
  again: () => void;
}
