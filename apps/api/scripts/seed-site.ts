/**
 * The demo shop's browser side, for the development seed (seed-data.ts):
 * visits with their pageviews, time on page, Web Vitals, product events,
 * signed-in users, and browser errors, built as the collection endpoint
 * builds them (collection/routes.ts): the page URL and referrer cleaned by
 * the same functions, the browser read from a real User-Agent, the visitor
 * ID made by the same hash, and each error grouped by the same fingerprint.
 * Only the times are in the past, and the arrival time with them.
 */
import { createHmac } from "node:crypto";

import type { NewEvent } from "../src/collection/event-store.ts";
import { cleanReferrer, parsePageUrl } from "../src/collection/normalize.ts";
import { keepValidVitals } from "../src/collection/vitals.ts";
import type { Location } from "../src/enrichment/geo.ts";
import { type Client, parseUserAgent } from "../src/enrichment/user-agent.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { dayIn, visitorId } from "../src/visitors/visitor-ids.ts";
import { ENGAGEMENT, ERROR, PAGEVIEW, VITALS } from "../src/visits/visits.ts";
import type { Random } from "./seed-random.ts";

export const SITE_HOST = "demo-shop.example";
export const STAGING_HOST = "staging.demo-shop.example";
/** The release before the last deploy, the last deploy, and what staging runs. */
export const RELEASES = { previous: "2026.11.1", current: "2026.11.2", staging: "2026.11.3-rc.1" };
/** The days before today the current release went out, at 10:00 UTC. */
export const RELEASE_DAYS_AGO = 6;
/** Days of anonymous traffic; signed-in users go back further, for retention. */
export const TRAFFIC_DAYS = 30;
const USER_DAYS = 63;

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The minified bundles, by release: the content hash in the name changes with each build. */
export const BUNDLES = {
  [RELEASES.previous]: "/assets/index-Bq81mXo4.js",
  [RELEASES.current]: "/assets/index-7Hq2xZ9c.js",
} as const;

/** An event and when it arrived: a few seconds after it happened, as a tracker's batch does. */
export interface Arrived {
  event: NewEvent;
  receivedAt: Date;
}

/** One browser on one network: what a visitor ID is made from. */
interface Person {
  ip: string;
  userAgent: string;
  client: Client;
  location: Location;
}

type Engine = "v8" | "safari" | "firefox";

const USER_AGENTS = {
  desktop: [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      30,
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      18,
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
      16,
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
      12,
    ],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0", 8],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0", 3],
  ],
  mobile: [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
      50,
    ],
    [
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
      38,
    ],
    [
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36",
      12,
    ],
  ],
  tablet: [
    [
      "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
      80,
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      20,
    ],
  ],
} as const;

const LOCATIONS: (readonly [Location, number])[] = [
  [{ country: "US", region: "California", city: "San Francisco" }, 8],
  [{ country: "US", region: "New York", city: "New York" }, 9],
  [{ country: "US", region: "Texas", city: "Austin" }, 5],
  [{ country: "US", region: "Washington", city: "Seattle" }, 4],
  [{ country: "DE", region: "Berlin", city: "Berlin" }, 7],
  [{ country: "DE", region: "Bavaria", city: "Munich" }, 5],
  [{ country: "DE", region: "Hamburg", city: "Hamburg" }, 3],
  [{ country: "GB", region: "England", city: "London" }, 8],
  [{ country: "GB", region: "England", city: "Manchester" }, 2],
  [{ country: "GB", region: "Scotland", city: "Edinburgh" }, 2],
  [{ country: "FR", region: "Île-de-France", city: "Paris" }, 5],
  [{ country: "FR", region: "Auvergne-Rhône-Alpes", city: "Lyon" }, 2],
  [{ country: "NL", region: "North Holland", city: "Amsterdam" }, 5],
  [{ country: "CA", region: "Ontario", city: "Toronto" }, 4],
  [{ country: "CA", region: "British Columbia", city: "Vancouver" }, 2],
  [{ country: "IN", region: "Karnataka", city: "Bengaluru" }, 4],
  [{ country: "IN", region: "Maharashtra", city: "Mumbai" }, 2],
  [{ country: "BR", region: "São Paulo", city: "São Paulo" }, 4],
  [{ country: "AU", region: "New South Wales", city: "Sydney" }, 4],
  [{ country: "ES", region: "Madrid", city: "Madrid" }, 3],
  [{ country: "SE", region: "Stockholm", city: "Stockholm" }, 3],
  [{ country: "JP", region: "Tokyo", city: "Tokyo" }, 2],
  [{ country: "SG", city: "Singapore" }, 2],
  [{ country: "PL", region: "Mazovia", city: "Warsaw" }, 2],
];

