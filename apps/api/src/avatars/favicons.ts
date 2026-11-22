import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import {
  type AddressPolicy,
  addressPolicy,
  type Lookup,
  resolveTarget,
  systemLookup,
} from "../outbound/addresses.ts";
import { pinnedRequest, untilAborted } from "../outbound/request.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { OTTERTRAIL_VERSION } from "../version.ts";
import { newFaviconKey } from "./avatars.ts";
import { CONTENT_TYPES, faviconKind, type ImageKind } from "./images.ts";

/**
 * A project's default icon: its first allowed site's favicon (docs/dashboard.md,
 * "Avatars"), fetched by the worker, never by viewers' browsers, so no
 * dashboard page asks another site for anything. The requests follow the
 * outbound address rules (outbound/) with private addresses always
 * refused (faviconPolicy), pinned to the checked address, with every
 * redirect checked again, all within one 10-second budget.
 *
 * The worker reads the site's home page (512 KiB at most; links are
 * looked for in its first 64 KiB, up to `</head>`), takes the best
 * `<link rel="icon" | "shortcut icon" | "apple-touch-icon">` (an Apple
 * touch icon first, then the largest PNG, then the others), and falls back
 * to /favicon.ico. An icon is kept only when its bytes are a PNG (at most
 * 1024×1024 by what it declares), ICO, JPEG, WebP, or GIF (each held to
 * the same size), at most 256 KiB: never SVG. A
 * failure leaves the initial, is logged, and is tried again next week, or
 * when the project's first site changes.
 */

export const MAX_PAGE_BYTES = 512 * 1024;
export const MAX_FAVICON_BYTES = 256 * 1024;
/**
 * One budget for a whole fetchFavicon: the page and every icon tried
 * after it, redirects, DNS, and bodies included.
 */
export const FAVICON_TIMEOUT_MS = 10_000;
/** How much of the page is searched for icon links: they are in its head. */
export const MAX_SCANNED_HTML = 64 * 1024;
export const MAX_FAVICON_REDIRECTS = 3;
/** Links tried from the page, before /favicon.ico. */
const MAX_CANDIDATES = 3;
/** How often a project's favicon is fetched again. */
export const FAVICON_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the worker looks for projects due. */
export const FAVICON_TICK_MS = 60_000;
/** Projects fetched per look. */
const BATCH = 5;

const USER_AGENT = `Ottertrail/${OTTERTRAIL_VERSION} (favicons)`;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class FaviconError extends Error {
  override name = "FaviconError";
}

export interface FetchOptions {
  policy: AddressPolicy;
  lookup?: Lookup | undefined;
  /** Certificates to trust besides the system's (tests). */
  ca?: string | Buffer | undefined;
  timeoutMs?: number;
}

/** Reads at most `limit` bytes; null when the body is longer. */
function readCapped(response: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    response.once("error", reject);
    response.once("aborted", () => reject(new FaviconError("The answer was cut off.")));
  });
}

/**
 * GETs `start` through the address rules, following at most
 * MAX_FAVICON_REDIRECTS redirects to http(s) addresses, each checked
 * again. Answers the final URL and the body, or null for a non-2xx answer
 * or a body over `limit`.
 */
async function guardedGet(
  start: URL,
  accept: string,
  limit: number,
  { policy, lookup = systemLookup, ca }: FetchOptions,
  signal: AbortSignal,
): Promise<{ url: URL; body: Uint8Array; contentType: string } | null> {
  let url = start;
  for (let redirects = 0; ; redirects += 1) {
    const target = await untilAborted(
      resolveTarget(url, { lookup, policy, signal, who: "favicons" }),
      signal,
    );
    const { response } = await pinnedRequest(url, {
      method: "GET",
      target,
      signal,
      headers: { "user-agent": USER_AGENT, accept },
      ca,
    });
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (REDIRECTS.has(status) && location !== undefined) {
      response.destroy();
      const next = URL.parse(location, url);
      if (
        redirects >= MAX_FAVICON_REDIRECTS ||
        next === null ||
        (next.protocol !== "http:" && next.protocol !== "https:")
      ) {
        return null;
      }
      url = next;
      continue;
    }
    if (status < 200 || status > 299) {
      response.destroy();
      return null;
    }
    const body = await untilAborted(readCapped(response, limit), signal);
    return body === null
      ? null
      : { url, body, contentType: response.headers["content-type"] ?? "" };
  }
}

