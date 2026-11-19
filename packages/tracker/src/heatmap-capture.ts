/**
 * Heatmap capture, as h.js runs it (heatmaps.ts; docs/web-analytics.md,
 * "Heatmaps"): each click of a sampled pageview, recorded on the element it
 * hit, and the pageview's scroll depth.
 *
 * What a click sends: the element's structural path (standard tag names and
 * their places among siblings), the site's own data-ottertrail-name nearest
 * to it, where in the element it fell as fractions, the viewport and page
 * sizes, the device class, whether it was a rage click, and its minute.
 * Nothing else about the element or the page is ever read: no text, no
 * values, no IDs, classes, links, sources, or other attributes. Clicks in
 * an element the site blocks or masks for replays (data-ottertrail-block,
 * data-ottertrail-mask) are not recorded at all.
 */
import type { HeatmapConfig, HeatmapPage } from "./heatmap-names.ts";
import { describe, deviceOf, type Device } from "./heatmap-path.ts";
import { randomId } from "./random-id.ts";
import { backoffMs, MAX_ATTEMPTS } from "./tracker.ts";
import { outcomeForStatus } from "./transport.ts";

/** At most this many clicks of one pageview are sent; later ones are only counted. */
export const MAX_CLICKS_PER_PAGEVIEW = 100;
/** Records per request, as the API takes them. */
export const MAX_RECORDS_PER_BATCH = 50;
/** A request's body at most, in bytes: the API takes 64 KiB; the rest is a margin. */
export const MAX_BATCH_BYTES = 60_000;
/**
 * All that is sent as the page is hidden or left, in bytes. A browser lets
 * a page's keepalive requests and beacons carry 64 KiB at once; the
 * tracker's own (time on page, Web Vitals) need the rest. The oldest clicks
 * are dropped first beyond it.
 */
export const MAX_EXIT_BYTES = 16_000;
/** Records kept while the API cannot be reached; the oldest go first. */
export const MAX_QUEUE = 200;
/** How long records wait so they can share one request. */
export const FLUSH_DELAY_MS = 5000;
/** Click times are sent to the minute: their order within it never leaves the page. */
export const TIME_STEP_MS = 60_000;
/** Rage click: this many clicks or more … */
export const RAGE_CLICKS = 3;
/** … within this long … */
export const RAGE_WINDOW_MS = 1000;
/** … and this close together, in CSS pixels. */
export const RAGE_DISTANCE_PX = 30;
/** The API's largest viewport side, page height, and dropped-click count. */
const MAX_VIEWPORT_PX = 16_384;
const MAX_PAGE_PX = 1_000_000;
const MAX_DROPPED = 65_535;

export {
  DESKTOP_FROM_PX,
  describe,
  type Device,
  deviceOf,
  MAX_PATH_LENGTH,
  MAX_STEPS,
  NAME_ATTRIBUTE,
  TABLET_FROM_PX,
} from "./heatmap-path.ts";

/** Session replay's markers, which keep heatmaps out too. */
const PRIVATE = "[data-ottertrail-block],[data-ottertrail-mask]";

/**
 * Elements a click inside goes to, so a click on a button's icon counts
 * for the button: links, buttons, form controls, and elements with these
 * roles. Matched by tag and role only.
 */
const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option]";

/**
 * Whether a click happened inside an element the site blocks or masks,
 * anywhere on its way: the event's composed path reaches into open shadow
 * roots, where the target seen at the window (the outermost host) does not.
 * A closed shadow root hides its nodes from the path: markers inside one
 * cannot be seen, so a site marks its host instead.
 */
export function isPrivate(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof Element && node.matches(PRIVATE));
}

/**
 * The element a click counts for: its interactive ancestor, or itself;
 * null inside an element the site blocks or masks.
 */
export function targetOf(node: EventTarget | null): Element | null {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (element === null || element.closest(PRIVATE) !== null) return null;
  return element.closest(INTERACTIVE) ?? element;
}

const round3 = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const clampPx = (value: number, max: number) => Math.min(max, Math.max(1, Math.round(value)));
const toMinute = (time: number) => Math.floor(time / TIME_STEP_MS) * TIME_STEP_MS;

