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
import { HEATMAP_TAGS } from "./heatmap-tags.ts";
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
/** A structural path's most steps and characters (the API's limits). */
export const MAX_STEPS = 24;
export const MAX_PATH_LENGTH = 512;
/** Rage click: this many clicks or more … */
export const RAGE_CLICKS = 3;
/** … within this long … */
export const RAGE_WINDOW_MS = 1000;
/** … and this close together, in CSS pixels. */
export const RAGE_DISTANCE_PX = 30;
/** Device classes by viewport width: mobile under 768, tablet under 1024, desktop from it. */
export const TABLET_FROM_PX = 768;
export const DESKTOP_FROM_PX = 1024;
/** The API's largest viewport side, page height, and dropped-click count. */
const MAX_VIEWPORT_PX = 16_384;
const MAX_PAGE_PX = 1_000_000;
const MAX_DROPPED = 65_535;

/** The site's own name for an element, as the API takes it. */
export const NAME_ATTRIBUTE = "data-ottertrail-name";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;
const TAGS: ReadonlySet<string> = new Set(HEATMAP_TAGS);
/** Session replay's markers, which keep heatmaps out too. */
const PRIVATE = "[data-ottertrail-block],[data-ottertrail-mask]";

/**
 * Elements a click inside goes to, so a click on a button's icon counts
 * for the button: links, buttons, form controls, and elements with these
 * roles. Matched by tag and role only.
 */
const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option]";

export type Device = "mobile" | "tablet" | "desktop";

export function deviceOf(viewportWidth: number): Device {
  if (viewportWidth < TABLET_FROM_PX) return "mobile";
  return viewportWidth < DESKTOP_FROM_PX ? "tablet" : "desktop";
}

/** The element's own name from the site, if it is one the API takes. */
function nameOf(element: Element): string | undefined {
  const name = element.getAttribute(NAME_ATTRIBUTE)?.trim();
  return name !== undefined && NAME_PATTERN.test(name) ? name : undefined;
}

/** "div", or "div:3" for the third div among its siblings; "x" for a tag not in HEATMAP_TAGS. */
function stepOf(element: Element): string {
  const tag = element.tagName.toLowerCase();
  let place = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.tagName === element.tagName) place += 1;
  }
  return `${TAGS.has(tag) ? tag : "x"}${place > 1 ? `:${Math.min(place, 9999)}` : ""}`;
}

/**
 * Where a click went: the element's structural path from the nearest
 * element the site named (data-ottertrail-name), or from body, and that
 * name. At most 24 steps, the nearest kept, "*>" first when cut.
 */
export function describe(element: Element): { element: string; label?: string } {
  const steps: string[] = [];
  let label: string | undefined;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    steps.unshift(stepOf(node));
    label = nameOf(node);
    if (label !== undefined || node.tagName === "BODY") break;
  }
  let cut = steps.length > MAX_STEPS;
  let kept = steps.slice(-MAX_STEPS);
  while (kept.join(">").length > MAX_PATH_LENGTH - 2) {
    kept = kept.slice(1);
    cut = true;
  }
  const path = `${cut ? "*>" : ""}${kept.join(">")}`;
  return label === undefined ? { element: path } : { element: path, label };
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
    fold = undefined;
    sent = { depth: -1, dropped: -1 };
    rage = createRageDetector();
    // After an in-app navigation, the new page has not rendered yet: its
    // first measurement waits two frames, or its first scroll.
    if (navigated) measureLater(true);
    else measure();
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

  /** The oldest records that fit one request: 50 and MAX_BATCH_BYTES at most (one always). */
  const nextBatch = (from: Queued[]): Queued[] => {
    const batch: Queued[] = [];
    for (const record of from) {
      if (batch.length === MAX_RECORDS_PER_BATCH) break;
      if (batch.length > 0 && byteLength(bodyOf([...batch, record])) > MAX_BATCH_BYTES) break;
      batch.push(record);
    }
    return batch;
  };

  /** The request bodies these records take, in order. */
  const split = (records: Queued[]): string[] => {
    const bodies: string[] = [];
    let left = records;
    while (left.length > 0) {
      const batch = nextBatch(left);
      bodies.push(bodyOf(batch));
      left = left.slice(batch.length);
    }
    return bodies;
  };

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
        keepalive: true,
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
    const droppedNow = Math.min(dropped, MAX_DROPPED);
    if (deepest <= sent.depth && droppedNow <= sent.dropped) return;
    sent = { depth: deepest, dropped: droppedNow };
    push({
      id: scrollId,
      type: "scroll",
      at: toMinute(page.at),
      pageOf: sentPage(page),
      depth: deepest,
      fold: fold ?? round3(deepestAt.vh / deepestAt.ph),
      dropped: droppedNow,
      vw: viewportWidth,
      vh: deepestAt.vh,
      ph: deepestAt.ph,
      device,
    });
  };

  /** The page is hidden or left: what is queued goes by beacon, within MAX_EXIT_BYTES. */
  const exit = () => {
    try {
      queueScroll({ remeasure: true });
      if (stopped) return;
      cancelTimer();
      // Over the budget, the oldest clicks go first, then the oldest records.
      let leaving = [...queue];
      let bodies = split(leaving);
      while (
        leaving.length > 1 &&
        bodies.reduce((sum, text) => sum + byteLength(text), 0) > MAX_EXIT_BYTES
      ) {
        const oldestClick = leaving.findIndex((record) => record.type === "click");
        leaving.splice(oldestClick === -1 ? 0 : oldestClick, 1);
        bodies = split(leaving);
      }
      queue = [];
      for (const text of bodies) {
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
