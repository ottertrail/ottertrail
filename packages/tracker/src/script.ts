/**
 * The script tag entry point, built to dist/tracker.js:
 *
 *   <script defer src="…/tracker.js"
 *     data-key="pk_…" data-host="https://analytics.example.com"></script>
 *
 * Optional: data-environment="staging" on a site other than the live one,
 * whose events then never mix with production's, data-release="1.4.2", the
 * site's version, and data-user-id="42", the site's ID for the signed-in
 * user, with data-user-signature="…" when the project requires the site's
 * server to sign user IDs. A single-page app that signs someone in or out
 * without a page load calls window.ottertrail.identify("42", signature)
 * and window.ottertrail.reset().
 * The user's ID is kept in memory only: the tracker stores nothing on the
 * device, so the site gives it on every page load.
 *
 * It records a pageview on load and on every path change, reports how long
 * each page was visible (an "engagement" event), and exposes
 * window.ottertrail.track(name, properties) for custom events.
 *
 * It also sends uncaught errors and unhandled promise rejections as "error"
 * events; data-errors="off" turns that off. Either way the site can report
 * an error it caught with window.ottertrail.captureError(error, properties).
 * Noise is skipped: "Script error." from a cross-origin script that hides
 * its details, and errors from browser extensions. Each distinct error is
 * sent once per page load, and 25 at most.
 *
 * It loads v.js from beside itself to measure Web Vitals, sent as one
 * "vitals" event per page load when the page is first hidden or left;
 * data-vitals="off" skips it, and so does an integrity attribute.
 *
 * Session replay around errors: data-replay="errors" loads r.js from beside
 * it (not with an integrity attribute), which records the page into memory
 * and sends a replay of the 30 to 60 seconds before the page load's first
 * error and the 10 after; that error event, and others of the same page
 * load while it still records, carry its replayId. The project's settings
 * must allow replays too. Recordings are masked in the browser: page text
 * becomes "*" unless data-replay-text="show"; images, picture, video,
 * audio, and SVG are blocked unless data-replay-media="show"; canvas,
 * frames, object, and embed always are; typed values never leave the page.
 * In the site's HTML, data-ottertrail-mask masks an element's text,
 * data-ottertrail-block leaves an element out (only a box of its size),
 * and data-ottertrail-unmask shows an element's text in a private
 * recording.
 *
 * Consent: with data-replay-consent="wait" beside data-replay="errors", r.js
 * is not loaded until the page calls window.ottertrail.replay(true), as
 * when a visitor agrees. replay(false) stops recording and drops what was
 * recorded, or cancels a start still waiting, as when a visitor declines or
 * withdraws consent; replay(true) after it starts a new, empty recording.
 * The last call wins. Nothing about consent is stored: the site calls
 * replay(true) on each page load once its consent tool knows the answer.
 * A page that may call before this script runs defines, first, the
 * stand-in in docs/session-replay.md: replay() queues its answers in q, and
 * track(), identify(), reset(), and captureError() do nothing until then.
 * This script makes the last call queued in q once it runs, and points the
 * stand-in's methods at its own, so a reference kept to it still works.
 *
 * Heatmaps: data-heatmaps="on" loads h.js from beside it (not with an
 * integrity attribute), which records the pageview's clicks, by element,
 * and how far down the page the visitor scrolled; never any text, value,
 * ID, class, or address of the page (docs/web-analytics.md, "Heatmaps").
 * The project's settings must allow heatmaps too. Each pageview is sampled
 * on its own: data-heatmaps-sample="0.25" records a quarter of them (1,
 * all, by default); nothing about it is stored.
 *
 * Heatmap overlay: a page opened from the dashboard's "Open on your site"
 * has #ottertrail-heatmap=<token> in its address. The tracker removes it
 * from the address and loads o.js from beside it (not with an integrity
 * attribute), which asks the server about the link. For a real link it
 * draws the project's heatmap over the page for the signed-in owner only,
 * and nothing is sent for that page load; for anything else (a made-up
 * token, a link used up, o.js not loading within 5 seconds) the page load
 * is recorded as usual, a few seconds late.
 *
 * Loaded twice on one page (in a tag manager and in the page's template),
 * the second copy warns and does nothing: two copies would count every
 * pageview twice, and replay(false) would reach only one recorder.
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
import { watchNavigation } from "./navigation.ts";
import { type OverlayConfig, OVERLAY_PROPERTY } from "./overlay-names.ts";
import { randomId } from "./random-id.ts";
import { type Recorder, REPLAY_PROPERTY, type ReplayConfig } from "./replay-names.ts";
import { cleanSignature, cleanUserId } from "./sanitize.ts";
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
   * replay(true) starts session replay, with the snippet's settings, when
   * the snippet has data-replay (for data-replay-consent="wait"). replay(false)
   * stops it and drops what was recorded; replay(true) after it starts a
   * new, empty recording. The last call wins.
   */
  replay(on: boolean): void;
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