/**
 * Flags rage clicks: the third and later of RAGE_CLICKS within
 * RAGE_WINDOW_MS and RAGE_DISTANCE_PX of each other.
 */
export function createRageDetector() {
  let recent: { at: number; x: number; y: number }[] = [];
  return (at: number, x: number, y: number): boolean => {
    recent = recent.filter((click) => at - click.at <= RAGE_WINDOW_MS);
    recent.push({ at, x, y });
    const near = recent.filter(
      (click) => Math.hypot(click.x - x, click.y - y) <= RAGE_DISTANCE_PX,
    ).length;
    return near >= RAGE_CLICKS;
  };
}

/** A record as the API takes it, with its page as an index into the batch's pages. */
interface ClickRecord {
  id: string;
  type: "click";
  at: number;
  page: number;
  element: string;
  label?: string;
  x: number;
  y: number;
  rage?: true;
  vw: number;
  vh: number;
  ph: number;
  device: Device;
}

interface ScrollRecord {
  id: string;
  type: "scroll";
  at: number;
  page: number;
  depth: number;
  /** The share of the page visible without scrolling, at its first measurement. */
  fold: number;
  /** Clicks of the pageview past MAX_CLICKS_PER_PAGEVIEW, not recorded. */
  dropped: number;
  vw: number;
  vh: number;
  ph: number;
  device: Device;
}

export type HeatmapRecord = ClickRecord | ScrollRecord;

/** A record waiting to be sent, with its page beside it. */
type Queued = (Omit<ClickRecord, "page"> | Omit<ScrollRecord, "page">) & {
  pageOf: { url: string; referrer?: string | undefined };
};

/** A request's body: the records' pages once each, and the records pointing to them. */
export interface HeatmapBatch {
  v: 1;
  key: string;
  sentAt: number;
  environment?: string;
  release?: string;
  pages: { url: string; referrer?: string }[];
  records: HeatmapRecord[];
}

/** What capture needs of the page; tests pass the real ones, with fakes for sending. */
export interface CaptureOptions {
  window: Window;
  document: Document;
  fetch: (url: string, init: RequestInit) => Promise<{ status: number; headers: Headers }>;
  beacon: (url: string, body: Blob) => boolean;
  randomId?: () => string;
  now?: () => number;
  /** Whether a click is the visitor's own; tests that make clicks in code replace it. */
  trusted?: (event: Event) => boolean;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * A record's page, as sent: its URL, and of its referrer only the origin,
 * which is all the API's referrer spam check reads (its hostname).
 */
function sentPage(page: HeatmapPage): Queued["pageOf"] {
  if (page.referrer === undefined) return { url: page.url };
  try {
    const origin = new URL(page.referrer).origin;
    return origin === "null" ? { url: page.url } : { url: page.url, referrer: origin };
  } catch {
    return { url: page.url };
  }
}

/**
 * Starts recording the config's pageviews. Returns the controls the
 * tracker calls (navigated) and, for tests, flush() and stop().
 */
export function startCapture(config: HeatmapConfig, options: CaptureOptions) {
  const { window: win, document: doc } = options;
  const newId = options.randomId ?? randomId;
  const now = options.now ?? Date.now;
  const trusted = options.trusted ?? ((event: Event) => event.isTrusted);
  let queue: Queued[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let failures = 0;
  /** After a failed send, nothing is sent before this time, as the tracker waits. */
  let retryAt = 0;
  /** After a 403 (heatmaps off, an unknown key, another site): nothing more this page load. */
  let stopped = false;

  // The current pageview's state.
  let page: HeatmapPage | null = null;
  let clicks = 0;
  let dropped = 0;
  let scrollId = "";
  let device: Device = "desktop";
  let viewportWidth = 1;
  let deepest = 0;
  let deepestAt = { vh: 1, ph: 1 };
  let fold: number | undefined;
  /** Whether this pageview has been measured at all: one that was not sends no depth. */
  let measured = false;
  let sent = { depth: -1, dropped: -1 };
  let rage = createRageDetector();
  /** A measurement waiting for the next frame: a navigation that comes first cancels it. */
  let frame: number | undefined;

  const pageHeight = () =>
    clampPx(
      Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, win.innerHeight),
      MAX_PAGE_PX,
    );

  const measure = () => {
    if (page === null) return;
    const ph = pageHeight();
    const vh = clampPx(win.innerHeight, MAX_VIEWPORT_PX);
    measured = true;
    // The fold of the page as it first showed, before content grows below it.
    fold ??= round3(vh / ph);
    const depth = round3((win.scrollY + win.innerHeight) / ph);
    if (depth > deepest) {
      deepest = depth;
      deepestAt = { vh, ph };
    }
  };

  const cancelFrame = () => {
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
  };

  /** Measures on the next frame, then again on the one after when `settle`. */
  const measureLater = (settle = false) => {
    if (frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (!settle) {
        measure();
        return;
      }
      frame = win.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    });
  };

