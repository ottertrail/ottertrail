/**
 * The script tag entry point, built to dist/tracker.js:
 *
 *   <script defer src="…/tracker.js"
 *     data-key="pk_…" data-host="https://analytics.example.com"></script>
 *
 * It records a pageview on load and on every path change, reports how long
 * each page was visible (an "engagement" event), and exposes
 * window.ottertrail.track(name, properties) for custom events.
 */
import {
  createEngagementTimer,
  ENGAGEMENT,
  MAX_ENGAGED_MS,
  MIN_REPORTED_MS,
} from "./engagement.ts";
import { watchNavigation } from "./navigation.ts";
import { randomId } from "./random-id.ts";
import { createTracker, type Page } from "./tracker.ts";
import { browserTransport } from "./transport.ts";
import { cleanPageUrl, cleanReferrer } from "./url.ts";

export interface OttertrailApi {
  track(name: string, properties?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    ottertrail?: OttertrailApi;
  }
  interface Document {
    /** True while Chrome prerenders the page before the visitor opens it. */
    readonly prerendering?: boolean;
  }
}

/** The first page of a visit: its URL and the external referrer, if any. */
function landing(): Page {
  const referrer = cleanReferrer(document.referrer);
  return { url: cleanPageUrl(location.href), ...(referrer === undefined ? {} : { referrer }) };
}

(() => {
  try {
    const script = document.currentScript;
    const key = script?.dataset.key;
    const host = script?.dataset.host;
    if (!key || !host) {
      console.warn("Ottertrail: the script tag needs data-key and data-host attributes.");
      return;
    }

    const tracker = createTracker({
      key,
      transport: browserTransport(new URL("/api/events", host).href),
      randomId,
    });

    let current: Page | undefined;
    const engaged = createEngagementTimer();

    // Time on the current page, sent when the visitor leaves it or hides the tab.
    const reportEngagement = () => {
      // A tab left open for days still reports at most what the API accepts.
      const engagedMs = Math.min(engaged.take(), MAX_ENGAGED_MS);
      if (current !== undefined && engagedMs >= MIN_REPORTED_MS) {
        tracker.track(ENGAGEMENT, current, { engagedMs });
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
      tracker.track("pageview", current);
    };

    window.ottertrail = {
      track: (name, properties) => {
        // The tracker sends these itself; a page sending them would distort reports.
        if (name === "pageview" || name === ENGAGEMENT) {
          console.warn(
            `Ottertrail: "${name}" is sent automatically and cannot be tracked by hand.`,
          );
          return;
        }
        tracker.track(name, current ?? landing(), properties);
      },
    };

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
        tracker.flushOnExit();
      } else {
        engaged.resume();
      }
    });
    window.addEventListener("pagehide", () => {
      reportEngagement();
      tracker.flushOnExit();
    });
  } catch {
    // Never break the page the tracker runs on.
  }
})();
