/**
 * The demo shop's heatmaps (seed-data.ts; docs/web-analytics.md,
 * "Heatmaps"): for a share of the site's own pageviews of its main pages,
 * the clicks and the scroll depth h.js would have sent, as rows of
 * ClickHouse's `heatmaps` table. Deterministic, from its own seed, so the
 * rest of the demo data stays as it was.
 *
 * Each page has a made-up layout: the elements people click, with the
 * site's own names where a real site would add data-ottertrail-name, and
 * how far down people read. On the checkout page, "Continue to payment"
 * is the button whose script fails (the seeded checkout error): many of its
 * clicks come in bursts, the rage clicks, and nothing responds to them,
 * the dead clicks. A picture on the home page that looks like a link but
 * is not gets dead clicks too.
 */
import { HEATMAP_RETENTION_DAYS } from "../src/clickhouse/migrations.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { deviceOf, type NewHeatmapRecord } from "../src/heatmaps/store.ts";
import { PAGEVIEW } from "../src/visits/visits.ts";
import type { Random } from "./seed-random.ts";

/** Pageviews of these pages that get heatmap rows: about half, as a site sampling at 0.5. */
const SAMPLE = 0.5;

interface Element {
  label?: string;
  element: string;
  /** How often a pageview clicks it, on average. */
  rate: number;
  /** A broken button: its clicks come in bursts of rage clicks this often. */
  rage?: number;
  /** Nothing on the page responds to a click on it: each is a dead click. */
  dead?: true;
}

interface Layout {
  /** The page's height on a desktop; a phone's is about 1.8 times it. */
  height: number;
  /** How far down an average reader gets, past the fold, 0 to 1. */
  reading: number;
  elements: Element[];
}

const NAV: Element[] = [
  { label: "main-nav", element: "nav>a", rate: 0.05 },
  { label: "main-nav", element: "nav>a:2", rate: 0.12 },
  { label: "main-nav", element: "nav>a:3", rate: 0.06 },
  { label: "main-nav", element: "nav>a:4", rate: 0.04 },
  { element: "body>header>a", rate: 0.05 },
];

/** The shop's main pages, by path, or by kind for the product pages. */
const LAYOUTS: Record<string, Layout> = {
  "/": {
    height: 3600,
    reading: 0.55,
    elements: [
      ...NAV,
      { label: "hero-cta", element: "section>a", rate: 0.32 },
      { label: "hero-cta", element: "section>a:2", rate: 0.1 },
      { label: "featured", element: "section>ul>li>a", rate: 0.12 },
      { label: "featured", element: "section>ul>li:2>a", rate: 0.08 },
      { label: "featured", element: "section>ul>li:3>a", rate: 0.05 },
      { element: "body>main>section:3>img", rate: 0.04, dead: true },
      { element: "body>footer>div>a:3", rate: 0.02 },
    ],
  },
  "/pricing": {
    height: 4200,
    reading: 0.6,
    elements: [
      ...NAV,
      { label: "plan-free", element: "div>button", rate: 0.12 },
      { label: "plan-team", element: "div>button", rate: 0.22 },
      { label: "plan-business", element: "div>button", rate: 0.06 },
      { label: "billing-toggle", element: "button", rate: 0.18 },
      { element: "body>main>section:3>details>summary", rate: 0.09 },
      { element: "body>main>section:3>details:2>summary", rate: 0.07 },
      { element: "body>main>section:3>details:4>summary", rate: 0.05 },
    ],
  },
  "/products": {
    height: 2800,
    reading: 0.5,
    elements: [
      ...NAV,
      { label: "add-to-cart", element: "form>button", rate: 0.3 },
      { label: "product-gallery", element: "div>button:2", rate: 0.14 },
      { label: "product-gallery", element: "div>button:3", rate: 0.08 },
      { element: "body>main>section:2>details>summary", rate: 0.06 },
    ],
  },
  "/cart": {
    height: 1600,
    reading: 0.8,
    elements: [
      { label: "cart-checkout", element: "a", rate: 0.62 },
      { label: "cart-quantity", element: "button:2", rate: 0.15 },
      { label: "cart-quantity", element: "button", rate: 0.06 },
      { element: "body>main>a", rate: 0.08 },
    ],
  },
  "/checkout": {
    height: 2400,
    reading: 0.75,
    elements: [
      { label: "checkout-continue", element: "form>button", rate: 0.55, rage: 0.35 },
      { element: "body>main>form>fieldset>label", rate: 0.2 },
      { element: "body>main>form>fieldset>label:2", rate: 0.12 },
      { element: "body>main>a", rate: 0.04 },
    ],
  },
};