/** Visits per UTC hour, as a share of the day: Europe's day, then America's evening. */
const HOURS = [
  2, 1.5, 1.2, 1, 1, 1.3, 2, 3, 4, 4.6, 5, 5.2, 5.4, 5.6, 6, 6.4, 6.6, 6.4, 6, 5.6, 5, 4.4, 3.6,
  2.8,
].map((weight, hour) => [hour, weight] as const);

/** Monday is 1, as getUTCDay() counts; a shop sells less at weekends. */
const WEEKDAYS = [0.7, 1.05, 1.1, 1.08, 1.02, 0.92, 0.66];

export const PRODUCTS = [
  ["ceramic-mug", 18],
  ["linen-apron", 34],
  ["oak-cutting-board", 46],
  ["enamel-kettle", 62],
  ["wool-throw", 89],
  ["copper-pan", 120],
] as const;
const BLOG_POSTS = [
  "/blog/how-we-pack-orders",
  "/blog/caring-for-cast-iron",
  "/blog/holiday-gift-guide",
];
const PLANS = [
  ["starter", 5],
  ["team", 3],
  ["business", 1],
] as const;
const REPORTS = ["sales", "inventory", "traffic", "customers"];

const END = "end";

/** Where a visitor goes from each page, by weight; product and blog pages are one kind each. */
const NEXT: Record<string, readonly (readonly [string, number])[]> = {
  "/": [
    ["/products", 4],
    ["/pricing", 2],
    ["/search", 1],
    ["/blog", 1],
    ["/about", 0.5],
    [END, 3],
  ],
  "/products": [
    ["/cart", 2],
    ["/products", 2],
    ["/", 1],
    [END, 3],
  ],
  "/cart": [
    ["/checkout", 5],
    ["/products", 1],
    [END, 2],
  ],
  "/checkout": [
    ["/checkout/complete", 6],
    [END, 3],
  ],
  "/checkout/complete": [[END, 1]],
  "/pricing": [
    ["/signup", 1.4],
    ["/", 1],
    [END, 3],
  ],
  "/signup": [
    ["/app/projects/new", 1.3],
    [END, 1],
  ],
  "/app/projects/new": [
    ["/app/projects", 4],
    [END, 1],
  ],
  "/app/projects": [[END, 1]],
  "/search": [
    ["/products", 3],
    [END, 2],
  ],
  "/blog": [
    ["/", 1.5],
    ["/products", 1.5],
    ["/pricing", 0.6],
    [END, 5],
  ],
  "/about": [
    ["/pricing", 1],
    ["/", 1],
    [END, 3],
  ],
};

interface Source {
  name: string;
  weight: number;
  referrer?: string;
  utm?: string;
  /** Where visits from it start. */
  entry: readonly (readonly [string, number])[];
  /** Only in the last days (a campaign that started then). */
  lastDays?: number;
}