  const open = ({ navigated }: { navigated: boolean }) => {
    page = stopped ? null : config.page();
    clicks = 0;
    dropped = 0;
    scrollId = newId();
    viewportWidth = clampPx(win.innerWidth, MAX_VIEWPORT_PX);
    // Fixed for the pageview: its scroll row keeps one device class when sent again.
    device = deviceOf(viewportWidth);
    deepest = 0;
    deepestAt = { vh: 1, ph: 1 };
    fold = undefined;
    measured = false;
    sent = { depth: -1, dropped: -1 };
    rage = createRageDetector();
    // The page may not have drawn yet: after an in-app navigation it has
    // not rendered, and on the first load a deferred script can run before
    // a client-rendered app draws. The first measurement waits two frames
    // (after the load event, on a first load), or the first scroll.
    if (navigated || doc.readyState === "complete") measureLater(true);
    else win.addEventListener("load", () => measureLater(true), { once: true });
  };

  /** The request's body for these records. */
  const bodyOf = (records: Queued[]): string => {
    const pages: HeatmapBatch["pages"] = [];
    const index = new Map<string, number>();
    const out = records.map(({ pageOf, ...record }) => {
      const key = `${pageOf.url}\n${pageOf.referrer ?? ""}`;
      let at = index.get(key);
      if (at === undefined) {
        at = pages.length;
        index.set(key, at);
        pages.push(
          pageOf.referrer === undefined
            ? { url: pageOf.url }
            : { url: pageOf.url, referrer: pageOf.referrer },
        );
      }
      return { ...record, page: at };
    });
    const batch: HeatmapBatch = {
      v: 1,
      key: config.key,
      sentAt: now(),
      ...(config.environment === undefined ? {} : { environment: config.environment }),
      ...(config.release === undefined ? {} : { release: config.release }),
      pages,
      records: out,
    };
    return JSON.stringify(batch);
  };

  /**
   * Sizes in bytes, each measured once, so that a body's size is worked out
   * by adding, never by writing it again: a record's JSON as sent with page
   * index 0 (an index of more digits adds them), a page's JSON, and the
   * envelope with no pages and no records. Exact: bodyOf writes the same.
   */
  const recordBytes = new WeakMap<Queued, number>();
  const pageBytes = new Map<string, number>();
  const pageKey = (record: Queued) => `${record.pageOf.url}\n${record.pageOf.referrer ?? ""}`;
  const sizeOfRecord = (record: Queued) => {
    let size = recordBytes.get(record);
    if (size === undefined) {
      const { pageOf: _page, ...rest } = record;
      size = byteLength(JSON.stringify({ ...rest, page: 0 }));
      recordBytes.set(record, size);
    }
    return size;
  };
  const sizeOfPage = (record: Queued) => {
    const key = pageKey(record);
    let size = pageBytes.get(key);
    if (size === undefined) {
      const { url, referrer } = record.pageOf;
      size = byteLength(JSON.stringify(referrer === undefined ? { url } : { url, referrer }));
      pageBytes.set(key, size);
    }
    return size;
  };
  const envelopeBytes = () => byteLength(bodyOf([]));

