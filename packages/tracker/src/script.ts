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
 */
import {
  createEngagementTimer,
  ENGAGEMENT,
  MAX_ENGAGED_MS,
  MIN_REPORTED_MS,
} from "./engagement.ts";
import { createErrorCapture, ERROR } from "./errors.ts";
import { watchNavigation } from "./navigation.ts";
import { randomId } from "./random-id.ts";
import { cleanSignature, cleanUserId } from "./sanitize.ts";
import { createTracker, type Page, type SignedUser } from "./tracker.ts";
import { browserTransport } from "./transport.ts";
import { cleanPageUrl, cleanReferrer } from "./url.ts";

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

(() => {
  try {
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
      console.warn("Ottertrail: invalid data-environment, so nothing is sent.");
      return;
    }
    let release = script?.dataset.release;
    if (release !== undefined && !RELEASE_PATTERN.test(release)) {
      console.warn("Ottertrail: invalid data-release, so it is left out.");
      release = undefined;
    }

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
        console.warn(`Ottertrail: invalid user ID in ${from}, so events go without one.`);
      }
      const clean = cleanSignature(signature);
      if (signature !== undefined && clean === undefined) {
        console.warn(`Ottertrail: invalid user signature in ${from}, so it is left out.`);
      }
      user = userId === undefined ? undefined : { userId, signature: clean };
      tracker.setUser(user);
    };
    const engaged = createEngagementTimer();

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
      tracker.track("pageview", current);
    };

    if (script?.dataset.userId !== undefined) {
      setUser(script.dataset.userId, script.dataset.userSignature, "data-user-id");
    }

    // An error belongs to the page and user of that moment, as a custom event does.
    const errors = createErrorCapture((error, properties) => {
      tracker.track(ERROR, current ?? landing(), properties, { error });
    });
    if (script?.dataset.errors !== "off") {
      // Without capture: a failed image's or script's "error" never reaches window.
      window.addEventListener("error", errors.uncaught);
      window.addEventListener("unhandledrejection", (event) => errors.rejected(event.reason));
    }

    window.ottertrail = {
      identify: (id, signature) => setUser(id, signature, "identify()"),
      reset: () => setUser(undefined, undefined, "reset()"),
      captureError: errors.handled,
      track: (name, properties) => {
        // The tracker sends these itself; a page sending them would distort reports.
        if (name === "pageview" || name === ENGAGEMENT || name === ERROR) {
          console.warn(
            `Ottertrail: "${name}" is reserved for the tracker's own events, so it is not sent.`,
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