const layoutOf = (path: string) => LAYOUTS[path.startsWith("/products/") ? "/products" : path];

/** The viewport of each kind of device the seed's browsers are. */
const VIEWPORTS = {
  desktop: { width: 1440, height: 860, scale: 1 },
  tablet: { width: 820, height: 1100, scale: 1.4 },
  mobile: { width: 390, height: 760, scale: 1.8 },
} as const;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const round3 = (value: number) => Math.round(clamp(value) * 1000) / 1000;

/** Whole clicks from an average rate: 0.3 is a click three times in ten. */
function clicksOf(rng: Random, rate: number): number {
  let clicks = Math.floor(rate);
  if (rng.chance(rate - clicks)) clicks += 1;
  return clicks;
}

/** The demo's heatmap rows, from the site's pageviews in the last 90 days. */
export function buildHeatmaps(
  rng: Random,
  events: readonly { event: NewEvent }[],
  now: Date,
): NewHeatmapRecord[] {
  const since = now.getTime() - (HEATMAP_RETENTION_DAYS - 1) * 86_400_000;
  const records: NewHeatmapRecord[] = [];
  for (const { event } of events) {
    if (event.name !== PAGEVIEW || (event.environment ?? "production") !== "production") continue;
    if (event.occurredAt.getTime() < since || event.path === undefined) continue;
    const layout = layoutOf(event.path);
    if (layout === undefined || !rng.chance(SAMPLE)) continue;
    const kind = event.client?.deviceType;
    const viewport = VIEWPORTS[kind === "mobile" || kind === "tablet" ? kind : "desktop"];
    const device = deviceOf(viewport.width);
    const pageHeight = Math.round(layout.height * viewport.scale);
    const fold = viewport.height / pageHeight;
    const shared = {
      environment: "production",
      ...(event.release === undefined ? {} : { release: event.release }),
      path: event.path,
      device,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      pageHeight,
    };
    // How far down: some never scroll, some read to the end, most stop on the way.
    const read = rng.chance(0.12)
      ? 0
      : rng.chance(0.15)
        ? 1
        : clamp(rng.normal(layout.reading, 0.22));
    records.push({
      ...shared,
      recordId: rng.uuid(),
      kind: "scroll",
      occurredAt: event.occurredAt,
      label: "",
      element: "",
      x: 0,
      y: 0,
      rage: false,
      depth: round3(fold + read * (1 - fold)),
      fold: round3(fold),
      dropped: 0,
    });
    let at = event.occurredAt.getTime() + rng.int(2000, 8000);
    for (const target of layout.elements) {
      const clicks = clicksOf(rng, target.rate);
      for (let index = 0; index < clicks; index += 1) {
        // A broken button: clicked again and again within a second.
        const burst = target.rage !== undefined && rng.chance(target.rage) ? rng.int(3, 5) : 1;
        const x = clamp(rng.normal(0.5, 0.16));
        const y = clamp(rng.normal(0.5, 0.18));
        for (let click = 0; click < burst; click += 1) {
          records.push({
            ...shared,
            recordId: rng.uuid(),
            kind: "click",
            occurredAt: new Date(at),
            label: target.label ?? "",
            element: target.element,
            x: round3(x + rng.normal(0, 0.02)),
            y: round3(y + rng.normal(0, 0.03)),
            rage: click >= 2,
            // The broken button's bursts did nothing either.
            dead: target.dead === true || burst > 1,
            depth: 0,
          });
          at += burst > 1 ? rng.int(150, 300) : rng.int(3000, 20_000);
        }
      }
    }
  }
  return records;
}