  /** Batches of these records, in order: 50 and MAX_BATCH_BYTES at most each (one record always), with their sizes. */
  const plan = (records: Queued[]): { records: Queued[]; bytes: number }[] => {
    const envelope = envelopeBytes();
    const batches: { records: Queued[]; bytes: number }[] = [];
    let current: Queued[] = [];
    let pages = new Map<string, number>();
    let bytes = envelope;
    for (const record of records) {
      const key = pageKey(record);
      const known = pages.get(key);
      const index = known ?? pages.size;
      const added =
        (known === undefined ? sizeOfPage(record) + (pages.size > 0 ? 1 : 0) : 0) +
        sizeOfRecord(record) +
        String(index).length -
        1 +
        (current.length > 0 ? 1 : 0);
      if (
        current.length > 0 &&
        (current.length === MAX_RECORDS_PER_BATCH || bytes + added > MAX_BATCH_BYTES)
      ) {
        batches.push({ records: current, bytes });
        current = [];
        pages = new Map();
        bytes = envelope;
        // Again, as the first record of a new batch.
        bytes += sizeOfPage(record) + sizeOfRecord(record);
        pages.set(key, 0);
        current.push(record);
        continue;
      }
      if (known === undefined) pages.set(key, index);
      bytes += added;
      current.push(record);
    }
    if (current.length > 0) batches.push({ records: current, bytes });
    return batches;
  };

  /** The oldest records that fit one request. */
  const nextBatch = (from: Queued[]): Queued[] => plan(from)[0]?.records ?? [];

  const remove = (records: Queued[]) => {
    const gone = new Set(records);
    queue = queue.filter((record) => !gone.has(record));
  };

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /** Sends after delayMs, or once the retry wait is over if that is later. */
  const schedule = (delayMs: number) => {
    timer ??= setTimeout(
      () => {
        timer = undefined;
        void flush();
      },
      Math.max(delayMs, retryAt - now()),
    );
  };

  const push = (record: Queued) => {
    // A scroll depth sent again replaces the one still waiting.
    queue = queue.filter((queued) => queued.id !== record.id);
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(record);
    if (queue.length >= MAX_RECORDS_PER_BATCH && now() >= retryAt) void flush();
    else schedule(FLUSH_DELAY_MS);
  };

  async function flush(): Promise<void> {
    if (sending || queue.length === 0 || stopped) return;
    cancelTimer();
    if (now() < retryAt) {
      // Still waiting as the server asked.
      schedule(0);
      return;
    }
    const batch = nextBatch(queue);
    sending = true;
    let status = 0;
    let retryAfter: string | null = null;
    try {
      const response = await options.fetch(config.endpoint, {
        method: "POST",
        body: bodyOf(batch),
        headers: { "content-type": "text/plain" },
        // Not keepalive while the page is shown: a browser lets a page's
        // keepalive requests and beacons carry 64 KiB at once, which the
        // sends as it closes need (exit()).
        credentials: "omit",
      });
      status = response.status;
      retryAfter = response.headers.get("retry-after");
    } catch {
      // Offline, or no answer: retried.
    }
    sending = false;
    if (status === 403) {
      // Heatmaps are off for the project, or this site may not send: never again this page load.
      stopped = true;
      queue = [];
      cancelTimer();
      return;
    }
    const outcome =
      status === 0 ? { type: "retry" as const } : outcomeForStatus(status, retryAfter);
    if (outcome.type === "retry") {
      failures += 1;
      if (failures < MAX_ATTEMPTS) {
        // The same records, with the same IDs: the API stores each once.
        const waitMs = outcome.retryAfterMs ?? backoffMs(failures);
        retryAt = now() + waitMs;
        // A batching timer set while the send was in flight must not win.
        cancelTimer();
        schedule(waitMs);
        return;
      }
    }
    failures = 0;
    remove(batch);
    if (queue.length > 0) schedule(0);
  }

  /** The pageview's scroll depth, queued when deeper, or with more dropped clicks, than sent. */
  const queueScroll = ({ remeasure }: { remeasure: boolean }) => {
    if (page === null || stopped) return;
    if (remeasure) {
      cancelFrame();
      measure();
    }
    // Left before it was ever measured (an in-app navigation at once): no depth to say.
    if (!measured) return;
    const droppedNow = Math.min(dropped, MAX_DROPPED);
    if (deepest <= sent.depth && droppedNow <= sent.dropped) return;
    sent = { depth: deepest, dropped: droppedNow };
    push({
      id: scrollId,
      type: "scroll",
      at: toMinute(page.at),
      pageOf: sentPage(page),
      depth: deepest,
      fold: fold ?? 1,
      dropped: droppedNow,
      vw: viewportWidth,
      vh: deepestAt.vh,
      ph: deepestAt.ph,
      device,
    });
  };

