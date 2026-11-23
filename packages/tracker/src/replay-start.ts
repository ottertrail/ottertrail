/**
 * Mask inputs and, unless shown, text and media before capture. Block frames;
 * never inline canvas, fonts, or images. replay-filter.ts checks each event
 * again. See docs/session-replay.md.
 */
import { record } from "@rrweb/record";

import { randomId } from "./random-id.ts";
import {
  BLOCK,
  blockSelector,
  MASK,
  MASK_ATTRIBUTE,
  maskText,
  maskValue,
  TYPED,
  UNMASK_ATTRIBUTE,
} from "./replay-filter.ts";
import type { ReplayConfig } from "./replay-names.ts";
import {
  CHECKOUT_MS,
  createRecorder,
  type RecorderOptions,
  type ReplayRecorder,
} from "./replay-recorder.ts";

const TYPED_SELECTOR = "textarea,select,option,optgroup,datalist";

const INPUT_TYPES = [
  "color",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "range",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
  "textarea",
  "select",
  "password",
] as const;

const typed = (element: Element) =>
  element.closest(TYPED_SELECTOR) !== null ||
  (element instanceof HTMLElement && element.isContentEditable);

/**
 * Records the page as `config` says; `overrides` are for tests. Returns the
 * recorder, or undefined when this browser cannot compress in the page.
 */
export function startReplay(
  config: ReplayConfig,
  overrides: Partial<RecorderOptions> = {},
): ReplayRecorder | undefined {
  if (typeof CompressionStream !== "function") return undefined;
  const block = blockSelector(config.media);
  const hidden = `${block},[${MASK_ATTRIBUTE}]`;

  /** The markers on a recorded node and above it, as the page has them now. */
  const live = (id: number): number => {
    const node = record.mirror.getNode(id);
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    if (element === null) return 0;
    return (
      (element.closest(block) === null ? 0 : BLOCK) |
      (element.closest(`[${MASK_ATTRIBUTE}]`) === null ? 0 : MASK) |
      (typed(element) ? TYPED : 0)
    );
  };

  const recorder = createRecorder({
    endpoint: config.endpoint,
    key: config.key,
    showText: config.text,
    showMedia: config.media,
    base: location.href,
    live,
    randomId,
    fetch: (...args) => fetch(...args),
    beacon: (url, body) => navigator.sendBeacon(url, body),
    record: (emit) =>
      record({
        emit,
        checkoutEveryNms: CHECKOUT_MS,
        blockSelector: block,
        // Every text node goes through maskTextFn, which shows only what the site shows.
        maskTextSelector: "*",
        maskTextFn: (text, element) =>
          element !== null &&
          element.closest(hidden) === null &&
          !typed(element) &&
          (config.text || element.closest(`[${UNMASK_ATTRIBUTE}]`) !== null)
            ? text
            : maskText(text),
        maskAllInputs: true,
        maskInputOptions: Object.fromEntries(INPUT_TYPES.map((type) => [type, true])),
        maskInputFn: maskValue,
        // No scripts, comments, or head metadata.
        slimDOMOptions: "all",
        recordCanvas: false,
        collectFonts: false,
        recordCrossOriginIframes: false,
        inlineImages: false,
        sampling: { mousemove: 50, scroll: 150, input: "last" },
        // rrweb's own failures stay inside it: never thrown into the page.
        errorHandler: () => true,
      }),
    // replay(false), then replay(true): a new recording, as r.js starts one,
    // with this one's listeners gone.
    again: () => {
      document.removeEventListener("prerenderingchange", recorder.start);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", recorder.exit);
      startReplay(config, overrides);
    },
    ...overrides,
  });
  // The page is hidden or left: send what is ready, by beacon.
  const onHidden = () => {
    if (document.visibilityState === "hidden") recorder.exit();
  };

  config.register(recorder);
  // A prerendered page may never be seen: record once it is.
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", recorder.start, { once: true });
  } else {
    recorder.start();
  }
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", recorder.exit);
  return recorder;
}