/** The first page of a visit: its URL and the external referrer, if any. */
function landing(): Page {
  const referrer = cleanReferrer(document.referrer);
  return { url: cleanPageUrl(location.href), ...(referrer === undefined ? {} : { referrer }) };
}

/** How long a page opened with an overlay link waits for o.js's answer before it records as usual. */
const OVERLAY_WAIT_MS = 5000;

/** window.ottertrail's methods on a page opened for the heatmap overlay. */
const none = () => undefined;

/** Marks the real window.ottertrail, as no stand-in is: Symbol.for, so any copy sees it. */
const REAL = Symbol.for("ottertrail.tracker");

(() => {
  try {
    if (window.ottertrail !== undefined && Reflect.get(window.ottertrail, REAL) === true) {
      console.warn("Ottertrail: the tracker is on this page twice. This copy does nothing.");
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
      } catch {
        // Without it, the rest still works.
      }
    };

    // Everything that records this page load: at once, or once the heatmap
    // overlay's link proves not to be one (below).
    const begin = () => {
      try {
        const tracker = createTracker({
          key,
          transport: browserTransport(new URL("/api/events", host).href),
          randomId,
          // Only "more than one": some laptops report a single touch point.
          touch: typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1,
          ...(environment === undefined ? {} : { environment }),
          ...(release === undefined ? {} : { release }),
        });

        let current: Page | undefined;
        // The signed-in user now, and when the current page was viewed: its
        // engagement report is theirs, not that of whoever signed in since.
        let user: SignedUser | undefined;
        let viewedBy: SignedUser | undefined;
        /** Sets the signed-in user from a page's values, warning about any it cannot use. */
        const setUser = (id: unknown, signature: unknown, from: string) => {
          const userId = id === undefined ? undefined : cleanUserId(id);
          if (id !== undefined && userId === undefined) {
            // Anonymous, never the user before: they may have signed out.
            console.warn(
              `Ottertrail: invalid user ID in ${from}. Events are sent without a user ID.`,
            );
          }
          const clean = cleanSignature(signature);
          if (signature !== undefined && clean === undefined) {
            console.warn(
              `Ottertrail: invalid user signature in ${from}. The signature is omitted.`,
            );
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
        let landedOn: { page: Page; user: SignedUser | undefined } | undefined;
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
          tracker.track(
            VITALS,
            landedOn.page,
            Object.fromEntries(measured.map(([name, value]) => [name.toLowerCase(), value])),
            { user: landedOn.user },
          );
        };

        // Time on the current page, sent when the visitor leaves it or hides the tab.
        const reportEngagement = () => {
          // A tab left open for days still reports at most what the API accepts.
          const engagedMs = Math.min(engaged.take(), MAX_ENGAGED_MS);
          if (current !== undefined && engagedMs >= MIN_REPORTED_MS) {
            tracker.track(ENGAGEMENT, current, { engagedMs }, { user: viewedBy });
          }
        };

        const pageview = () => {
          if (current !== undefined) {
            reportEngagement(); // The page being left, before the new one.
          }
          // After the first page, the "referrer" is the previous page in the app,
          // as it would be for a normal page load.
          if (current === undefined) {
            current = landing();
          } else {
            const referrer = cleanReferrer(current.url);
            current = {
              url: cleanPageUrl(location.href),
              ...(referrer === undefined ? {} : { referrer }),
            };
          }
          viewedBy = user;
          landedOn ??= { page: current, user };
          tracker.track("pageview", current);
          // Heatmaps: this pageview is in the sample or not, decided now, kept nowhere.
          if (heatmapsDeclared) {
            heatmapPage =
              // A page whose URL is too long to send ("") has none.
              current.url !== "" && Math.random() < heatmapSample
                ? { url: current.url, referrer: current.referrer, at: Date.now() }
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

        // An error belongs to the page and user of that moment, as a custom event does.
        // With a replay recording, it carries the replay's ID.
        const errors = createErrorCapture((error, properties) => {
          const replayId = recorder?.error();
          tracker.track(ERROR, current ?? landing(), properties, {
            error: replayId === undefined ? error : { ...error, replayId },
          });
        });
        if (script?.dataset.errors !== "off") {
          // Without capture: a failed image's or script's "error" never reaches window.
          window.addEventListener("error", errors.uncaught);
          window.addEventListener("unhandledrejection", (event) => errors.rejected(event.reason));
        }

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
          load("v.js", RECORD_PROPERTY, recordVital);
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
          load("r.js", REPLAY_PROPERTY, config);
        };
        if (replayWanted) loadRecorder();

        // Heatmaps (h.js), loaded with the first pageview in the sample.
        const heatmapsAsked = script?.dataset.heatmaps === "on";
        if (heatmapsAsked && !beside) {
          warnOnce(
            "data-heatmaps cannot load h.js for a script tag with integrity. No heatmaps are recorded.",
          );
        }
        const heatmapsDeclared = beside && heatmapsAsked;
        const sampleText = script?.dataset.heatmapsSample;
        // Number("") is 0: an empty value is a mistake, not "record nothing".
        const sample =
          sampleText === undefined ? 1 : sampleText.trim() === "" ? -1 : Number(sampleText);
        let heatmapSample = 1;
        if (sample >= 0 && sample <= 1) heatmapSample = sample;
        else if (heatmapsDeclared)
          warnOnce("data-heatmaps-sample must be from 0 to 1. All pageviews are sampled.");
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
            },
          };
          load("h.js", HEATMAP_PROPERTY, config);
        };

        // The page's stand-in from before this script ran, with its queued calls.
        const early: unknown = window.ottertrail;
        const api: OttertrailApi = {
          identify: (id, signature) => setUser(id, signature, "identify()"),
          reset: () => setUser(undefined, undefined, "reset()"),
          captureError: errors.handled,
          // Unknown: a page's script may pass anything. Only true starts.
          replay: (on: unknown) => {
            try {
              if (on !== true) {
                replayWanted = false;
                recorder?.stop();
              } else if (!replayDeclared) {
                // Replay is the site's choice, with its privacy settings in the snippet.
                warnOnce(
                  'replay(true) needs data-replay="errors" on the script tag. Nothing is recorded.',
                );
              } else if (!beside) {
                warnOnce(
                  "replay(true) cannot load the recorder for a script tag with integrity. Nothing is recorded.",
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
            if (name === "pageview" || name === ENGAGEMENT || name === ERROR || name === VITALS) {
              console.warn(
                `Ottertrail: "${name}" is reserved for the tracker's own events. The event is not sent.`,
              );
              return;
            }
            tracker.track(name, current ?? landing(), properties);
          },
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
        }

        const start = () => {
          if (document.visibilityState === "visible") {
            engaged.resume();
          }
          pageview();
          watchNavigation(window, pageview);

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
              pageview();
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
    };

    // A page opened from the dashboard to see its heatmap
    // (docs/web-analytics.md, "The overlay on your site"): the link's token
    // leaves the address at once, and o.js asks the server about it. Until
    // it answers, nothing is sent. A real link draws the overlay, and
    // nothing is sent for this page load: the owner's look is not counted.
    // Anything else (an unknown or used link, o.js not loading within
    // OVERLAY_WAIT_MS) records the page load as usual.
    const overlay = /^#ottertrail-heatmap=([\w-]{43})$/.exec(location.hash);
    if (overlay) {
      history.replaceState(history.state, "", location.pathname + location.search);
      const inert: OttertrailApi = {
        track: none,
        identify: none,
        reset: none,
        captureError: none,
        replay: none,
      };
      Object.defineProperty(inert, REAL, { value: true });
      window.ottertrail = inert;
      let held = true;
      const settle = (shown: boolean) => {
        if (!held) return;
        held = false;
        clearTimeout(timer);
        if (!shown) begin();
      };
      const timer = setTimeout(() => settle(false), OVERLAY_WAIT_MS);
      if (beside) {
        const config: OverlayConfig = {
          host,
          token: overlay[1] ?? "",
          environment,
          settled: settle,
        };
        load("o.js", OVERLAY_PROPERTY, config);
      } else {
        settle(false);
      }
    } else {
      begin();
    }
  } catch {
    // Never break the page the tracker runs on.
  }
})();