const SEARCH_ENTRY = [
  ["/", 5],
  ["/products", 3.5],
  ["/blog", 1.5],
] as const;
const SOURCES: Source[] = [
  {
    name: "direct",
    weight: 28,
    entry: [
      ["/", 6],
      ["/pricing", 1.5],
      ["/products", 2.5],
    ],
  },
  { name: "google", weight: 26, referrer: "https://www.google.com/", entry: SEARCH_ENTRY },
  { name: "bing", weight: 4, referrer: "https://www.bing.com/", entry: SEARCH_ENTRY },
  { name: "duckduckgo", weight: 4, referrer: "https://duckduckgo.com/", entry: SEARCH_ENTRY },
  {
    name: "reddit",
    weight: 5,
    referrer: "https://www.reddit.com/r/Cooking/comments/1p2k3x9/finally_found_an_enamel_kettle/",
    entry: [["/products", 1]],
  },
  { name: "x", weight: 3, referrer: "https://t.co/", entry: [["/", 1]] },
  { name: "linkedin", weight: 2, referrer: "https://www.linkedin.com/", entry: [["/pricing", 1]] },
  {
    name: "hacker news",
    weight: 4,
    referrer: "https://news.ycombinator.com/item?id=46012345",
    entry: [["/blog/how-we-pack-orders", 1]],
  },
  {
    name: "a blog",
    weight: 3,
    referrer: "https://www.kitchenjournal.example/best-kitchen-shops-2026?ref=list",
    entry: [["/products", 1]],
  },
  {
    name: "product hunt",
    weight: 2,
    referrer: "https://www.producthunt.com/products/demo-shop",
    entry: [["/pricing", 1]],
  },
  {
    name: "newsletter",
    weight: 7,
    utm: "utm_source=newsletter&utm_medium=email&utm_campaign=november-picks",
    entry: [
      ["/products", 2],
      ["/", 1],
    ],
  },
  {
    name: "search ads",
    weight: 5,
    referrer: "https://www.google.com/",
    utm: "utm_source=google&utm_medium=cpc&utm_campaign=brand-search&utm_term=demo%20shop",
    entry: [["/", 1]],
  },
  {
    name: "instagram",
    weight: 9,
    referrer: "https://l.instagram.com/",
    utm: "utm_source=instagram&utm_medium=social&utm_campaign=black-friday-preview&utm_content=story",
    entry: [["/products", 1]],
    lastDays: 10,
  },
];

/** A page's path: a kind of page from NEXT made concrete. */
function concretePath(rng: Random, kind: string): string {
  if (kind === "/products") return `/products/${rng.pick(PRODUCTS)[0]}`;
  if (kind === "/blog") return rng.pick(BLOG_POSTS);
  if (kind === "/app/projects") return `/app/projects/p_${rng.int(1000, 9999)}`;
  return kind;
}

const kindOf = (path: string) =>
  path.startsWith("/products/")
    ? "/products"
    : path.startsWith("/blog/")
      ? "/blog"
      : path.startsWith("/app/projects/p_")
        ? "/app/projects"
        : path;

const engineOf = (client: Client): Engine =>
  client.browser === "Safari" ? "safari" : client.browser === "Firefox" ? "firefox" : "v8";

/** The demo's browser errors, each as a browser of its engine words and stacks it. */
const origin = `https://${SITE_HOST}`;
export const ERRORS = {
  /** New in the current release: a checkout without a shipping method chosen. Source-mapped. */
  checkout: (engine: Engine, release: string) => {
    const bundle = `${origin}${BUNDLES[release as keyof typeof BUNDLES] ?? BUNDLES[RELEASES.current]}`;
    return engine === "safari"
      ? {
          type: "TypeError",
          message: "undefined is not an object (evaluating 't.shipping.price')",
          stack: `a@${bundle}:1:${columns.shipping + 1}\no@${bundle}:1:${columns.orderTotal + 1}\ns@${bundle}:1:${columns.renderSummary + 1}`,
        }
      : {
          type: "TypeError",
          message: "Cannot read properties of undefined (reading 'price')",
          stack: `TypeError: Cannot read properties of undefined (reading 'price')\n    at a (${bundle}:1:${columns.shipping + 1})\n    at o (${bundle}:1:${columns.orderTotal + 1})\n    at HTMLButtonElement.s (${bundle}:1:${columns.renderSummary + 1})`,
        };
  },
  /** Seen before, resolved, and back after the current release: regressed. */
  orderDate: (release: string) => {
    const chunk = `${origin}/assets/orders-${release === RELEASES.current ? "Kd93pQ1z" : "3kD9aPq1"}.js`;
    return {
      type: "RangeError",
      message: "Invalid time value",
      stack: `RangeError: Invalid time value\n    at Date.toISOString (<anonymous>)\n    at formatOrderDate (${chunk}:1:812)\n    at Array.map (<anonymous>)\n    at renderOrders (${chunk}:1:1290)`,
    };
  },
  /** A search API answering HTML for a while, a month ago: resolved, not seen since. */
  searchJson: () => ({
    type: "SyntaxError",
    message: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    stack: `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON\n    at JSON.parse (<anonymous>)\n    at ${origin}/assets/search-Pz81Kd0w.js:1:2210`,
  }),
  /** Browser noise every site sees, without a stack. */
  resizeObserver: () => ({
    type: "Error",
    message: "ResizeObserver loop completed with undelivered notifications.",
  }),
  /** Caught by the site itself (captureError), so handled. */
  paymentDeclined: (release: string) => {
    const bundle = `${origin}${BUNDLES[release as keyof typeof BUNDLES] ?? BUNDLES[RELEASES.current]}`;
    return {
      type: "Error",
      message: "Payment declined: card_declined",
      stack: `Error: Payment declined: card_declined\n    at confirmPayment (${bundle}:1:${columns.renderSummary + 40})`,
    };
  },
};

