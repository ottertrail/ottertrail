/**
 * Request tracing (docs/web-analytics.md, "Traces"), in n.js: a W3C
 * traceparent header on the page's requests to its own origin and the
 * origins the snippet lists, and the last few of them for errors. Nothing
 * about a request leaves the browser but what an error carries: its method,
 * path, status, duration, and trace ID.
 */
import { parseTraceparent, type TracedRequest, type TracesConfig } from "./traces.ts";
import { MAX_PATH_LENGTH } from "./url.ts";

/** Requests an error carries, the latest ones. */
export const MAX_REQUESTS = 5;
/** As the API takes them: an hour at most. */
export const MAX_DURATION_MS = 3_600_000;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A new traceparent for one request: a random trace ID, and as the parent,
 * the browser's request, which is never sent as a span, the trace ID's
 * first 16 digits. The server's span under it is then a root: the API
 * lists traces by their roots and spots this parent (docs/telemetry.md).
 * Flags 01: sampled.
 */
export function newTraceparent(random: (size: number) => Uint8Array): {
  header: string;
  traceId: string;
} {
  const bytes = random(16);
  // Neither the trace ID nor its first half may be all zeros.
  bytes[0] = (bytes[0] ?? 0) | 1;
  const traceId = hex(bytes);
  return { header: `00-${traceId}-${traceId.slice(0, 16)}-01`, traceId };
}

/**
 * The allowed origins: the page's own, and those of the list (separated by
 * spaces or commas). `invalid` when an entry is not an http(s) origin, such
 * as one with a path: it is left out.
 */
export function tracedOrigins(
  own: string,
  list: string | undefined,
): { origins: Set<string>; invalid: boolean } {
  const origins = new Set([own]);
  let invalid = false;
  for (const entry of (list ?? "").split(/[\s,]+/)) {
    if (entry === "") continue;
    try {
      const url = new URL(entry);
      if (/^https?:$/.test(url.protocol) && url.href === `${url.origin}/`) {
        origins.add(url.origin);
        continue;
      }
    } catch {
      // Not a URL.
    }
    invalid = true;
  }
  return { origins, invalid };
}

interface XhrState {
  method: string;
  url: URL | undefined;
  /** The page set its own traceparent: it is kept. */
  own: string | undefined;
}

export interface RequestTracingOptions {
  /** The page's window, or a stand-in in tests: fetch and XMLHttpRequest are wrapped on it. */
  target: { fetch?: unknown; XMLHttpRequest?: unknown };
  /** The page's address, to resolve relative URLs. */
  base: () => string;
  origins: Set<string>;
  /** Whether the current page view's requests get the header (data-traces-sample). */
  sampled: () => boolean;
  /** The tracker's own endpoints, which never get the header and are never kept. */
  skip: (url: URL) => boolean;
  /** `size` random bytes. */
  random: (size: number) => Uint8Array;
  now: () => number;
}

/**
 * Wraps fetch and XMLHttpRequest. A request to an allowed origin, in a
 * sampled page view, gets a traceparent header unless the page set one; it
 * is kept, without its query string, headers, or body, among the last
 * MAX_REQUESTS for the errors that follow. Returns those requests.
 */
