/**
 * What the tracker (script.ts) and the replay recorder (replay.ts, built to
 * r.js) share, without the recorder: importing it here would put rrweb in
 * the tracker.
 */

/** The property the tracker sets on the recorder's script element: a ReplayConfig. */
export const REPLAY_PROPERTY = "ottertrailReplay";

/** What the tracker hands the recorder. */
export interface ReplayConfig {
  /** The data host's /api/replays URL. */
  endpoint: string;
  /** The project's public key. */
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
  /** Stops recording for the rest of the page load and drops what was recorded. */
  stop: () => void;
}