/**
 * The minified bundle the source map describes (seed-data.ts uploads it),
 * on one line, and the columns of its three frames, from 0.
 */
export const MINIFIED =
  'function a(t){const n=t.shipping.price;return r(t.subtotal+n)}function o(t){const n=a(t);return"Total: "+n}function s(t,n){t.preventDefault(),document.querySelector("#summary").textContent=o(n)}';
const columns = {
  shipping: MINIFIED.indexOf("t.shipping.price"),
  orderTotal: MINIFIED.indexOf("a(t);"),
  renderSummary: MINIFIED.indexOf("o(n)}"),
};
export const FRAME_COLUMNS = columns;

export interface SiteData {
  events: Arrived[];
  /** The checkout errors that recorded a replay, newest last. */
  replayErrors: NewEvent[];
  users: number;
}

interface Context {
  rng: Random;
  projectId: string;
  now: Date;
  events: Arrived[];
  checkoutErrors: NewEvent[];
  dayOf: (moment: Date) => string;
  salts: Map<string, Buffer>;
  releaseAt: Date;
  /** When the search API's bug was fixed: its error stops. */
  searchFixedAt: Date;
  /** When the order date error was fixed (and resolved), until the current release brought it back. */
  ordersFixedAt: Date;
}

/** A day's salt: made from the day, so a rerun gives the same visitor IDs. */
function saltOf(context: Context, day: string): Buffer {
  let salt = context.salts.get(day);
  if (salt === undefined) {
    salt = createHmac("sha256", "ottertrail-development-seed").update(day).digest();
    context.salts.set(day, salt);
  }
  return salt;
}

