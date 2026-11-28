/**
 * Script tag entry point, built to dist/tracker.js. See docs/session-replay.md
 * for replay consent and docs/web-analytics.md for heatmaps and the overlay.
 * User IDs and consent stay in memory, so the site supplies them on each load.
 * Optional scripts cannot be pinned by this tag's integrity attribute, so it
 * disables them. Duplicate copies must not double-count visits or split consent.
 */
import {
  createEngagementTimer,
  ENGAGEMENT,
  MAX_ENGAGED_MS,
  MIN_REPORTED_MS,
} from "./engagement.ts";
import { createErrorCapture, ERROR } from "./errors.ts";
import {
  type HeatmapCapture,
  type HeatmapConfig,
  type HeatmapPage,
  HEATMAP_PROPERTY,
} from "./heatmap-names.ts";
import { FILE_DOWNLOAD, linkClick, NOT_FOUND, OUTBOUND_LINK } from "./links.ts";
import { watchNavigation } from "./navigation.ts";
import {
  currentScriptReader,
  type OverlayConfig,
  type OverlayHandoff,
  OVERLAY_PROPERTY,
} from "./overlay-names.ts";
import { randomId } from "./random-id.ts";
import { type Recorder, REPLAY_PROPERTY, type ReplayConfig } from "./replay-names.ts";
import { cleanSignature, cleanUserId, sanitizeProperties } from "./sanitize.ts";
import {
  pageLoadTrace,
  type TracedRequest,
  type TracesConfig,
  TRACES_PROPERTY,
  type TraceRef,
} from "./traces.ts";
import { createTracker, type Page, type SignedUser } from "./tracker.ts";
import { browserTransport } from "./transport.ts";
import { cleanPageUrl, cleanReferrer } from "./url.ts";
import { RECORD_PROPERTY, type VitalName, VITALS } from "./vital-names.ts";

export interface OttertrailApi {
  track(name: string, properties?: Record<string, unknown>): void;
  /**
   * Events from now on carry this user ID: the site's own ID for the
   * signed-in user, with its server's signature when the project needs one.
   */
  identify(userId: string, signature?: string): void;
  /** Events from now on are anonymous again, as after signing out. */
  reset(): void;
  /** Reports an error the site caught itself, with custom event properties if given. */
  captureError(error: unknown, properties?: Record<string, unknown>): void;
  /**
   * Sends what is waiting now. track() already sends at once; this is for
   * the tracker's own events, which wait up to a second. Resolves when the
   * send is done, whatever its outcome; never rejects.
   */
  flush(): Promise<void>;
  /**
   * replay(true) starts session replay, with the snippet's settings, when
   * the snippet has data-replay (for data-replay-consent="wait"). replay(false)
   * stops it and drops what was recorded; replay(true) after it starts a
   * new, empty recording. The last call wins.
   */
  replay(on: boolean): void;
  /** Records the page shown now as not found, once per page view. */
  notFound(): void;
  /**
   * Records a pageview of the page shown now, or of `path` on this site
   * (such as "/products/:id", to group pages), cleaned as every page is.
   * For data-pageviews="manual", which turns automatic pageviews off.
   */
  pageview(path?: string): void;
}

declare global {
  interface Window {
    ottertrail?: OttertrailApi;
  }
  interface Document {
    /**
     * True while Chrome prerenders the page before the visitor opens it.
     * Not readonly: web-vitals declares it the same way, and both must match.
     */
    prerendering?: boolean;
  }
}

/**
 * As the API checks them (apps/api/src/collection/environment.ts): 1 to 64
 * letters, digits, ".", "_", "-"; and 1 to 200 characters without spaces or
 * control characters. The u flag counts characters as the API does, not
 * UTF-16 units.
 */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const RELEASE_PATTERN = /^[^\s\u0000-\u001F\u007F-\u009F]{1,200}$/u;

/** The tracker's own events: track() refuses their names, and a before-send hook keeps their properties. */
const OWN_EVENTS = ["pageview", ENGAGEMENT, ERROR, VITALS, OUTBOUND_LINK, FILE_DOWNLOAD, NOT_FOUND];

/** An element's custom event on click (data-ottertrail-event), and the prefix of its properties. */
const EVENT_ATTRIBUTE = "data-ottertrail-event";
const EVENT_PROPERTY_PREFIX = `${EVENT_ATTRIBUTE}-`;

