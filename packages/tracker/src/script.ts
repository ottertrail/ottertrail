/**
 * The script tag entry point, built to dist/tracker.js:
 *
 *   <script defer src="…/tracker.js"
 *     data-key="pk_…" data-host="https://analytics.example.com"></script>
 *
 * It records a pageview on load and on every path change, and exposes
 * window.ottertrail.track(name, properties) for custom events.
 */
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
    const pageview = () => {
      // After the first page, the "referrer" is the previous page in the app,
      // as it would be for a normal page load.
      current =
        current === undefined
          ? landing()
          : {
              url: cleanPageUrl(location.href),
              referrer: cleanReferrer(current.url) ?? current.url,
            };
      tracker.track("pageview", current);
    };

    window.ottertrail = {
      track: (name, properties) => tracker.track(name, current ?? landing(), properties),
    };

    const start = () => {
      pageview();
      watchNavigation(window, pageview);
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
        tracker.flushOnExit();
      }
    });
    window.addEventListener("pagehide", () => tracker.flushOnExit());
  } catch {
    // Never break the page the tracker runs on.
  }
})();