function newPerson(rng: Random, deviceType?: keyof typeof USER_AGENTS): Person {
  const device =
    deviceType ??
    rng.weighted<keyof typeof USER_AGENTS>([
      ["mobile", 48],
      ["desktop", 47],
      ["tablet", 5],
    ]);
  const userAgent = rng.weighted(USER_AGENTS[device]);
  return {
    ip: `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
    userAgent,
    client: parseUserAgent(userAgent),
    location: rng.weighted(LOCATIONS),
  };
}

const releaseOf = (context: Context, at: Date, environment: string) =>
  environment === "staging"
    ? RELEASES.staging
    : at < context.releaseAt
      ? RELEASES.previous
      : RELEASES.current;

/** Adds one browser event, built as the collection endpoint builds it. */
function add(
  context: Context,
  person: Person,
  at: Date,
  input: {
    name: string;
    url: string;
    referrer?: string | undefined;
    properties?: Record<string, string | number | boolean | null>;
    userId?: string | undefined;
    environment: string;
    error?: { type: string; message: string; stack?: string; handled?: boolean };
  },
): NewEvent | null {
  if (at > context.now) return null;
  const pageUrl = parsePageUrl(input.url);
  if (pageUrl === null) throw new Error(`Not a page URL: ${input.url}`);
  const release = releaseOf(context, at, input.environment);
  const event: NewEvent = {
    eventId: context.rng.uuid(),
    name: input.name,
    occurredAt: at,
    path: pageUrl.path,
    referrer: cleanReferrer(input.referrer),
    utm: pageUrl.utm,
    ...(input.properties === undefined ? {} : { properties: { ...input.properties } }),
    client: person.client,
    location: person.location,
    environment: input.environment,
    release,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    ...(input.error === undefined
      ? {}
      : {
          error: {
            type: input.error.type,
            message: input.error.message,
            ...(input.error.stack === undefined ? {} : { stack: input.error.stack }),
            handled: input.error.handled === true,
            fingerprint: fingerprint(input.error),
          },
        }),
    visitorId: visitorId(
      saltOf(context, context.dayOf(at)),
      context.projectId,
      person.ip,
      person.userAgent,
    ),
  };
  if (event.name === VITALS && event.properties !== undefined) keepValidVitals(event.properties);
  context.events.push({
    event,
    receivedAt: new Date(at.getTime() + context.rng.int(400, 4000)),
  });
  return event;
}

/** A page load's Web Vitals: a phone's are noticeably slower than a computer's. */
function vitals(rng: Random, client: Client): Record<string, number> {
  const mobile = client.deviceType === "mobile";
  const tablet = client.deviceType === "tablet";
  const scale = mobile ? 1 : tablet ? 0.7 : 0.5;
  const values: Record<string, number> = {
    lcp: Math.round(rng.logNormal(3000 * scale, 0.38)),
    fcp: Math.round(rng.logNormal(1850 * scale, 0.35)),
    ttfb: Math.round(rng.logNormal(600 * scale, 0.4)),
    cls: Math.round(rng.logNormal(mobile ? 0.12 : tablet ? 0.07 : 0.035, 0.7) * 1000) / 1000,
  };
  // INP needs an interaction; some page loads have none.
  if (rng.chance(0.7))
    values.inp = Math.round(rng.logNormal(mobile ? 250 : tablet ? 170 : 105, 0.5));
  return values;
}

/**
 * One page: its pageview, its Web Vitals for some loads, and the time on
 * it; returns when the visitor leaves it.
 */
function page(
  context: Context,
  person: Person,
  at: Date,
  input: {
    url: string;
    referrer?: string | undefined;
    userId?: string | undefined;
    environment: string;
    dwellMs: number;
  },
): Date {
  const { rng } = context;
  add(context, person, at, {
    name: PAGEVIEW,
    url: input.url,
    referrer: input.referrer,
    userId: input.userId,
    environment: input.environment,
  });
  if (rng.chance(0.4)) {
    add(context, person, new Date(at.getTime() + input.dwellMs + 200), {
      name: VITALS,
      url: input.url,
      properties: vitals(rng, person.client),
      userId: input.userId,
      environment: input.environment,
    });
  }
  add(context, person, new Date(at.getTime() + input.dwellMs + 250), {
    name: ENGAGEMENT,
    url: input.url,
    properties: { engagedMs: Math.round(input.dwellMs * rng.int(60, 95) * 0.01) },
    userId: input.userId,
    environment: input.environment,
  });
  return new Date(at.getTime() + input.dwellMs + rng.int(800, 4000));
}

const dwell = (rng: Random, median = 35_000) =>
  Math.min(10 * MINUTE_MS, Math.max(2000, Math.round(rng.logNormal(median, 0.8))));

/** An error on a page, a moment after it loaded. */
function pageError(
  context: Context,
  person: Person,
  at: Date,
  url: string,
  environment: string,
  userId: string | undefined,
  error: { type: string; message: string; stack?: string; handled?: boolean },
): NewEvent | null {
  return add(context, person, at, { name: ERROR, url, environment, userId, error });
}

/** A known user: their browser, their plan, and how keen they are. */
interface KnownUser {
  id: string;
  person: Person;
  plan: string;
  signedUpAt: Date;
  keenness: number;
}

/**
 * One anonymous visit: pages from its source's entry, following NEXT, with
 * the product events along the way. A visitor who signs up becomes a known
 * user from then on, returned for their later visits.
 */
function visit(
  context: Context,
  person: Person,
  start: Date,
  environment: string,
  source: Source,
): KnownUser | null {
  const { rng } = context;
  const host = environment === "staging" ? STAGING_HOST : SITE_HOST;
  const entry = rng.weighted(source.entry);
  let path = entry in NEXT ? concretePath(rng, entry) : entry;
  let kind = kindOf(path);
  let at = start;
  let userId: string | undefined;
  let user: KnownUser | null = null;
  let plan = rng.weighted(PLANS);
  let cartItems = 0;
  let cartTotal = 0;
  for (let index = 0; index < 8; index += 1) {
    const first = index === 0;
    const url = `https://${host}${path}${first && source.utm !== undefined ? `?${source.utm}` : ""}`;
    const loadedAt = at;
    const stay = dwell(rng, path === "/checkout" ? 60_000 : 35_000);
    at = page(context, person, at, {
      url,
      referrer: first ? source.referrer : `https://${host}/`,
      userId,
      environment,
      dwellMs: stay,
    });

    // Errors on this page.
    const engine = engineOf(person.client);
    const release = releaseOf(context, loadedAt, environment);
    if (rng.chance(0.004) && engine === "v8") {
      pageError(
        context,
        person,
        new Date(loadedAt.getTime() + 1500),
        url,
        environment,
        userId,
        ERRORS.resizeObserver(),
      );
    }
    if (path === "/search" && loadedAt < context.searchFixedAt && rng.chance(0.3)) {
      pageError(
        context,
        person,
        new Date(loadedAt.getTime() + 900),
        url,
        environment,
        userId,
        ERRORS.searchJson(),
      );
      break;
    }

    let next = rng.weighted(NEXT[kind] ?? [[END, 1]]);
    const moment = (fraction: number) => new Date(loadedAt.getTime() + Math.round(stay * fraction));
    if (kind === "/products" && next === "/cart") {
      const [product, price] = rng.pick(PRODUCTS);
      cartItems += 1;
      cartTotal += price;
      add(context, person, moment(0.7), {
        name: "added_to_cart",
        url,
        properties: { product, price, currency: "EUR" },
        userId,
        environment,
      });
    }
    if (kind === "/cart" && next === "/checkout") {
      add(context, person, moment(0.8), {
        name: "checkout_started",
        url,
        properties: { items: Math.max(1, cartItems) },
        userId,
        environment,
      });
    }
    if (kind === "/checkout") {
      // The current release's bug: no shipping method chosen yet.
      if (release === RELEASES.current && engine !== "firefox" && rng.chance(0.22)) {
        const error = pageError(
          context,
          person,
          moment(0.6),
          url,
          environment,
          userId,
          ERRORS.checkout(engine, release),
        );
        if (error !== null) context.checkoutErrors.push(error);
        if (rng.chance(0.7)) break;
      }
      if (next === "/checkout/complete" && rng.chance(0.06)) {
        pageError(context, person, moment(0.9), url, environment, userId, {
          ...ERRORS.paymentDeclined(release),
          handled: true,
        });
        next = END;
      }
    }
    if (kind === "/pricing" && next === "/signup") {
      add(context, person, moment(0.85), {
        name: "signup_started",
        url,
        properties: { plan },
        environment,
      });
    }
    if (kind === "/signup" && next === "/app/projects/new" && environment === "production") {
      // Signed up: the site names the user from now on.
      const signedUpAt = moment(0.9);
      userId = `usr_${rng.int(10_000, 99_999)}`;
      plan = rng.weighted(PLANS);
      add(context, person, signedUpAt, {
        name: "signed_up",
        url,
        properties: {
          plan,
          method: rng.weighted([
            ["email", 3],
            ["google", 2],
          ]),
        },
        userId,
        environment,
      });
      user = { id: userId, person, plan, signedUpAt, keenness: rng.logNormal(1, 0.5) };
    }
    if (kind === "/app/projects/new" && next === "/app/projects" && userId !== undefined) {
      add(context, person, moment(0.8), {
        name: "project_created",
        url,
        properties: { template: rng.pick(["blank", "store", "wholesale"]) },
        userId,
        environment,
      });
    }
    if (next === "/checkout/complete" && kind === "/checkout") {
      add(context, person, moment(0.95), {
        name: "checkout_completed",
        url,
        properties: {
          amount: Math.max(18, cartTotal),
          currency: "EUR",
          items: Math.max(1, cartItems),
        },
        userId,
        environment,
      });
    }
    if (next === END) break;
    kind = next;
    path = concretePath(rng, kind);
  }
  return user;
}