export function traceRequests(options: RequestTracingOptions): () => TracedRequest[] {
  const recent: TracedRequest[] = [];
  const keep = (request: TracedRequest) => {
    recent.push(request);
    if (recent.length > MAX_REQUESTS) recent.shift();
  };

  /** The trace a request to `url` carries, or undefined when it carries none of the tracker's concern. */
  const plan = (url: URL | undefined, own: string | null | undefined) => {
    if (url === undefined || !options.origins.has(url.origin) || options.skip(url))
      return undefined;
    if (own !== null && own !== undefined) {
      // The page's own header stays; its trace is kept when it is one.
      const trace = parseTraceparent(own);
      return trace === undefined ? undefined : { header: undefined, traceId: trace.traceId };
    }
    if (!options.sampled()) return undefined;
    return newTraceparent(options.random);
  };

  const finish = (method: string, url: URL, traceId: string, started: number, status: number) => {
    keep({
      method: method.toUpperCase().slice(0, 16),
      path: url.pathname.slice(0, MAX_PATH_LENGTH),
      status: status >= 0 && status <= 999 ? status : 0,
      durationMs: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(options.now() - started))),
      traceId,
    });
  };

  const resolve = (value: unknown): URL | undefined => {
    try {
      return new URL(String(value), options.base());
    } catch {
      return undefined;
    }
  };

  const { target } = options;
  const originalFetch = target.fetch;
  if (typeof originalFetch === "function") {
    target.fetch = function (this: unknown, input: unknown, init?: RequestInit) {
      let traced: { method: string; url: URL; traceId: string; started: number } | undefined;
      let args: unknown[] = [input, init];
      try {
        const request =
          typeof Request === "function" && input instanceof Request ? input : undefined;
        const url = resolve(request === undefined ? input : request.url);
        const headers = new Headers(init?.headers ?? request?.headers);
        const trace = plan(url, headers.get("traceparent"));
        if (url !== undefined && trace !== undefined) {
          if (trace.header !== undefined) {
            headers.set("traceparent", trace.header);
            args = [input, { ...init, headers }];
          }
          traced = {
            method: init?.method ?? request?.method ?? "GET",
            url,
            traceId: trace.traceId,
            started: options.now(),
          };
        }
      } catch {
        // The request goes as the page made it.
        args = [input, init];
        traced = undefined;
      }
      const result: unknown = Reflect.apply(originalFetch, this, args);
      if (traced !== undefined && result instanceof Promise) {
        const { method, url, traceId, started } = traced;
        result.then(
          (response: { status?: unknown }) =>
            finish(method, url, traceId, started, Number(response.status) || 0),
          () => finish(method, url, traceId, started, 0),
        );
      }
      return result;
    };
  }

  const prototype: unknown =
    typeof target.XMLHttpRequest === "function" ? target.XMLHttpRequest.prototype : undefined;
  const open: unknown = Reflect.get(Object(prototype), "open");
  const setHeader: unknown = Reflect.get(Object(prototype), "setRequestHeader");
  const send: unknown = Reflect.get(Object(prototype), "send");
  if (
    typeof prototype === "object" &&
    prototype !== null &&
    typeof open === "function" &&
    typeof setHeader === "function" &&
    typeof send === "function"
  ) {
    const states = new WeakMap<object, XhrState>();
    Object.assign(prototype, {
      open(this: XMLHttpRequest, ...args: unknown[]) {
        states.set(this, { method: String(args[0]), url: resolve(args[1]), own: undefined });
        Reflect.apply(open, this, args);
      },
      setRequestHeader(this: XMLHttpRequest, name: unknown, value: unknown) {
        const state = states.get(this);
        if (state !== undefined && String(name).toLowerCase() === "traceparent") {
          state.own = String(value);
        }
        Reflect.apply(setHeader, this, [name, value]);
      },
      send(this: XMLHttpRequest, ...args: unknown[]) {
        try {
          const state = states.get(this);
          const trace = state === undefined ? undefined : plan(state.url, state.own);
          if (state?.url !== undefined && trace !== undefined) {
            if (trace.header !== undefined) {
              Reflect.apply(setHeader, this, ["traceparent", trace.header]);
            }
            const { method, url } = state;
            const started = options.now();
            this.addEventListener("loadend", () => {
              finish(method, url, trace.traceId, started, this.status);
            });
          }
        } catch {
          // The request goes as the page made it.
        }
        Reflect.apply(send, this, args);
      },
    });
  }

  return () => recent.map((request) => ({ ...request }));
}

/**
 * n.js's start: wraps the page's fetch and XMLHttpRequest on `target` and
 * hands the tracker the requests it keeps. Never throws.
 */
export function startRequestTracing(
  config: TracesConfig,
  target: RequestTracingOptions["target"] & { location: { href: string } },
  crypto: { getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array },
  now: () => number,
): void {
  try {
    const { origins, invalid } = tracedOrigins(
      new URL(target.location.href).origin,
      config.origins,
    );
    if (invalid) {
      console.warn(
        "Ottertrail: data-traces-origins takes origins such as https://api.example.com. Other entries are ignored.",
      );
    }
    config.register(
      traceRequests({
        target,
        base: () => target.location.href,
        origins,
        sampled: config.sampled,
        skip: (url) => url.href.startsWith(config.skip),
        random: (size) => crypto.getRandomValues(new Uint8Array(size)),
        now,
      }),
    );
  } catch {
    // Never break the page the tracker runs on.
  }
}