  /**
   * The page is hidden or left: what is queued goes by beacon, within
   * MAX_EXIT_BYTES. Not while the server's Retry-After wait runs: hidden,
   * the queue stays for the send after it; left, it is lost.
   */
  const exit = () => {
    try {
      queueScroll({ remeasure: true });
      if (stopped || now() < retryAt) return;
      cancelTimer();
      // Over the budget, the oldest clicks go first, then the oldest records.
      const total = (records: Queued[]) =>
        plan(records).reduce((sum, batch) => sum + batch.bytes, 0);
      let leaving = [...queue];
      if (total(leaving) > MAX_EXIT_BYTES) {
        // The fewest records to leave out, oldest clicks first, found by
        // halving: the total only falls as more are left out.
        const order = [
          ...leaving.filter((record) => record.type === "click"),
          ...leaving.filter((record) => record.type !== "click"),
        ];
        const without = (count: number) => {
          const gone = new Set(order.slice(0, count));
          return leaving.filter((record) => !gone.has(record));
        };
        let low = 1;
        let high = leaving.length - 1;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (total(without(middle)) <= MAX_EXIT_BYTES) high = middle;
          else low = middle + 1;
        }
        leaving = without(low);
      }
      queue = [];
      for (const text of plan(leaving).map((batch) => bodyOf(batch.records))) {
        if (!options.beacon(config.endpoint, new Blob([text], { type: "text/plain" }))) {
          void options
            .fetch(config.endpoint, {
              method: "POST",
              body: text,
              headers: { "content-type": "text/plain" },
              keepalive: true,
              credentials: "omit",
            })
            .catch(() => undefined);
        }
      }
      failures = 0;
    } catch {
      // Never break the page.
    }
  };

  const onClick = (event: MouseEvent) => {
    try {
      // Trusted primary clicks only; a key's "click" (detail 0) has no position.
      if (page === null || stopped || !trusted(event) || event.button !== 0 || event.detail === 0) {
        return;
      }
      if (isPrivate(event)) return;
      const element = targetOf(event.target);
      if (element === null) return;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      if (clicks >= MAX_CLICKS_PER_PAGEVIEW) {
        dropped += 1;
        return;
      }
      clicks += 1;
      const vw = clampPx(win.innerWidth, MAX_VIEWPORT_PX);
      const at = now();
      const isRage = rage(at, event.clientX, event.clientY);
      push({
        id: newId(),
        type: "click",
        at: toMinute(at),
        pageOf: sentPage(page),
        ...describe(element),
        x: round3((event.clientX - box.left) / box.width),
        y: round3((event.clientY - box.top) / box.height),
        ...(isRage ? { rage: true as const } : {}),
        vw,
        vh: clampPx(win.innerHeight, MAX_VIEWPORT_PX),
        ph: pageHeight(),
        device: deviceOf(vw),
      });
    } catch {
      // Never break the page.
    }
  };
  // On the next frame: a framework that renders the next page before its
  // pushState would otherwise measure the new page as the old one's.
  const onScroll = () => {
    try {
      measureLater();
    } catch {
      // Never break the page.
    }
  };
  const onHidden = () => {
    if (doc.visibilityState === "hidden") exit();
  };

  win.addEventListener("click", onClick, { capture: true, passive: true });
  win.addEventListener("scroll", onScroll, { passive: true });
  doc.addEventListener("visibilitychange", onHidden);
  win.addEventListener("pagehide", exit);
  open({ navigated: false });

  return {
    navigated: () => {
      try {
        // The page being left sends the depth it last measured, then the new one starts at 0.
        cancelFrame();
        queueScroll({ remeasure: false });
        open({ navigated: true });
      } catch {
        // Never break the page.
      }
    },
    flush,
    stop: () => {
      win.removeEventListener("click", onClick, { capture: true });
      win.removeEventListener("scroll", onScroll);
      doc.removeEventListener("visibilitychange", onHidden);
      win.removeEventListener("pagehide", exit);
      cancelTimer();
      cancelFrame();
    },
  };
}