/** A signed-in session in the app: reports, projects, invitations, and the order history page. */
function appSession(context: Context, user: KnownUser, start: Date, spike = false) {
  const { rng } = context;
  const userId = user.id;
  const environment = "production";
  let at = start;
  // A spike: straight to the order list, which breaks.
  const pages = spike ? 1 : rng.int(2, 6);
  for (let index = 0; index < pages; index += 1) {
    const choice = spike
      ? "/account/orders"
      : index === 0
        ? "/app"
        : rng.weighted([
            ["/app/projects", 3],
            ["/app/reports", 4],
            ["/account/orders", 1.2],
            ["/app/settings/team", 0.6],
          ] as const);
    const path =
      choice === "/app/projects"
        ? `/app/projects/p_${rng.int(1000, 9999)}`
        : choice === "/app/reports"
          ? `/app/reports/${rng.pick(REPORTS)}`
          : choice;
    const url = `https://${SITE_HOST}${path}`;
    const loadedAt = at;
    const stay = dwell(rng, 50_000);
    at = page(context, user.person, at, { url, userId, environment, dwellMs: stay });
    const moment = (fraction: number) => new Date(loadedAt.getTime() + Math.round(stay * fraction));
    if (choice === "/app/reports") {
      add(context, user.person, moment(0.3), {
        name: "report_viewed",
        url,
        properties: { report: path.slice("/app/reports/".length) },
        userId,
        environment,
      });
      if (rng.chance(0.15)) {
        add(context, user.person, moment(0.8), {
          name: "export_downloaded",
          url,
          properties: { format: rng.pick(["csv", "csv", "xlsx"]) },
          userId,
          environment,
        });
      }
    }
    if (choice === "/app/projects" && rng.chance(0.12)) {
      add(context, user.person, moment(0.5), {
        name: "project_created",
        url,
        properties: { template: rng.pick(["blank", "store", "wholesale"]) },
        userId,
        environment,
      });
    }
    if (choice === "/app/settings/team" && rng.chance(0.5)) {
      add(context, user.person, moment(0.6), {
        name: "invite_sent",
        url,
        properties: { role: rng.pick(["admin", "member", "member"]) },
        userId,
        environment,
      });
    }
    if (choice === "/account/orders") {
      // An order without a date breaks the list: fixed, then back with the current release.
      const broken = loadedAt < context.ordersFixedAt || loadedAt >= context.releaseAt;
      if (spike || (broken && rng.chance(0.35))) {
        const release = releaseOf(context, loadedAt, environment);
        pageError(
          context,
          user.person,
          moment(0.2),
          url,
          environment,
          userId,
          ERRORS.orderDate(release),
        );
      }
    }
  }
}