const isSpace = (char: string) =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

/**
 * A tag's attributes, by lower-case name, from the text between its name
 * and its `>`: one pass, each character read once, so no page can make
 * it slow.
 */
function attributesOf(body: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const end = body.length;
  let at = 0;
  while (at < end) {
    while (at < end && (isSpace(body[at] ?? "") || body[at] === "/")) at += 1;
    const nameStart = at;
    while (at < end && !isSpace(body[at] ?? "") && body[at] !== "=" && body[at] !== "/") at += 1;
    const name = body.slice(nameStart, at).toLowerCase();
    while (at < end && isSpace(body[at] ?? "")) at += 1;
    let value = "";
    if (body[at] === "=") {
      at += 1;
      while (at < end && isSpace(body[at] ?? "")) at += 1;
      const quote = body[at];
      if (quote === '"' || quote === "'") {
        const close = body.indexOf(quote, at + 1);
        const stop = close === -1 ? end : close;
        value = body.slice(at + 1, stop);
        at = stop + 1;
      } else {
        const valueStart = at;
        while (at < end && !isSpace(body[at] ?? "")) at += 1;
        value = body.slice(valueStart, at);
      }
    } else if (at === nameStart) {
      // Neither a name nor a value here: step past the character.
      at += 1;
    }
    if (name !== "" && !attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/**
 * The page's `<link>` and `<base>` tags, in order, each as its name and
 * attributes: the first MAX_SCANNED_HTML characters only, up to
 * `</head>`. A linear scan with indexOf, never a regular expression over
 * the page: a page of `<link<link<link…` without `>` costs one pass.
 */
function headTagsOf(html: string): { name: "link" | "base"; attributes: Map<string, string> }[] {
  const text = html.slice(0, MAX_SCANNED_HTML);
  const lower = text.toLowerCase();
  const headEnd = lower.indexOf("</head>");
  const limit = headEnd === -1 ? lower.length : headEnd;
  const tags: { name: "link" | "base"; attributes: Map<string, string> }[] = [];
  let at = 0;
  while (at < limit) {
    const open = lower.indexOf("<", at);
    if (open === -1 || open >= limit) break;
    const name = lower.startsWith("<link", open)
      ? "link"
      : lower.startsWith("<base", open)
        ? "base"
        : null;
    const after = lower.charAt(open + 5);
    if (name === null || !(isSpace(after) || after === "/" || after === ">")) {
      at = open + 1;
      continue;
    }
    const close = lower.indexOf(">", open + 5);
    // A tag that never ends: nothing after it is a tag either.
    if (close === -1 || close > limit) break;
    tags.push({ name, attributes: attributesOf(text.slice(open + 5, close)) });
    at = close + 1;
  }
  return tags;
}

/** The few character references an href holds. */
const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2f;|&#47;/gi, "/");

/** The largest side a `sizes` attribute names; 0 for none or "any". */
function largestSize(sizes: string): number {
  let largest = 0;
  for (const size of sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (match !== null) largest = Math.max(largest, Number(match[1]), Number(match[2]));
  }
  return largest;
}

/**
 * The icons a page links to, best first, as absolute http(s) URLs: Apple
 * touch icons, then PNG icons by size, then the other icons. SVG icons
 * are left out. Relative addresses resolve against the page's URL (or its
 * `<base href>`).
 */
export function iconLinksOf(html: string, pageUrl: URL): URL[] {
  const tags = headTagsOf(html);
  const baseHref = tags.find((tag) => tag.name === "base")?.attributes.get("href");
  const base =
    (baseHref === undefined ? null : URL.parse(decodeEntities(baseHref), pageUrl)) ?? pageUrl;
  const found: { url: URL; rank: number; size: number; order: number }[] = [];
  for (const { name, attributes } of tags) {
    if (name !== "link") continue;
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const touch = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!touch && !rel.includes("icon")) continue;
    const href = attributes.get("href")?.trim();
    if (href === undefined || href === "") continue;
    const url = URL.parse(decodeEntities(href), base);
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) continue;
    const type = (attributes.get("type") ?? "").toLowerCase();
    const path = url.pathname.toLowerCase();
    if (type.includes("svg") || path.endsWith(".svg")) continue;
    const png = type === "image/png" || path.endsWith(".png");
    url.hash = "";
    found.push({
      url,
      rank: touch ? 0 : png ? 1 : 2,
      size: largestSize(attributes.get("sizes") ?? ""),
      order: found.length,
    });
  }
  found.sort((a, b) => a.rank - b.rank || b.size - a.size || a.order - b.order);
  const unique = new Map<string, URL>();
  for (const { url } of found) if (!unique.has(url.href)) unique.set(url.href, url);
  return [...unique.values()];
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

export type FetchedFavicon = { bytes: Uint8Array; kind: ImageKind; url: URL };

/**
 * The site's favicon at `site` (its home page's URL), or why there is
 * none. Never throws: a refused address, a timeout, and a bad image are
 * all "none" with a reason, for the log.
 */
export async function fetchFavicon(
  site: URL,
  options: FetchOptions,
): Promise<{ ok: true; favicon: FetchedFavicon } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new FaviconError("timed out")),
    options.timeoutMs ?? FAVICON_TIMEOUT_MS,
  );
  const { signal } = controller;
  try {
    let page: Awaited<ReturnType<typeof guardedGet>> = null;
    let pageError: unknown = null;
    try {
      page = await guardedGet(site, "text/html", MAX_PAGE_BYTES, options, signal);
    } catch (error) {
      pageError = error;
    }
    const pageUrl = page?.url ?? site;
    const links =
      page !== null && /html/i.test(page.contentType)
        ? iconLinksOf(new TextDecoder().decode(page.body), pageUrl)
        : [];
    const fallback = new URL("/favicon.ico", pageUrl);
    const candidates = [...links.slice(0, MAX_CANDIDATES), fallback].filter(
      (url, index, all) => all.findIndex((other) => other.href === url.href) === index,
    );
    let lastReason =
      pageError === null ? "no icon was found" : `the page failed: ${reasonOf(pageError)}`;
    for (const candidate of candidates) {
      if (signal.aborted) break;
      try {
        const got = await guardedGet(candidate, "image/*", MAX_FAVICON_BYTES, options, signal);
        if (got === null) {
          lastReason = `${candidate.href} answered no image of at most 256 KiB`;
          continue;
        }
        const kind = faviconKind(got.body);
        if (kind === null) {
          lastReason = `${candidate.href} is not a PNG, ICO, JPEG, WebP, or GIF`;
          continue;
        }
        return { ok: true, favicon: { bytes: got.body, kind, url: got.url } };
      } catch (error) {
        lastReason = `${candidate.href} failed: ${reasonOf(error)}`;
      }
    }
    return { ok: false, reason: signal.aborted ? "timed out" : lastReason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The address rules favicon requests follow: the uptime checks' deny list
 * and the metadata services, and never a private, loopback, or other
 * internal address, whatever UPTIME_ALLOW_PRIVATE_ADDRESSES says. A
 * project's sites are public; that setting is for checks of the
 * instance's own network.
 */
export function faviconPolicy(config: {
  /** Ignored here: it lets checks, not favicons, reach private addresses. */
  uptimeAllowPrivateAddresses?: boolean;
  uptimeDenyAddresses: readonly string[];
}): AddressPolicy {
  return addressPolicy({ allowPrivate: false, deny: config.uptimeDenyAddresses });
}

export interface FaviconLog {
  (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}

/**
 * The worker's favicon job: every FAVICON_TICK_MS, a few projects whose
 * favicon is due (never tried, tried a week ago, or their first allowed
 * site changed) are taken, marked as tried in the same statement (so two
 * workers never take one), and fetched.
 */
export class FaviconJob {
  readonly #db: Kysely<Database>;
  readonly #store: ObjectStore | null;
  readonly #options: FetchOptions;
  readonly #log: FaviconLog;
  readonly #now: () => Date;
  /** The site's URL for a hostname: https, except in tests. */
  readonly #siteOf: (hostname: string) => URL;

  constructor({
    db,
    store,
    log,
    now = () => new Date(),
    siteOf = (hostname) => new URL(`https://${hostname}/`),
    ...options
  }: FetchOptions & {
    db: Kysely<Database>;
    store: ObjectStore | null;
    log: FaviconLog;
    now?: () => Date;
    siteOf?: (hostname: string) => URL;
  }) {
    this.#db = db;
    this.#store = store;
    this.#options = options;
    this.#log = log;
    this.#now = now;
    this.#siteOf = siteOf;
  }

  /** Takes the projects due and fetches each; how many were fetched and kept. */
  async tick(): Promise<{ tried: number; kept: number }> {
    const store = this.#store;
    // Without an object store, favicons are off: the initial stays.
    if (store === null) return { tried: 0, kept: 0 };
    const now = this.#now();
    const before = new Date(now.getTime() - FAVICON_REFRESH_MS);
    const { rows } = await sql<{
      id: string;
      hostname: string | null;
      previous: string | null;
      faviconKey: string | null;
    }>`
      with due as (
        select id, favicon_hostname as previous
        from projects
        where favicon_checked_at is null
           or favicon_checked_at < ${before}
           or favicon_hostname is distinct from allowed_hostnames[1]
        order by favicon_checked_at nulls first, id
        limit ${BATCH}
        for update skip locked
      )
      update projects p
      set favicon_checked_at = ${now}, favicon_hostname = p.allowed_hostnames[1]
      from due
      where p.id = due.id
      returning p.id, p.favicon_hostname as hostname, due.previous, p.favicon_key as "faviconKey"
    `.execute(this.#db);
    let kept = 0;
    for (const project of rows) {
      // One project's failure (the database, the store) leaves the others to run.
      try {
        if (await this.#fetchFor(store, project)) kept += 1;
      } catch (error) {
        this.#log("warn", "fetching a project's favicon failed; it is tried again next week", {
          project: project.id,
          err: reasonOf(error),
        });
      }
    }
    return { tried: rows.length, kept };
  }

  async #fetchFor(
    store: ObjectStore,
    project: {
      id: string;
      hostname: string | null;
      previous: string | null;
      faviconKey: string | null;
    },
  ): Promise<boolean> {
    const { id, hostname, previous, faviconKey } = project;
    const result =
      hostname === null
        ? ({ ok: false, reason: "the project has no allowed site" } as const)
        : await fetchFavicon(this.#siteOf(hostname), this.#options);
    if (!result.ok) {
      this.#log("info", "no favicon for a project; it shows its initial", {
        project: id,
        hostname,
        reason: result.reason,
      });
      // Another site's favicon would be wrong: the old one goes. The same
      // site's stays until a fetch succeeds.
      if (faviconKey !== null && previous !== hostname) {
        await this.#replace(store, id, hostname, faviconKey, null);
      }
      return false;
    }
    const { bytes, kind } = result.favicon;
    const key = newFaviconKey(id, kind);
    try {
      await store.put(key, bytes, CONTENT_TYPES[kind]);
    } catch (error) {
      this.#log("warn", "the object store refused a favicon; it is tried again next week", {
        project: id,
        err: String(error),
      });
      // The site changed: the old site's favicon goes, as when its fetch fails.
      if (faviconKey !== null && previous !== hostname) {
        await this.#replace(store, id, hostname, faviconKey, null);
      }
      return false;
    }
    return this.#replace(store, id, hostname, faviconKey, key);
  }

  /** Points the project at `key` (null for none) while its site is still `hostname`, then deletes the old object. */
  async #replace(
    store: ObjectStore,
    id: string,
    hostname: string | null,
    old: string | null,
    key: string | null,
  ): Promise<boolean> {
    const updated = await this.#db
      .updateTable("projects")
      .set({ favicon_key: key })
      .where("id", "=", id)
      .where((eb) =>
        hostname === null
          ? eb("favicon_hostname", "is", null)
          : eb("favicon_hostname", "=", hostname),
      )
      .returning("id")
      .executeTakeFirst();
    // Deleted, or its site changed meanwhile: the new one is not used.
    const unused = updated === undefined ? key : old;
    if (unused !== null) {
      try {
        await store.delete([unused]);
      } catch (error) {
        this.#log("warn", "could not delete a replaced favicon; it stays stored", {
          project: id,
          err: String(error),
        });
      }
    }
    return updated !== undefined && key !== null;
  }
}