/**
 * The site owner's own browser, when its localStorage has
 * ottertrail_ignore = "true": read only, never written, so nothing is stored
 * on a visitor's device. Storage that cannot be read (blocked, sandboxed)
 * counts as not set.
 */
function ignoredBrowser(): boolean {
  try {
    return window.localStorage.getItem("ottertrail_ignore") === "true";
  } catch {
    return false;
  }
}

/**
 * A sample attribute's share, 0 to 1: 1 without the attribute, undefined
 * when it is invalid. Number("") is 0: an empty value is a mistake, not
 * "record nothing".
 */
function sampleOf(text: string | undefined): number | undefined {
  if (text === undefined) return 1;
  const share = text.trim() === "" ? Number.NaN : Number(text);
  return share >= 0 && share <= 1 ? share : undefined;
}

/** How long a page opened with an overlay link waits for o.js's answer before it records as usual. */
const OVERLAY_WAIT_MS = 5000;

/** Marks the real window.ottertrail, as no stand-in is: Symbol.for, so any copy sees it. */
const REAL = Symbol.for("ottertrail.tracker");

(() => {
  try {
    // As the tracker starts, before later scripts can shadow it.
    const currentScript = currentScriptReader(document);
    if (window.ottertrail !== undefined && Reflect.get(window.ottertrail, REAL) === true) {
      console.warn("Ottertrail: duplicate tracker ignored. Remove the extra script tag.");
      return;
    }
    const script = document.currentScript;
    const key = script?.dataset.key;
    const host = script?.dataset.host;
    if (!key || !host) {
      console.warn("Ottertrail: the script tag needs data-key and data-host attributes.");
      return;
    }
    const environment = script?.dataset.environment;
    if (environment !== undefined && !ENVIRONMENT_PATTERN.test(environment)) {
      // Sending them as production's would mix them into the live numbers.
      console.warn("Ottertrail: data-environment is invalid. No data is sent.");
      return;
    }
    let release = script?.dataset.release;
    if (release !== undefined && !RELEASE_PATTERN.test(release)) {
      console.warn("Ottertrail: data-release is invalid. The release is omitted.");
      release = undefined;
    }
    const hashRoutes = script?.dataset.hashRoutes === "on";
    const refOn = script?.dataset.ref !== "off";
    const automatic = script?.dataset.pageviews !== "manual";
    const ignored = ignoredBrowser();
    if (ignored) {
      console.info(
        "Ottertrail: this browser is ignored (localStorage.ottertrail_ignore). Nothing is sent.",
      );
    }

    /** The first page of a visit: its URL and the external referrer, if any. */
    const landing = (href = location.href): Page => {
      const referrer = cleanReferrer(document.referrer);
      return {
        url: cleanPageUrl(href, hashRoutes, refOn),
        ...(referrer === undefined ? {} : { referrer }),
      };
    };

    // Web Vitals (v.js), session replay (r.js), heatmaps (h.js), and the
    // heatmap overlay (o.js) come from beside this script, unless the page
    // pins this script with integrity: they could not be pinned with it.
    // Each carries a nonce if this one did, for sites with a strict Content
    // Security Policy, and gets what it needs through a property of its
    // script element.
    const src =
      script !== null && "src" in script && typeof script.src === "string" ? script.src : "";
    const beside = src !== "" && !script?.hasAttribute?.("integrity");
    const load = (file: string, property: string, value: unknown) => {
      try {
        const added = document.createElement("script");
        added.src = new URL(file, src).href;
        added.async = true;
        if (script?.nonce) added.nonce = script.nonce;
        Object.assign(added, { [property]: value });
        document.head.append(added);
        return added;
      } catch {
        // Without it, the rest still works.
        return undefined;
      }
    };

    // A page opened from the dashboard to see its heatmap
    // (docs/web-analytics.md, "The overlay on your site"): the link's token
    // leaves the address at once, and o.js asks the server about it. The
    // page load is recorded as for any visitor, but the tracker is paused
    // (its events wait in its queue), and no other script loads, until
    // o.js answers. A real link: the queue is dropped, and nothing is sent
    // for this page load (the owner's look is not counted). Anything else
    // (an unknown or used link, o.js failing to load or not answering
    // within OVERLAY_WAIT_MS, the page hidden or left first): the tracker
    // resumes, and the page load carries on as usual.
    const overlay = /^#ottertrail-heatmap=([\w-]{43})$/.exec(location.hash);
    /** The link's answer: undefined while asked, true for the overlay shown, false otherwise. */
    let shown: boolean | undefined = overlay ? undefined : false;
    /** Whether the tracker sends: from the start, or once released. */
    let sending = !overlay;
    /** Whether v.js, r.js, and h.js may load: from the start, or after the answer or the wait. */
    let loading = !overlay;
    const held: (() => void)[] = [];
    const whenSending = (run: () => void) => {
      if (shown || ignored) return;
      if (loading) run();
      else held.push(run);
    };

    const tracker = createTracker({
      key,
      transport: browserTransport(new URL("/api/events", host).href),
      randomId,
      // Only "more than one": some laptops report a single touch point.
      touch: typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1,
      paused: shown === undefined,
      ...(environment === undefined ? {} : { environment }),
      ...(release === undefined ? {} : { release }),
    });
    // Ignored: nothing is queued or sent, and no other script loads but o.js,
    // so the owner can still open a heatmap overlay.
    if (ignored) tracker.discard();

    // The site's before-send hook (data-before-send): a global function's
    // name, looked up for each event, so a later script may define it too.
    // When it is named but missing, throws, or returns no object, the event
    // is dropped, not sent as it was: the hook may be what removes personal
    // data from it. Its result is cleaned as any event is. Returns the page
    // the event went with, or undefined when it was dropped.
    const hookName = script?.dataset.beforeSend;
    const send = (
      name: string,
      page: Page,
      properties?: unknown,
      extra?: Parameters<typeof tracker.track>[3],
    ): Page | undefined => {
      // A page whose URL is too long to send ("") sends nothing.
      if (ignored || page.url === "") return undefined;
      if (hookName === undefined) {
        tracker.track(name, page, properties, extra);
        return page;
      }
      let result: unknown;
      try {
        const hook: unknown = Reflect.get(window, hookName);
        if (typeof hook !== "function") {
          warnOnce(`data-before-send names no function "${hookName}". Events are dropped.`);
          return undefined;
        }
        result = hook({
          name,
          url: page.url,
          referrer: page.referrer,
          properties: sanitizeProperties(properties),
        });
        if (result === null) return undefined;
        if (typeof result !== "object") throw new Error();
        const changed: { url?: unknown; referrer?: unknown; properties?: unknown } = result;
        if (typeof changed.url !== "string") throw new Error();
        const url = cleanPageUrl(changed.url, hashRoutes, refOn);
        // Another origin could refuse the whole batch: its hostname may not be allowed.
        if (new URL(url).origin !== new URL(page.url).origin) throw new Error();
        const referrer =
          typeof changed.referrer === "string" ? cleanReferrer(changed.referrer) : undefined;
        const sent = { url, ...(referrer === undefined ? {} : { referrer }) };
        // The tracker's own measurements stay as they are: the API checks them.
        tracker.track(
          name,
          sent,
          name === ERROR || !OWN_EVENTS.includes(name) ? changed.properties : properties,
          extra,
        );
        return sent;
      } catch {
        warnOnce(
          "the before-send hook threw or returned no event on this site. The event is dropped.",
        );
        return undefined;
      }
    };

    /**
     * The visit counts, for now: the tracker sends what it holds, and, with
     * `scripts`, the scripts that wait load. Hidden or left, only the former.
     */
    const unpause = (scripts: boolean) => {
      if (shown || ignored) return;
      if (!sending) {
        sending = true;
        tracker.resume();
      }
      if (scripts && !loading) {
        loading = true;
        for (const run of held.splice(0)) run();
      }
    };
    /**
     * o.js's answer, once; true when it came in time, before the tracker
     * stopped waiting. A real link that comes late still mutes the rest
     * of the page load: what was sent stays sent, nothing more is, the
     * replay recorder and heatmap capture that started stop and drop what
     * they hold, and scripts that have not loaded never do.
     */
    const settle = (overlayShown: boolean) => {
      if (shown !== undefined) return false;
      const inTime = !sending;
      shown = overlayShown;
      clearTimeout(timer);
      if (shown) {
        held.length = 0;
        tracker.discard();
        // Collectors that already started stop too, and drop what they hold.
        replayWanted = false;
        recorder?.stop();
        try {
          heatmaps?.stop();
        } catch {
          // An older h.js without stop(), from the browser's cache.
        }
      } else {
        unpause(true);
      }
      return inTime;
    };
    const timer = overlay ? setTimeout(() => unpause(true), OVERLAY_WAIT_MS) : undefined;
    if (overlay) {
      history.replaceState(history.state, "", location.pathname + location.search);
      // Before the tracker's own handlers: a visitor who hides or leaves
      // the page at once is counted, by the tracker's own exit.
      window.addEventListener("pagehide", () => unpause(false));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") unpause(false);
      });
      if (beside) {
        // Never on the element: a page script watching the DOM could read it there.
        let config: OverlayConfig | undefined = {
          host,
          token: overlay[1] ?? "",
          environment,
          settled: settle,
          ...(typeof fetch === "function" ? { fetch: fetch.bind(window) } : {}),
        };
        const handoff: OverlayHandoff = () => {
          if (added === undefined || currentScript() !== added) return undefined;
          const given = config;
          config = undefined;
          return given;
        };
        const added = load("o.js", OVERLAY_PROPERTY, handoff);
        added?.addEventListener("error", () => settle(false));
      } else {
        settle(false);
      }
    }

    let current: Page | undefined;
    // The signed-in user now, and when the current page was viewed: its
    // engagement report is theirs, not that of whoever signed in since.
    let user: SignedUser | undefined;
    let viewedBy: SignedUser | undefined;
    const setUser = (id: unknown, signature: unknown, from: string) => {
      const userId = id === undefined ? undefined : cleanUserId(id);
      if (id !== undefined && userId === undefined) {
        // Anonymous, never the user before: they may have signed out.
        console.warn(`Ottertrail: invalid user ID in ${from}. Events are sent without a user ID.`);
      }
      const clean = cleanSignature(signature);
      if (signature !== undefined && clean === undefined) {
        console.warn(`Ottertrail: invalid user signature in ${from}. The signature is omitted.`);
      }
      user = userId === undefined ? undefined : { userId, signature: clean };
      tracker.setUser(user);
    };
    const engaged = createEngagementTimer();

    // The page load's Web Vitals, as v.js last reported them (vitals.ts):
    // one "vitals" event, for the page the visitor landed on and whoever was
    // signed in then, sent when the page is first hidden or left. Not on an
    // in-app navigation: the library measures page loads, and it has not
    // yet counted the click that navigates.
    let vitals: Partial<Record<VitalName, number>> = {};
    let vitalsSent = false;
    let landedOn:
      | { page: Page; user: SignedUser | undefined; trace: TraceRef | undefined }
      | undefined;
    const recordVital = (name: VitalName, value: number) => {
      if (!vitalsSent && Number.isFinite(value) && value >= 0) {
        // Milliseconds, and layout shift to four decimals, as the API takes them.
        vitals[name] = name === "CLS" ? Math.round(value * 10_000) / 10_000 : Math.round(value);
      }
    };
    const sendVitals = () => {
      const measured = Object.entries(vitals);
      if (vitalsSent || landedOn === undefined || measured.length === 0) return;
      vitalsSent = true;
      send(
        VITALS,
        landedOn.page,
        Object.fromEntries(measured.map(([name, value]) => [name.toLowerCase(), value])),
        { user: landedOn.user, trace: landedOn.trace },
      );
    };

    // Time on the current page, sent when the visitor leaves it or hides the tab.
    const reportEngagement = () => {
      // A tab left open for days still reports at most what the API accepts.
      const engagedMs = Math.min(engaged.take(), MAX_ENGAGED_MS);
      if (current !== undefined && engagedMs >= MIN_REPORTED_MS) {
        send(ENGAGEMENT, current, { engagedMs }, { user: viewedBy });
      }
    };

    /** A pageview of the page shown now, or of `href` (pageview(path)): it is cleaned the same way. */
    const pageview = (href = location.href) => {
      const landed = current === undefined;
      if (!landed) {
        reportEngagement(); // The page being left, before the new one.
      }
      // After the first page, the "referrer" is the previous page in the app,
      // as it would be for a normal page load.
      if (current === undefined) {
        current = landing(href);
      } else {
        const referrer = cleanReferrer(current.url);
        current = {
          url: cleanPageUrl(href, hashRoutes, refOn),
          ...(referrer === undefined ? {} : { referrer }),
        };
      }
      viewedBy = user;
      // The server's trace belongs to the page load, not to the app's own
      // navigations after it, nor to a page restored from the cache.
      pageTrace = loadTrace;
      loadTrace = undefined;
      requestsTraced = tracesOn && Math.random() < (tracesSample ?? 1);
      landedOn ??= { page: current, user, trace: pageTrace };
      const sent = send("pageview", current, undefined, { trace: pageTrace });
      // Only on a page load: an app's later pages keep the head the server sent.
      if (landed && document.querySelector('meta[name="ottertrail"][content="not-found"]')) {
        notFound();
      }
      // Heatmaps: this pageview is in the sample or not, decided now, kept
      // nowhere. They follow the pageview as sent: a before-send hook that
      // changed its URL or dropped it changes or drops them too.
      if (heatmapsDeclared) {
        heatmapPage =
          // A page whose URL is too long to send ("") has none.
          sent !== undefined && sent.url !== "" && Math.random() < (heatmapSample ?? 1)
            ? { url: sent.url, referrer: sent.referrer, at: Date.now() }
            : null;
        if (heatmapPage !== null) loadHeatmaps();
        heatmaps?.navigated();
      }
    };

    if (script?.dataset.userId !== undefined) {
      setUser(script.dataset.userId, script.dataset.userSignature, "data-user-id");
    }

    // Session replay (r.js), once it runs. Wanted from the start, unless
    // the snippet waits for consent: then from replay(true) on.
    let recorder: Recorder | undefined;
    let replayWanted = script?.dataset.replayConsent !== "wait";
    let replayLoaded = false;
    // Each warning once per page load.
    const warned = new Set<string>();
    const warnOnce = (message: string) => {
      if (!warned.has(message)) {
        warned.add(message);
        console.warn(`Ottertrail: ${message}`);
      }
    };

    // Traces (traces.ts), only with data-traces="on": they change the
    // site's own requests, and its servers must send Server-Timing. The
    // page load's trace is read here, for the first pageview; request
    // tracing is n.js (requests.ts), which errors read once it runs.
    const tracesOn = script?.dataset.traces === "on";
    let loadTrace =
      tracesOn && typeof performance === "object" ? pageLoadTrace(performance) : undefined;
    let pageTrace: TraceRef | undefined;
    let requestsTraced = false;
    const tracesSample = sampleOf(script?.dataset.tracesSample);
    if (tracesOn && tracesSample === undefined) {
      warnOnce("data-traces-sample must be from 0 to 1. All pageviews are sampled.");
    }
    let recentRequests: (() => TracedRequest[]) | undefined;
    if (tracesOn && !beside) {
      warnOnce(
        "Request tracing is off because the script tag has integrity. Remove integrity to enable it.",
      );
    } else if (tracesOn) {
      const config: TracesConfig = {
        origins: script?.dataset.tracesOrigins,
        skip: new URL("/api/", host).href,
        sampled: () => requestsTraced,
        register: (recent) => {
          recentRequests = recent;
        },
      };
      whenSending(() => load("n.js", TRACES_PROPERTY, config));
    }

    // An error belongs to the page and user of that moment, as a custom event does.
    // With a replay recording, it carries the replay's ID.
    // With traces, it carries the page load's trace and the last requests.
    const errors = createErrorCapture((error, properties) => {
      const replayId = recorder?.error();
      const requests = recentRequests?.() ?? [];
      send(ERROR, current ?? landing(), properties, {
        error: {
          ...error,
          ...(replayId === undefined ? {} : { replayId }),
          ...(requests.length === 0 ? {} : { requests }),
        },
        trace: pageTrace,
      });
    });
    if (script?.dataset.errors !== "off") {
      // Without capture: a failed image's or script's "error" never reaches window.
      window.addEventListener("error", errors.uncaught);
      window.addEventListener("unhandledrejection", (event) => errors.rejected(event.reason));
    }

    // Pages the site marks as not found, and clicks on links to other
    // sites and on files (links.ts), unless the snippet turns them off.
    const notFoundOn = script?.dataset.notFound !== "off";
    let notFoundPage: Page | undefined;
    const notFound = () => {
      if (notFoundOn && current !== undefined && notFoundPage !== current) {
        notFoundPage = current;
        send(NOT_FOUND, current);
      }
    };
    const linksOn = {
      outbound: script?.dataset.outbound !== "off",
      downloads: script?.dataset.downloads !== "off",
    };
    // One listener for every click, in the capture phase, so a page's own
    // handler that stops the click cannot hide it. It never delays the
    // navigation: the event leaves at once, in a request that outlives the page.
    // It records clicks on links (links.ts), and the custom event of an
    // element marked with data-ottertrail-event, with its properties from
    // data-ottertrail-event-* attributes, and no other attribute or text.
    const clicked = (event: MouseEvent) => {
      try {
        // The main button, or the middle one (auxclick), which opens a new tab; not the menu's.
        const { target } = event;
        if (event.button > 1 || !(target instanceof Element)) return;
        const link = target.closest("a[href]");
        const click = link && linkClick(link, location.hostname, linksOn);
        const marked = target.closest(`[${EVENT_ATTRIBUTE}]`);
        // With a marked element, its event sends both in one request.
        if (click) send(click.name, current ?? landing(), { url: click.url }, { now: !marked });
        // A middle click counts only on a link, where it opens the page in a new tab.
        if (marked && (event.type === "click" || link)) {
          const properties: Record<string, string> = {};
          for (const { name, value } of Array.from(marked.attributes)) {
            if (name.startsWith(EVENT_PROPERTY_PREFIX)) {
              properties[name.slice(EVENT_PROPERTY_PREFIX.length)] = value;
            }
          }
          api.track(marked.getAttribute(EVENT_ATTRIBUTE) ?? "", properties);
        }
      } catch {
        // Never break the page the tracker runs on.
      }
    };
    document.addEventListener("click", clicked, true);
    document.addEventListener("auxclick", clicked, true);

    if (beside && script?.dataset.vitals !== "off") {
      // A page restored from the back/forward cache is a new page load. In
      // the capture phase, and added before v.js runs, this goes first: the
      // library reports the restored page's first values in its own.
      window.addEventListener(
        "pageshow",
        (event) => {
          if (event.persisted) {
            vitals = {};
            vitalsSent = false;
            landedOn = undefined;
          }
        },
        true,
      );
      whenSending(() => load("v.js", RECORD_PROPERTY, recordVital));
    }
    const replayDeclared = script?.dataset.replay === "errors";
    const loadRecorder = () => {
      if (!beside || !replayDeclared || replayLoaded) return;
      replayLoaded = true;
      const config: ReplayConfig = {
        endpoint: new URL("/api/replays", host).href,
        key,
        text: script?.dataset.replayText === "show",
        media: script?.dataset.replayMedia === "show",
        register: (started) => {
          recorder = started;
          if (!replayWanted) started.stop();
        },
      };
      whenSending(() => load("r.js", REPLAY_PROPERTY, config));
    };
    if (replayWanted) loadRecorder();

    // Heatmaps (h.js), loaded with the first pageview in the sample.
    const heatmapsAsked = script?.dataset.heatmaps === "on";
    if (heatmapsAsked && !beside) {
      warnOnce(
        "Heatmaps are off because the script tag has integrity. Remove integrity to enable them.",
      );
    }
    const heatmapsDeclared = beside && heatmapsAsked;
    const heatmapSample = sampleOf(script?.dataset.heatmapsSample);
    if (heatmapsDeclared && heatmapSample === undefined) {
      warnOnce("data-heatmaps-sample must be from 0 to 1. All pageviews are sampled.");
    }
    let heatmapPage: HeatmapPage | null = null;
    let heatmaps: HeatmapCapture | undefined;
    let heatmapsLoaded = false;
    const loadHeatmaps = () => {
      if (heatmapsLoaded) return;
      heatmapsLoaded = true;
      const config: HeatmapConfig = {
        endpoint: new URL("/api/heatmaps", host).href,
        key,
        environment,
        release,
        page: () => heatmapPage,
        register: (capture) => {
          heatmaps = capture;
          // h.js ran after a late real link: it stops at once.
          if (shown) capture.stop();
        },
      };
      whenSending(() => load("h.js", HEATMAP_PROPERTY, config));
    };

    /** pageview(path): what a page's script passes, checked. */
    const pageviewOf = (path: unknown) => {
      try {
        let href = location.href;
        if (path !== undefined) {
          if (typeof path !== "string" || !path.startsWith("/")) throw new Error();
          const url = new URL(path, location.origin);
          // A path such as "/\evil.example" would leave the site.
          if (url.origin !== location.origin) throw new Error();
          // The page's UTM tags stay.
          url.search = location.search;
          href = url.href;
        }
        pageview(href);
      } catch {
        warnOnce(
          'pageview(path) takes a path on this site, such as "/products/:id". Nothing is recorded.',
        );
      }
    };

    // The page's stand-in from before this script ran, with its queued calls.
    const early: unknown = window.ottertrail;
    const api: OttertrailApi = {
      identify: (id, signature) => setUser(id, signature, "identify()"),
      reset: () => setUser(undefined, undefined, "reset()"),
      captureError: errors.handled,
      // Unknown: a page's script may pass anything. Only true starts.
      notFound,
      replay: (on: unknown) => {
        try {
          // On the owner's page, opened for the overlay, nothing records.
          if (on !== true || shown || ignored) {
            replayWanted = false;
            recorder?.stop();
          } else if (!replayDeclared) {
            // Replay is the site's choice, with its privacy settings in the snippet.
            warnOnce(
              'replay(true) needs data-replay="errors" on the script tag. Nothing is recorded.',
            );
          } else if (!beside) {
            warnOnce(
              "Replay is off because the script tag has integrity. Remove integrity to enable it.",
            );
          } else if (!replayWanted) {
            replayWanted = true;
            if (recorder === undefined) loadRecorder();
            else recorder.again();
          }
        } catch {
          // Such as an older r.js still in the browser's cache, without again():
          // never thrown into the consent tool's callback.
          warnOnce("session replay could not be changed.");
        }
      },
      track: (name, properties) => {
        // The tracker sends these itself; a page sending them would distort reports.
        if (OWN_EVENTS.includes(name)) {
          console.warn(`Ottertrail: "${name}" is reserved. Use a different event name.`);
          return;
        }
        // At once: a site's event often comes just before the page is left.
        send(name, current ?? landing(), properties, { now: true });
      },
      pageview: pageviewOf,
      flush: () => tracker.flush(),
    };
    Object.defineProperty(api, REAL, { value: true });
    window.ottertrail = api;
    if (typeof early === "object" && early !== null && "q" in early && Array.isArray(early.q)) {
      // A reference the page kept to the stand-in reaches this script too.
      Object.assign(early, api);
      // The last call wins, so only the last queued one is made, as the API
      // takes it (only true starts): r.js is not requested for a "true" a
      // later answer took back.
      const queued = early.q as unknown[];
      if (queued.length > 0) api.replay(queued[queued.length - 1] === true);
      // Pageviews the stand-in queued, in order, for pages shown before this script ran.
      if ("p" in early && Array.isArray(early.p)) {
        for (const path of early.p as unknown[]) pageviewOf(path);
      }
    }

    const start = () => {
      if (document.visibilityState === "visible") {
        engaged.resume();
      }
      if (automatic) {
        pageview();
        watchNavigation(window, () => pageview(), hashRoutes);
      }

      // Back or forward to a page kept in the back/forward cache: the
      // browser shows it again without running this script again. A load
      // without the cache would record a pageview, so this does too.
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) {
          // Time in the cache is not engaged time, whether or not
          // visibilitychange fired around it: start again from zero.
          engaged.pause();
          engaged.take();
          if (document.visibilityState === "visible") {
            engaged.resume();
          }
          current = undefined; // As on a fresh load: a landing page.
          if (automatic) pageview();
        }
      });
    };
    // A prerendered page may never be seen; count it only once it is.
    if (document.prerendering) {
      document.addEventListener("prerenderingchange", start, { once: true });
    } else {
      start();
    }

    // The last chance to send: the tab is hidden (switched away, phone
    // locked) or the page is unloading. Mobile browsers often never fire
    // unload events, so visibilitychange is the reliable signal.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        engaged.pause();
        reportEngagement();
        sendVitals();
        tracker.flushOnExit();
      } else {
        engaged.resume();
      }
    });
    window.addEventListener("pagehide", () => {
      reportEngagement();
      // Leaving a page fires pagehide, then visibilitychange, when the
      // library takes its last values: let that one send them. A browser
      // that fires no visibilitychange here has hidden the page already.
      if (document.visibilityState === "hidden") sendVitals();
      tracker.flushOnExit();
    });
  } catch {
    // Never break the page the tracker runs on.
  }
})();