/** How likely a user is to come back on a day, from how long ago they signed up. */
const activeChance = (user: KnownUser, daysSince: number) =>
  Math.min(0.9, user.keenness * (daysSince < 3 ? 0.35 : 0.04 + 0.13 * Math.exp(-daysSince / 30)));

/** A moment on a day (its UTC midnight), by the shop's hours. */
function momentOn(rng: Random, dayStart: number): Date {
  const hour = rng.weighted(HOURS);
  return new Date(dayStart + hour * 3_600_000 + rng.int(0, 3_599_999));
}

/**
 * Everything the shop's browsers sent: TRAFFIC_DAYS of visits, and the
 * signed-in users' sessions over USER_DAYS, up to `now`.
 */
export function buildSite(rng: Random, projectId: string, timeZone: string, now: Date): SiteData {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const context: Context = {
    rng,
    projectId,
    now,
    events: [],
    checkoutErrors: [],
    dayOf: dayIn(timeZone),
    salts: new Map(),
    releaseAt: new Date(today - RELEASE_DAYS_AGO * DAY_MS + 10 * 3_600_000),
    searchFixedAt: new Date(today - 19 * DAY_MS + 15 * 3_600_000),
    ordersFixedAt: new Date(today - 15 * DAY_MS + 11 * 3_600_000),
  };

  // Users who signed up before the traffic shown: only their signed-in activity is kept.
  const users: KnownUser[] = [];
  for (let index = 0; index < 70; index += 1) {
    const person = newPerson(rng);
    const signedUpAt = momentOn(rng, today - rng.int(TRAFFIC_DAYS + 1, USER_DAYS) * DAY_MS);
    const user: KnownUser = {
      id: `usr_${rng.int(10_000, 99_999)}`,
      person,
      plan: rng.weighted(PLANS),
      signedUpAt,
      keenness: rng.logNormal(1, 0.5),
    };
    const url = `https://${SITE_HOST}/signup`;
    add(context, person, signedUpAt, {
      name: "signed_up",
      url,
      properties: {
        plan: user.plan,
        method: rng.weighted([
          ["email", 3],
          ["google", 2],
        ]),
      },
      userId: user.id,
      environment: "production",
    });
    add(context, person, new Date(signedUpAt.getTime() + 90_000), {
      name: "project_created",
      url: `https://${SITE_HOST}/app/projects/new`,
      properties: { template: rng.pick(["blank", "store", "wholesale"]) },
      userId: user.id,
      environment: "production",
    });
    users.push(user);
  }

  // Anonymous visits, day by day; some sign up and join the users.
  for (let daysAgo = TRAFFIC_DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
    const dayStart = today - daysAgo * DAY_MS;
    const weekday = WEEKDAYS[new Date(dayStart).getUTCDay()] ?? 1;
    const growth = 1 + (0.15 * (TRAFFIC_DAYS - 1 - daysAgo)) / (TRAFFIC_DAYS - 1);
    const visits = Math.round(190 * weekday * growth * rng.normal(1, 0.06));
    const sources = SOURCES.filter(
      (source) => source.lastDays === undefined || daysAgo < source.lastDays,
    );
    const sameDay: Person[] = [];
    for (let index = 0; index < visits; index += 1) {
      const returning = sameDay.length > 0 && rng.chance(0.08);
      const person = returning ? rng.pick(sameDay) : newPerson(rng);
      if (!returning) sameDay.push(person);
      const start = momentOn(rng, dayStart);
      const staging = rng.chance(0.03);
      const source = staging
        ? { name: "direct", weight: 1, entry: [["/", 1]] as const }
        : rng.weighted(sources.map((item) => [item, item.weight] as const));
      const user = visit(context, person, start, staging ? "staging" : "production", source);
      if (user !== null) users.push(user);
    }
  }

  // Each user's later sessions, signed in.
  const lastDay = today;
  for (const user of users) {
    const firstDay = Date.UTC(
      user.signedUpAt.getUTCFullYear(),
      user.signedUpAt.getUTCMonth(),
      user.signedUpAt.getUTCDate(),
    );
    for (let dayStart = firstDay + DAY_MS; dayStart <= lastDay; dayStart += DAY_MS) {
      if (!rng.chance(activeChance(user, (dayStart - firstDay) / DAY_MS))) continue;
      appSession(context, user, momentOn(rng, dayStart));
    }
  }

  // A burst of the order list's error, the day after it came back: an error spike.
  const burst = new Date(today - (RELEASE_DAYS_AGO - 1) * DAY_MS + 14 * 3_600_000);
  if (burst < now) {
    for (let index = 0; index < 40; index += 1) {
      const user = rng.pick(users);
      appSession(context, user, new Date(burst.getTime() + rng.int(0, 7 * MINUTE_MS)), true);
    }
  }

  context.events.sort((a, b) => a.event.occurredAt.getTime() - b.event.occurredAt.getTime());
  return {
    events: context.events,
    replayErrors: context.checkoutErrors.filter((error) => error.environment === "production"),
    users: users.length,
  };
}
