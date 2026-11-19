import type { Random } from "./seed-random.ts";
/**
 * The demo shop's servers, for the development seed (seed-data.ts): what
 * three services (web, billing, worker) and an OpenTelemetry Collector on
 * three hosts would export over OTLP, as OTLP/JSON requests. seed-data.ts
 * hands each to the API's own normalizers (telemetry/normalize.ts), as the
 * OTLP routes do, so spans, logs, metrics, and the exceptions that become
 * error events are the rows real exporters make.
 */
import { DAY_MS, RELEASE_DAYS_AGO, RELEASES } from "./seed-site.ts";

/** Days of traces and logs, and of metrics. */
export const TRACE_DAYS = 14;
export const METRIC_DAYS = 7;
const APP_METRIC_STEP_MS = 10 * 60_000;
const HOST_METRIC_STEP_MS = 15 * 60_000;
/**
 * The hosts' points from the last 15-minute tick to now, at most this far
 * apart: the Hosts list takes CPU from the last two points within 15
 * minutes of a host's last one (docs/telemetry.md, "Hosts"), which needs
 * 7.5 minutes or less between points.
 */
export const HOST_RECENT_STEP_MS = 5 * 60_000;

const SERVER = 2;
const CLIENT = 3;
const CONSUMER = 5;
const INTERNAL = 1;
const ERROR = 2;
const CUMULATIVE = 2;

type Value = string | number | boolean;

/** OTLP attributes from plain values: whole numbers as int, others as double. */
function attributes(values: Record<string, Value | undefined>) {
  return Object.entries(values).flatMap(([key, value]) =>
    value === undefined
      ? []
      : [
          {
            key,
            value:
              typeof value === "string"
                ? { stringValue: value }
                : typeof value === "boolean"
                  ? { boolValue: value }
                  : Number.isInteger(value)
                    ? { intValue: String(value) }
                    : { doubleValue: value },
          },
        ],
  );
}

/** Milliseconds since 1970 (with fractions) as OTLP's nanoseconds, in text. */
const nanos = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n);

interface Resource {
  key: string;
  attributes: Record<string, Value>;
}

function service(name: string, version: string, host: string, language: string): Resource {
  return {
    key: `${name} ${version} ${host}`,
    attributes: {
      "service.name": name,
      "service.version": version,
      "service.namespace": "demo-shop",
      "deployment.environment.name": "production",
      "host.name": host,
      "telemetry.sdk.language": language,
      "telemetry.sdk.name": "opentelemetry",
    },
  };
}

const SCOPES = {
  http: { name: "@opentelemetry/instrumentation-http", version: "0.208.0" },
  undici: { name: "@opentelemetry/instrumentation-undici", version: "0.19.0" },
  pg: { name: "@opentelemetry/instrumentation-pg", version: "0.61.0" },
  redis: { name: "@opentelemetry/instrumentation-ioredis", version: "0.56.0" },
  pino: { name: "@opentelemetry/instrumentation-pino", version: "0.54.0" },
  fastapi: { name: "opentelemetry.instrumentation.fastapi", version: "0.59b0" },
  psycopg: { name: "opentelemetry.instrumentation.psycopg", version: "0.59b0" },
  httpx: { name: "opentelemetry.instrumentation.httpx", version: "0.59b0" },
  pyLogging: { name: "billing.charges", version: "" },
  jobs: { name: "demo-shop-worker", version: "2.3.0" },
  workerMetrics: { name: "demo-shop-worker", version: "2.3.0" },
  webMetrics: { name: "@opentelemetry/sdk-metrics", version: "2.2.0" },
} as const;
interface Scope {
  name: string;
  version: string;
}

/** Records by resource, then scope: one OTLP request's nesting. */
class Batch<Item> {
  readonly #resources = new Map<
    string,
    { resource: Resource; scopes: Map<string, { scope: Scope; items: Item[] }> }
  >();
  count = 0;

  add(resource: Resource, scope: Scope, item: Item) {
    let entry = this.#resources.get(resource.key);
    if (entry === undefined) {
      entry = { resource, scopes: new Map() };
      this.#resources.set(resource.key, entry);
    }
    let scoped = entry.scopes.get(scope.name);
    if (scoped === undefined) {
      scoped = { scope, items: [] };
      entry.scopes.set(scope.name, scoped);
    }
    scoped.items.push(item);
    this.count += 1;
  }

  /** The request: `resources`, each with `scopes`, each holding its items under `itemKey`. */
  request(resourcesKey: string, scopesKey: string, itemKey: string): object {
    return {
      [resourcesKey]: [...this.#resources.values()].map(({ resource, scopes }) => ({
        resource: { attributes: attributes(resource.attributes) },
        [scopesKey]: [...scopes.values()].map(({ scope, items }) => ({
          scope: { name: scope.name, version: scope.version },
          [itemKey]: items,
        })),
      })),
    };
  }
}

interface SpanInput {
  /** Its ID, when its children needed it first; a new one otherwise. */
  id?: string;
  name: string;
  kind: number;
  start: number;
  durationMs: number;
  parent?: string;
  attributes: Record<string, Value | undefined>;
  error?: string;
  events?: object[];
}

/** One trace's spans, added to a day's batch. */
class Trace {
  readonly id: string;
  readonly #rng: Random;
  readonly #spans: Batch<object>;

  constructor(rng: Random, spans: Batch<object>) {
    this.#rng = rng;
    this.#spans = spans;
    this.id = rng.hex(16);
  }

  span(resource: Resource, scope: Scope, input: SpanInput): string {
    const spanId = input.id ?? this.#rng.hex(8);
    this.#spans.add(resource, scope, {
      traceId: this.id,
      spanId,
      ...(input.parent === undefined ? {} : { parentSpanId: input.parent }),
      name: input.name,
      kind: input.kind,
      startTimeUnixNano: nanos(input.start),
      endTimeUnixNano: nanos(input.start + input.durationMs),
      attributes: attributes(input.attributes),
      ...(input.error === undefined ? {} : { status: { code: ERROR, message: input.error } }),
      ...(input.events === undefined ? {} : { events: input.events }),
    });
    return spanId;
  }
}

/** A log record, joined to its trace and span when it has them. */
function logRecord(
  at: number,
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR",
  body: string,
  values: Record<string, Value | undefined>,
  trace?: { traceId: string; spanId: string },
) {
  const number = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }[severity];
  return {
    timeUnixNano: nanos(at),
    observedTimeUnixNano: nanos(at + 3),
    severityNumber: number,
    severityText: severity,
    body: { stringValue: body },
    ...(trace === undefined ? {} : { traceId: trace.traceId, spanId: trace.spanId }),
    attributes: attributes(values),
  };
}

const exception = (at: number, type: string, message: string, stacktrace: string) => ({
  name: "exception",
  timeUnixNano: nanos(at),
  attributes: attributes({
    "exception.type": type,
    "exception.message": message,
    "exception.stacktrace": stacktrace,
  }),
});

const CART_STACK = `TypeError: Cannot read properties of null (reading 'sku')
    at addItem (/app/dist/routes/cart.js:48:31)
    at async Object.<anonymous> (/app/dist/routes/cart.js:22:5)
    at async Router.handle (/app/node_modules/fastify/lib/route.js:612:7)`;
const PROVIDER_STACK = `Traceback (most recent call last):
  File "/srv/billing/.venv/lib/python3.13/site-packages/httpx/_transports/default.py", line 101, in map_httpcore_exceptions
    yield
  File "/srv/billing/billing/providers/payments.py", line 64, in create_intent
    response = await self.client.post("/v1/payment_intents", json=payload, timeout=10.0)
  File "/srv/billing/billing/providers/payments.py", line 71, in create_intent
    raise PaymentProviderTimeout(f"payment provider did not answer within {timeout} s") from error
billing.providers.payments.PaymentProviderTimeout: payment provider did not answer within 10 s`;
const MAIL_STACK = `Error: Receipt email failed: connect ETIMEDOUT
    at MailClient.send (/app/dist/jobs/mail-client.js:37:15)
    at async sendReceipt (/app/dist/jobs/send-receipt.js:19:3)
    at async Worker.run (/app/dist/worker.js:88:9)`;
const STATEMENT_TIMEOUT_STACK = `error: canceling statement due to statement timeout
    at /app/node_modules/pg/lib/client.js:545:17
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async searchProducts (/app/dist/routes/search.js:31:18)`;

const PRODUCT_SLUGS = [
  "ceramic-mug",
  "linen-apron",
  "oak-cutting-board",
  "enamel-kettle",
  "wool-throw",
  "copper-pan",
];
const SEARCHES = ["mug", "kettle", "linen", "gift", "cast iron", "copper pan", "apron", "throw"];
const HOURLY = [
  2, 1.5, 1.2, 1, 1, 1.3, 2, 3, 4, 4.6, 5, 5.2, 5.4, 5.6, 6, 6.4, 6.6, 6.4, 6, 5.6, 5, 4.4, 3.6,
  2.8,
];
const HOURLY_TOTAL = HOURLY.reduce((sum, weight) => sum + weight, 0);

/**
 * The demo's incident: two days before today, 13:00 to 15:30 UTC, the
 * database is overloaded. The full-text search runs two and a half times
 * slower and a third of the searches time out, the payment provider fails
 * 40% of charges instead of 4%, and requests wait for a database
 * connection, most with a warning that the pool is exhausted. So every
 * chart shows it: the Services and Databases charts a spike in the failed
 * share, the 95th percentile, and the time spent; the Traces chart more
 * traces with errors and a higher 95th percentile; the Logs chart a rise
 * in warnings and errors.
 */
export const INCIDENT_DAYS_AGO = 2;
const INCIDENT_HOURS = [13, 15.5] as const;

/** A database call, for the database client's duration histogram. */
interface DatabaseCall {
  at: number;
  database: string;
  operation: string;
  durationMs: number;
}

/** A server request the web service handled, for its duration histogram. */
interface Request {
  at: number;
  route: string;
  method: string;
  durationMs: number;
  status: number;
}

export interface TelemetryData {
  /** OTLP/JSON Export…ServiceRequests: one per day, then the metrics. */
  traces: object[];
  logs: object[];
  metrics: object[];
}

/**
 * TRACE_DAYS of the services' traces and logs, up to `now`, and
 * METRIC_DAYS of their metrics and the hosts'. `userIds` are known users,
 * some of whom are signed in on the web service's requests.
 */
export function buildTelemetry(rng: Random, now: Date, userIds: readonly string[]): TelemetryData {
  const nowMs = now.getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const releaseAt = today - RELEASE_DAYS_AGO * DAY_MS + 10 * 3_600_000;
  const webVersion = (at: number) => (at < releaseAt ? RELEASES.previous : RELEASES.current);
  const hosts = ["app-1", "app-2"];
  const incidentFrom = today - INCIDENT_DAYS_AGO * DAY_MS + (INCIDENT_HOURS[0] ?? 0) * 3_600_000;
  const incidentTo = today - INCIDENT_DAYS_AGO * DAY_MS + (INCIDENT_HOURS[1] ?? 0) * 3_600_000;
  const inIncident = (at: number) => at >= incidentFrom && at < incidentTo;
  const web = (at: number, host: string) => service("web", webVersion(at), host, "nodejs");
  const billing = service("billing", "1.8.0", "app-2", "python");
  const worker = (at: number) => service("worker", webVersion(at), "app-2", "nodejs");

  const traces: object[] = [];
  const logs: object[] = [];
  const requests: Request[] = [];
  const calls: DatabaseCall[] = [];
  const orders: number[] = [];
  const jobs: { at: number; job: string }[] = [];

  for (let daysAgo = TRACE_DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
    const dayStart = today - daysAgo * DAY_MS;
    const spans = new Batch<object>();
    const records = new Batch<object>();
    const weekday = [0.75, 1.05, 1.1, 1.08, 1.02, 0.92, 0.7][new Date(dayStart).getUTCDay()] ?? 1;
    const perDay = Math.round(780 * weekday * rng.normal(1, 0.05));

    for (let hour = 0; hour < 24; hour += 1) {
      const count = Math.round((perDay * (HOURLY[hour] ?? 1)) / HOURLY_TOTAL);
      for (let index = 0; index < count; index += 1) {
        const at = dayStart + hour * 3_600_000 + rng.next() * 3_600_000;
        if (at > nowMs - 2000) continue;
        webRequest(at);
      }
      // Jobs: inventory every half hour, abandoned carts every hour.
      for (const minute of [7, 37]) syncInventory(dayStart + hour * 3_600_000 + minute * 60_000);
      cleanupCarts(dayStart + hour * 3_600_000 + 52 * 60_000);
    }
    // Invoices billing serves to the accounts pages.
    for (let index = 0; index < 30; index += 1) {
      invoice(
        dayStart +
          rng.weighted(HOURLY.map((weight, hour) => [hour, weight] as const)) * 3_600_000 +
          rng.next() * 3_600_000,
      );
    }
    if (spans.count > 0) traces.push(spans.request("resourceSpans", "scopeSpans", "spans"));
    if (records.count > 0) logs.push(records.request("resourceLogs", "scopeLogs", "logRecords"));

    function db(
      trace: Trace,
      resource: Resource,
      parent: string,
      start: number,
      durationMs: number,
      query: { operation: string; table: string; text: string; error?: string },
      scope: Scope = SCOPES.pg,
      older = false,
    ): number {
      calls.push({
        at: start,
        database: resource === billing ? "billing" : "shop",
        operation: query.operation,
        durationMs,
      });
      trace.span(resource, scope, {
        name: `${query.operation} ${query.table}`,
        kind: CLIENT,
        start,
        durationMs,
        parent,
        attributes: older
          ? {
              // An older instrumentation's names, which the Databases page reads too.
              "db.system": "postgresql",
              "db.name": resource === billing ? "billing" : "shop",
              "db.statement": query.text,
              "db.operation": query.operation,
              "db.sql.table": query.table,
              "net.peer.name": "db-1.internal",
              "net.peer.port": 5432,
            }
          : {
              "db.system.name": "postgresql",
              "db.namespace": resource === billing ? "billing" : "shop",
              "db.query.text": query.text,
              "db.operation.name": query.operation,
              "db.collection.name": query.table,
              "server.address": "db-1.internal",
              "server.port": 5432,
            },
        ...(query.error === undefined
          ? {}
          : {
              error: query.error,
              events: [
                exception(start + durationMs, "error", query.error, STATEMENT_TIMEOUT_STACK),
              ],
            }),
      });
      return start + durationMs;
    }

    function redis(
      trace: Trace,
      resource: Resource,
      parent: string,
      start: number,
      command: string,
    ): number {
      const durationMs = rng.logNormal(0.6, 0.4);
      trace.span(resource, SCOPES.redis, {
        name: command.split(" ")[0]?.toLowerCase() ?? "get",
        kind: CLIENT,
        start,
        durationMs,
        parent,
        attributes: {
          "db.system.name": "redis",
          "db.namespace": "0",
          "db.query.text": command,
          "db.operation.name": command.split(" ")[0],
          "server.address": "cache-1.internal",
          "server.port": 6379,
        },
      });
      return start + durationMs;
    }

    function outgoing(
      trace: Trace,
      resource: Resource,
      scope: Scope,
      parent: string,
      start: number,
      durationMs: number,
      method: string,
      url: string,
      status: number | undefined,
      error?: string,
    ): string {
      const parsed = new URL(url);
      return trace.span(resource, scope, {
        name: method,
        kind: CLIENT,
        start,
        durationMs,
        parent,
        attributes: {
          "http.request.method": method,
          "url.full": url,
          "server.address": parsed.hostname,
          "server.port": parsed.port === "" ? 443 : Number(parsed.port),
          "http.response.status_code": status,
        },
        ...(error === undefined ? {} : { error }),
      });
    }

    function webRequest(at: number) {
      const host = rng.pick(hosts);
      const resource = web(at, host);
      const trace = new Trace(rng, spans);
      const route = rng.weighted([
        ["/", 18],
        ["/products/:slug", 25],
        ["/api/cart", 15],
        ["/api/cart/items", 10],
        ["/api/search", 12],
        ["/api/checkout", 5],
        ["/api/orders/:id", 8],
      ] as const);
      const method = route === "/api/cart/items" || route === "/api/checkout" ? "POST" : "GET";
      const userId = userIds.length > 0 && rng.chance(0.3) ? rng.pick(userIds) : undefined;
      const serverId = rng.hex(8);
      const busy = inIncident(at);
      // Children first, so the server span's duration covers them.
      let cursor = at + rng.logNormal(2, 0.4);
      let status = 200;
      let failure: string | undefined;
      let events: object[] | undefined;
      const cart = rng.int(1000, 9999);
      const slug = rng.pick(PRODUCT_SLUGS);
      const parent = serverId;
      const children: (() => void)[] = [];
      const later = (work: () => void) => children.push(work);
      let path: string = route;

      switch (route) {
        case "/": {
          const start = cursor;
          later(() =>
            db(trace, resource, parent, start, rng.logNormal(4, 0.4), {
              operation: "SELECT",
              table: "products",
              text: "SELECT id, slug, name, price_cents FROM products WHERE featured = true ORDER BY position LIMIT 12",
            }),
          );
          cursor += 6 + rng.logNormal(25, 0.4);
          break;
        }
        case "/products/:slug": {
          path = `/products/${slug}`;
          const cached = rng.chance(0.6);
          const redisAt = cursor;
          later(() => redis(trace, resource, parent, redisAt, `GET product:${slug}`));
          cursor += 1;
          if (!cached) {
            const start = cursor;
            const duration = rng.logNormal(5, 0.4);
            later(() =>
              db(trace, resource, parent, start, duration, {
                operation: "SELECT",
                table: "products",
                text: `SELECT id, slug, name, price_cents, stock FROM products WHERE slug = '${slug}' LIMIT 1`,
              }),
            );
            cursor += duration + 0.5;
            if (rng.chance(0.1)) {
              records.add(
                resource,
                SCOPES.pino,
                logRecord(
                  start,
                  "DEBUG",
                  `cache miss for product ${slug}`,
                  { "product.slug": slug },
                  { traceId: trace.id, spanId: serverId },
                ),
              );
            }
          }
          if (rng.chance(0.03)) {
            status = 404;
          } else {
            const start = cursor;
            const duration = rng.logNormal(3, 0.4);
            later(() =>
              db(trace, resource, parent, start, duration, {
                operation: "SELECT",
                table: "reviews",
                text: `SELECT rating, body, created_at FROM reviews WHERE product_id = ${rng.int(1, 60)} ORDER BY created_at DESC LIMIT 5`,
              }),
            );
            cursor += duration + rng.logNormal(20, 0.4);
          }
          break;
        }
        case "/api/cart": {
          const redisAt = cursor;
          later(() => redis(trace, resource, parent, redisAt, `GET cart:${cart}`));
          cursor += 1;
          const start = cursor;
          const duration = rng.logNormal(3, 0.4);
          later(() =>
            db(trace, resource, parent, start, duration, {
              operation: "SELECT",
              table: "cart_items",
              text: `SELECT ci.product_id, ci.quantity, p.price_cents FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ${cart}`,
            }),
          );
          cursor += duration + rng.logNormal(4, 0.3);
          break;
        }
        case "/api/cart/items": {
          const start = cursor;
          const duration = rng.logNormal(3, 0.4);
          later(() =>
            db(trace, resource, parent, start, duration, {
              operation: "SELECT",
              table: "products",
              text: `SELECT id, sku, price_cents, stock FROM products WHERE slug = '${slug}' LIMIT 1`,
            }),
          );
          cursor += duration + 0.5;
          if (rng.chance(0.015)) {
            // A product deleted while it sat in a cart.
            status = 500;
            failure = "Cannot read properties of null (reading 'sku')";
            events = [exception(cursor, "TypeError", failure, CART_STACK)];
            const errorAt = cursor;
            records.add(
              resource,
              SCOPES.pino,
              logRecord(
                errorAt,
                "ERROR",
                `unhandled error in POST /api/cart/items: ${failure}`,
                { "http.route": route, "cart.id": cart },
                { traceId: trace.id, spanId: serverId },
              ),
            );
            break;
          }
          const insertAt = cursor;
          const insert = rng.logNormal(4, 0.4);
          later(() =>
            db(trace, resource, parent, insertAt, insert, {
              operation: "INSERT",
              table: "cart_items",
              text: `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (${cart}, ${rng.int(1, 60)}, 1) ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = cart_items.quantity + 1`,
            }),
          );
          cursor += insert + 0.5;
          const redisAt = cursor;
          later(() => redis(trace, resource, parent, redisAt, `DEL cart:${cart}`));
          cursor += 1 + rng.logNormal(3, 0.3);
          if (rng.chance(0.2)) {
            records.add(
              resource,
              SCOPES.pino,
              logRecord(
                cursor,
                "INFO",
                `added ${slug} to cart ${cart}`,
                { "cart.id": cart, "product.slug": slug },
                { traceId: trace.id, spanId: serverId },
              ),
            );
          }
          break;
        }
        case "/api/search": {
          // The slow route: a full-text search without an index.
          const query = rng.pick(SEARCHES);
          const start = cursor;
          const timedOut = rng.chance(busy ? 0.35 : 0.015);
          const duration = timedOut
            ? 3000
            : Math.min(2900, rng.logNormal(750, 0.55) * (busy ? 2.5 : 1));
          later(() =>
            db(trace, resource, parent, start, duration, {
              operation: "SELECT",
              table: "products",
              text: `SELECT id, slug, name, price_cents FROM products WHERE to_tsvector('english', name || ' ' || description) @@ plainto_tsquery('english', '${query}') ORDER BY ts_rank(to_tsvector('english', name || ' ' || description), plainto_tsquery('english', '${query}')) DESC LIMIT 20`,
              ...(timedOut ? { error: "canceling statement due to statement timeout" } : {}),
            }),
          );
          cursor += duration + rng.logNormal(6, 0.3);
          if (timedOut) {
            status = 500;
            failure = "canceling statement due to statement timeout";
            records.add(
              resource,
              SCOPES.pino,
              logRecord(
                cursor,
                "ERROR",
                `search failed: ${failure}`,
                { "http.route": route, "search.query": query },
                { traceId: trace.id, spanId: serverId },
              ),
            );
          } else if (duration > 1500) {
            records.add(
              resource,
              SCOPES.pino,
              logRecord(
                cursor,
                "WARN",
                `slow query: product search took ${Math.round(duration)} ms`,
                { "db.duration_ms": Math.round(duration), "search.query": query },
                { traceId: trace.id, spanId: serverId },
              ),
            );
          }
          break;
        }
        case "/api/checkout": {
          const order = rng.int(40_000, 60_000);
          const amount = rng.int(18, 320);
          const insertAt = cursor;
          const insert = rng.logNormal(5, 0.3);
          later(() =>
            db(trace, resource, parent, insertAt, insert, {
              operation: "INSERT",
              table: "orders",
              text: `INSERT INTO orders (customer_id, total_cents, currency, status) VALUES (${rng.int(1, 5000)}, ${amount * 100}, 'EUR', 'pending') RETURNING id`,
            }),
          );
          cursor += insert + 0.5;
          // Shipping rates from a partner's API.
          const ratesAt = cursor;
          const rates = rng.logNormal(180, 0.4);
          later(() =>
            outgoing(
              trace,
              resource,
              SCOPES.undici,
              parent,
              ratesAt,
              rates,
              "GET",
              `https://rates.shipping-partner.example/v2/rates?country=${rng.pick(["DE", "US", "GB", "FR"])}`,
              200,
            ),
          );
          cursor += rates + 1;
          // The charge, through the billing service.
          const chargeAt = cursor;
          const fails = rng.chance(busy ? 0.4 : 0.04);
          const providerMs = fails ? 10_000 : rng.logNormal(420, 0.35);
          const billingMs = providerMs + 12;
          const clientId = outgoing(
            trace,
            resource,
            SCOPES.undici,
            parent,
            chargeAt,
            billingMs + 4,
            "POST",
            "http://billing.internal:8000/charges",
            fails ? 502 : 201,
            fails ? "502 Bad Gateway" : undefined,
          );
          const billingServer = trace.span(billing, SCOPES.fastapi, {
            name: "POST /charges",
            kind: SERVER,
            start: chargeAt + 1,
            durationMs: billingMs,
            parent: clientId,
            attributes: {
              "http.request.method": "POST",
              "http.route": "/charges",
              "url.path": "/charges",
              "url.scheme": "http",
              "server.address": "billing.internal",
              "http.response.status_code": fails ? 502 : 201,
              "user.id": userId,
            },
            ...(fails
              ? {
                  error: "payment provider did not answer within 10 s",
                  events: [
                    exception(
                      chargeAt + billingMs,
                      "billing.providers.payments.PaymentProviderTimeout",
                      "payment provider did not answer within 10 s",
                      PROVIDER_STACK,
                    ),
                  ],
                }
              : {}),
          });
          db(
            trace,
            billing,
            billingServer,
            chargeAt + 2,
            rng.logNormal(3, 0.3),
            {
              operation: "INSERT",
              table: "charges",
              text: "INSERT INTO charges (order_id, amount_cents, currency, provider_ref, status) VALUES (%s, %s, %s, %s, %s)",
            },
            SCOPES.psycopg,
          );
          outgoing(
            trace,
            billing,
            SCOPES.httpx,
            billingServer,
            chargeAt + 6,
            providerMs,
            "POST",
            "https://api.payments-provider.example/v1/payment_intents",
            fails ? undefined : 200,
            fails ? "ReadTimeout" : undefined,
          );
          cursor += billingMs + 6;
          if (fails) {
            status = 502;
            failure = "payment provider failed";
            records.add(
              billing,
              SCOPES.pyLogging,
              logRecord(
                chargeAt + billingMs,
                "ERROR",
                `payment provider timed out after 10 s for order ${order}`,
                { "order.id": order },
                { traceId: trace.id, spanId: billingServer },
              ),
            );
          } else {
            records.add(
              billing,
              SCOPES.pyLogging,
              logRecord(
                chargeAt + billingMs,
                "INFO",
                `charge ch_${rng.hex(6)} succeeded for order ${order}`,
                { "order.id": order, "charge.amount": amount },
                { traceId: trace.id, spanId: billingServer },
              ),
            );
            const updateAt = cursor;
            const update = rng.logNormal(3, 0.3);
            later(() =>
              db(trace, resource, parent, updateAt, update, {
                operation: "UPDATE",
                table: "orders",
                text: `UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order}`,
              }),
            );
            cursor += update + 1;
            records.add(
              resource,
              SCOPES.pino,
              logRecord(
                cursor,
                "INFO",
                `order ${order} placed: ${amount}.00 EUR`,
                { "order.id": order, "order.total": amount },
                { traceId: trace.id, spanId: serverId },
              ),
            );
            orders.push(cursor);
            sendReceipt(cursor + rng.int(500, 4000), order);
          }
          break;
        }
        case "/api/orders/:id": {
          const order = rng.int(40_000, 60_000);
          path = `/api/orders/${order}`;
          const start = cursor;
          const duration = rng.logNormal(6, 0.4);
          later(() =>
            db(trace, resource, parent, start, duration, {
              operation: "SELECT",
              table: "orders",
              text: `SELECT o.id, o.status, o.total_cents, i.product_id, i.quantity FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.id = ${order}`,
            }),
          );
          cursor += duration + rng.logNormal(4, 0.3);
          break;
        }
      }
      for (const work of children) work();
      if (busy) {
        // The time spent waiting for a database connection, added to the request after its
        // work (so the spans already placed keep their times): a warning on most requests.
        const waitMs = rng.logNormal(400, 0.5);
        cursor += waitMs;
        if (rng.chance(0.6)) {
          records.add(
            resource,
            SCOPES.pino,
            logRecord(
              at + 1,
              "WARN",
              `database pool exhausted: waited ${Math.round(waitMs)} ms for a connection`,
              { "http.route": route, "db.pool.wait_ms": Math.round(waitMs) },
              { traceId: trace.id, spanId: serverId },
            ),
          );
        }
      }
      const durationMs = cursor - at + rng.logNormal(1.5, 0.3);
      trace.span(resource, SCOPES.http, {
        id: serverId,
        name: `${method} ${route}`,
        kind: SERVER,
        start: at,
        durationMs,
        attributes: {
          "http.request.method": method,
          "http.route": route,
          "url.path": path,
          "url.scheme": "https",
          "server.address": "demo-shop.example",
          "http.response.status_code": status,
          "network.protocol.version": "1.1",
          "user.id": userId,
        },
        ...(failure === undefined ? {} : { error: failure }),
        ...(events === undefined ? {} : { events }),
      });
      requests.push({ at, route, method, durationMs, status });
    }

    function sendReceipt(at: number, order: number) {
      if (at > nowMs - 2000) return;
      const resource = worker(at);
      const trace = new Trace(rng, spans);
      const fails = rng.chance(0.05);
      const mailMs = fails ? 5000 : rng.logNormal(240, 0.3);
      const root = trace.span(resource, SCOPES.jobs, {
        name: "send-receipt",
        kind: CONSUMER,
        start: at,
        durationMs: mailMs + 8,
        attributes: {
          "messaging.system": "postgres-queue",
          "messaging.destination.name": "receipts",
          "job.name": "send-receipt",
          "order.id": order,
        },
        ...(fails ? { error: "Receipt email failed: connect ETIMEDOUT" } : {}),
      });
      db(trace, resource, root, at + 1, rng.logNormal(2, 0.3), {
        operation: "SELECT",
        table: "orders",
        text: `SELECT o.id, o.total_cents, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ${order}`,
      });
      outgoing(
        trace,
        resource,
        SCOPES.undici,
        root,
        at + 4,
        mailMs,
        "POST",
        "https://api.mail-provider.example/v3/mail/send",
        fails ? undefined : 202,
        fails ? "connect ETIMEDOUT" : undefined,
      );
      records.add(
        resource,
        SCOPES.pino,
        fails
          ? logRecord(
              at + mailMs + 6,
              "ERROR",
              `receipt for order ${order} failed`,
              {
                "order.id": order,
                "exception.type": "Error",
                "exception.message": "Receipt email failed: connect ETIMEDOUT",
                "exception.stacktrace": MAIL_STACK,
              },
              { traceId: trace.id, spanId: root },
            )
          : logRecord(
              at + mailMs + 6,
              "INFO",
              `receipt sent for order ${order}`,
              { "order.id": order },
              { traceId: trace.id, spanId: root },
            ),
      );
      jobs.push({ at, job: "send-receipt" });
    }

    function syncInventory(at: number) {
      if (at > nowMs - 2000) return;
      const resource = worker(at);
      const trace = new Trace(rng, spans);
      const updates = rng.int(2, 6);
      const root = trace.span(resource, SCOPES.jobs, {
        name: "sync-inventory",
        kind: INTERNAL,
        start: at,
        durationMs: 20 + updates * 6,
        attributes: { "job.name": "sync-inventory" },
      });
      for (let index = 0; index < updates; index += 1) {
        db(
          trace,
          resource,
          root,
          at + 2 + index * 6,
          rng.logNormal(3, 0.3),
          {
            operation: "UPDATE",
            table: "products",
            text: `UPDATE products SET stock = ${rng.int(0, 400)} WHERE sku = 'DS-${rng.int(1000, 1060)}'`,
          },
          SCOPES.pg,
          true,
        );
      }
      records.add(
        resource,
        SCOPES.pino,
        logRecord(
          at + 20 + updates * 6,
          "INFO",
          `inventory synced: ${updates} products updated`,
          { "job.name": "sync-inventory", updated: updates },
          { traceId: trace.id, spanId: root },
        ),
      );
      jobs.push({ at, job: "sync-inventory" });
    }

    function cleanupCarts(at: number) {
      if (at > nowMs - 2000) return;
      const resource = worker(at);
      const trace = new Trace(rng, spans);
      const duration = rng.logNormal(40, 0.3);
      const root = trace.span(resource, SCOPES.jobs, {
        name: "cleanup-abandoned-carts",
        kind: INTERNAL,
        start: at,
        durationMs: duration + 4,
        attributes: { "job.name": "cleanup-abandoned-carts" },
      });
      db(
        trace,
        resource,
        root,
        at + 2,
        duration,
        {
          operation: "DELETE",
          table: "carts",
          text: "DELETE FROM carts WHERE updated_at < now() - interval '7 days'",
        },
        SCOPES.pg,
        true,
      );
      jobs.push({ at, job: "cleanup-abandoned-carts" });
    }

    function invoice(at: number) {
      if (at > nowMs - 2000) return;
      const trace = new Trace(rng, spans);
      const id = rng.int(10_000, 99_999);
      const duration = rng.logNormal(12, 0.4);
      const root = trace.span(billing, SCOPES.fastapi, {
        name: "GET /invoices/{invoice_id}",
        kind: SERVER,
        start: at,
        durationMs: duration + 3,
        attributes: {
          "http.request.method": "GET",
          "http.route": "/invoices/{invoice_id}",
          "url.path": `/invoices/${id}`,
          "url.scheme": "http",
          "server.address": "billing.internal",
          "http.response.status_code": 200,
        },
      });
      db(
        trace,
        billing,
        root,
        at + 1,
        duration,
        {
          operation: "SELECT",
          table: "invoices",
          text: "SELECT id, order_id, amount_cents, issued_at, pdf_key FROM invoices WHERE id = %s",
        },
        SCOPES.psycopg,
      );
    }
  }

  const metrics = [
    ...appMetrics(rng, nowMs, requests, calls, orders, jobs, web, worker),
    ...hostMetrics(rng, nowMs, [...hosts, "db-1"]),
  ];
  return { traces, logs, metrics };
}

/** Points every `step` over the last METRIC_DAYS, up to now. */
function times(nowMs: number, step: number): number[] {
  const first = Math.ceil((nowMs - METRIC_DAYS * DAY_MS) / step) * step;
  const result: number[] = [];
  for (let at = first; at <= nowMs - 60_000; at += step) result.push(at);
  // And one just now, as an exporter's latest, so hosts are not stale yet.
  result.push(nowMs - 20_000);
  return result;
}

const point = (at: number, start: number, values: Record<string, Value>, value: number) => ({
  timeUnixNano: nanos(at),
  startTimeUnixNano: nanos(start),
  attributes: attributes(values),
  asDouble: value,
});

/** OpenTelemetry's default bounds for HTTP durations, in seconds. */
const DURATION_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
/** The semantic conventions' advised bounds for database client durations, in seconds. */
const DATABASE_BOUNDS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];

/**
 * A cumulative duration histogram's points at each tick, one series per
 * entry: every sample (in milliseconds) up to the tick, in `bounds` (seconds).
 */
function durationPoints(
  series: { attributes: Record<string, Value>; samples: { at: number; durationMs: number }[] }[],
  bounds: readonly number[],
  ticks: readonly number[],
  start: number,
): object[] {
  const points: object[] = [];
  for (const { attributes: values, samples } of series) {
    const mine = samples.filter((sample) => sample.at >= start).toSorted((a, b) => a.at - b.at);
    const buckets = Array.from({ length: bounds.length + 1 }, () => 0);
    let count = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let next = 0;
    for (const tick of ticks) {
      while (next < mine.length && (mine[next]?.at ?? Infinity) <= tick) {
        const seconds = (mine[next]?.durationMs ?? 0) / 1000;
        const index = bounds.findIndex((bound) => seconds <= bound);
        const bucket = index === -1 ? bounds.length : index;
        buckets[bucket] = (buckets[bucket] ?? 0) + 1;
        count += 1;
        sum += seconds;
        min = Math.min(min, seconds);
        max = Math.max(max, seconds);
        next += 1;
      }
      points.push({
        timeUnixNano: nanos(tick),
        startTimeUnixNano: nanos(start),
        attributes: attributes(values),
        count: String(count),
        sum,
        ...(count === 0 ? {} : { min, max }),
        bucketCounts: buckets.map(String),
        explicitBounds: bounds,
      });
    }
  }
  return points;
}

/**
 * The services' own metrics, from the requests, calls, and jobs above:
 * the web service's request durations (a histogram per route) and the
 * shop database's calls' durations (a histogram per operation),
 * orders placed (a counter), its database pool (an up-down counter), and
 * the worker's jobs (a counter) and queue (a gauge). Cumulative, as SDKs
 * export by default.
 */
function appMetrics(
  rng: Random,
  nowMs: number,
  requests: readonly Request[],
  calls: readonly DatabaseCall[],
  orders: readonly number[],
  jobs: readonly { at: number; job: string }[],
  web: (at: number, host: string) => Resource,
  worker: (at: number) => Resource,
): object[] {
  const ticks = times(nowMs, APP_METRIC_STEP_MS);
  const start = (ticks[0] ?? nowMs) - APP_METRIC_STEP_MS;
  const batch = new Batch<object>();
  const webResource = web(nowMs, "app-1");
  const workerResource = worker(nowMs);

  // Request durations, per route, from the requests themselves.
  const routes = ["/", "/products/:slug", "/api/cart", "/api/search"];
  const histogramPoints = durationPoints(
    routes.map((route) => ({
      attributes: { "http.request.method": "GET", "http.route": route },
      samples: requests.filter((request) => request.route === route),
    })),
    DURATION_BOUNDS,
    ticks,
    start,
  );
  batch.add(webResource, SCOPES.webMetrics, {
    name: "http.server.request.duration",
    unit: "s",
    description: "Duration of HTTP server requests.",
    histogram: { aggregationTemporality: CUMULATIVE, dataPoints: histogramPoints },
  });

  // The shop database's calls' durations, per operation, from the calls themselves.
  const shopCalls = calls.filter((call) => call.database === "shop");
  const operations = [...new Set(shopCalls.map((call) => call.operation))].toSorted();
  batch.add(webResource, SCOPES.webMetrics, {
    name: "db.client.operation.duration",
    unit: "s",
    description: "Duration of database client operations.",
    histogram: {
      aggregationTemporality: CUMULATIVE,
      dataPoints: durationPoints(
        operations.map((operation) => ({
          attributes: {
            "db.system.name": "postgresql",
            "db.namespace": "shop",
            "db.operation.name": operation,
          },
          samples: shopCalls.filter((call) => call.operation === operation),
        })),
        DATABASE_BOUNDS,
        ticks,
        start,
      ),
    },
  });

  // Orders placed, counted as they happen.
  let placed = 0;
  let nextOrder = 0;
  const sorted = orders.filter((at) => at >= start).toSorted((a, b) => a - b);
  batch.add(webResource, SCOPES.webMetrics, {
    name: "orders.placed",
    unit: "{order}",
    sum: {
      aggregationTemporality: CUMULATIVE,
      isMonotonic: true,
      dataPoints: ticks.map((tick) => {
        while (nextOrder < sorted.length && (sorted[nextOrder] ?? Infinity) <= tick) {
          placed += 1;
          nextOrder += 1;
        }
        return point(tick, start, {}, placed);
      }),
    },
  });

  // The database pool: connections in use rise with traffic.
  const used = ticks.map((tick) => {
    const hour = new Date(tick).getUTCHours();
    return Math.max(1, Math.min(18, Math.round(2 + (HOURLY[hour] ?? 3) * 1.2 + rng.normal(0, 1))));
  });
  batch.add(webResource, SCOPES.webMetrics, {
    name: "db.client.connection.count",
    unit: "{connection}",
    sum: {
      aggregationTemporality: CUMULATIVE,
      isMonotonic: false,
      dataPoints: ticks.flatMap((tick, index) => [
        point(
          tick,
          start,
          { "db.client.connection.pool.name": "shop", "db.client.connection.state": "used" },
          used[index] ?? 0,
        ),
        point(
          tick,
          start,
          { "db.client.connection.pool.name": "shop", "db.client.connection.state": "idle" },
          20 - (used[index] ?? 0),
        ),
      ]),
    },
  });

  // The worker's jobs, by name, and its queue.
  const jobNames = ["send-receipt", "sync-inventory", "cleanup-abandoned-carts"];
  const byJob = new Map(
    jobNames.map((name) => [
      name,
      jobs
        .filter((job) => job.job === name && job.at >= start)
        .map((job) => job.at)
        .toSorted((a, b) => a - b),
    ]),
  );
  batch.add(workerResource, SCOPES.workerMetrics, {
    name: "jobs.processed",
    unit: "{job}",
    sum: {
      aggregationTemporality: CUMULATIVE,
      isMonotonic: true,
      dataPoints: jobNames.flatMap((name) => {
        const list = byJob.get(name) ?? [];
        let done = 0;
        let cursor = 0;
        return ticks.map((tick) => {
          while (cursor < list.length && (list[cursor] ?? Infinity) <= tick) {
            done += 1;
            cursor += 1;
          }
          return point(tick, start, { "job.name": name }, done);
        });
      }),
    },
  });
  batch.add(workerResource, SCOPES.workerMetrics, {
    name: "jobs.queue.depth",
    unit: "{job}",
    gauge: {
      dataPoints: ticks.map((tick) => {
        const hour = new Date(tick).getUTCHours();
        return point(
          tick,
          start,
          { queue: "receipts" },
          Math.max(0, Math.round((HOURLY[hour] ?? 3) * 0.8 + rng.normal(0, 1.5))),
        );
      }),
    },
  });
  return [batch.request("resourceMetrics", "scopeMetrics", "metrics")];
}

const SCRAPER = (name: string) => ({
  name: `github.com/open-telemetry/opentelemetry-collector-contrib/receiver/hostmetricsreceiver/internal/scraper/${name}scraper`,
  version: "0.140.0",
});
const GIB = 1024 ** 3;

/**
 * When the hosts send points: every 15 minutes over METRIC_DAYS, then every
 * HOST_RECENT_STEP_MS up to the point just now, as a host scraped more
 * often. 15 minutes up to the point just now would leave up to 15 minutes
 * and 40 seconds between the last two, too far apart for the Hosts list's
 * CPU, which then showed nothing.
 */
export function hostTicks(nowMs: number): number[] {
  const ticks = times(nowMs, HOST_METRIC_STEP_MS);
  const latest = ticks.pop() ?? nowMs;
  const last = ticks.at(-1) ?? latest;
  for (let at = last + HOST_RECENT_STEP_MS; at < latest; at += HOST_RECENT_STEP_MS) {
    ticks.push(at);
  }
  ticks.push(latest);
  return ticks;
}

/**
 * The hosts' metrics, as an OpenTelemetry Collector's host metrics
 * receiver sends them, under its scrapers' scope names (docs/telemetry.md,
 * "Hosts"): CPU time, memory, filesystems, network, disk, and load. Each
 * host has its own load: app-1 is quiet, app-2 busier, and db-1, the
 * database server, runs its CPU hard with its memory and data disk near
 * full, so the Hosts page shows values from low to high.
 */
function hostMetrics(rng: Random, nowMs: number, hosts: readonly string[]): object[] {
  const ticks = hostTicks(nowMs);
  const start = (ticks[0] ?? nowMs) - HOST_METRIC_STEP_MS;
  const requests: object[] = [];
  for (const host of hosts) {
    const busy = { "app-1": 0.18, "app-2": 0.3 }[host] ?? 0.58;
    const memoryTotal = host === "app-1" ? 4 * GIB : host === "app-2" ? 8 * GIB : 16 * GIB;
    const resource: Resource = {
      key: host,
      attributes: {
        "host.name": host,
        "host.arch": "amd64",
        "os.type": "linux",
        "os.description": "Ubuntu 24.04.3 LTS",
      },
    };
    const batch = new Batch<object>();
    const cpu: object[] = [];
    const memory: object[] = [];
    const filesystem: object[] = [];
    const network: object[] = [];
    const disk: object[] = [];
    const load: Record<string, object[]> = { "1m": [], "5m": [], "15m": [] };
    const cpuTotals = new Map<string, number>();
    let received = 0;
    let transmitted = 0;
    let read = 0;
    let written = 0;
    let lastLoad = 0.5;
    for (const [index, tick] of ticks.entries()) {
      const hour = new Date(tick).getUTCHours();
      const traffic = (HOURLY[hour] ?? 3) / 6.6;
      const share = Math.min(0.95, busy * (0.5 + traffic) + rng.normal(0, 0.02));
      // The time since the previous point, as the counters grow by it.
      const seconds = (tick - (ticks[index - 1] ?? start)) / 1000;
      for (const name of ["cpu0", "cpu1"]) {
        const states: Record<string, number> = {
          user: seconds * share * 0.7,
          system: seconds * share * 0.22,
          wait: seconds * share * 0.08,
          idle: seconds * (1 - share),
        };
        for (const [state, value] of Object.entries(states)) {
          const key = `${name} ${state}`;
          const total = (cpuTotals.get(key) ?? 0) + Math.max(0, value);
          cpuTotals.set(key, total);
          cpu.push(point(tick, start, { cpu: name, state }, Math.round(total * 100) / 100));
        }
      }
      const usedMemory =
        memoryTotal *
        Math.min(
          0.92,
          ({ "app-1": 0.48, "app-2": 0.62 }[host] ?? 0.8) + traffic * 0.08 + rng.normal(0, 0.01),
        );
      const cached = memoryTotal * 0.18;
      const buffered = memoryTotal * 0.04;
      for (const [state, value] of Object.entries({
        used: usedMemory,
        cached,
        buffered,
        free: memoryTotal - usedMemory - cached - buffered,
      })) {
        memory.push(point(tick, start, { state }, Math.round(value)));
      }
      const mounts: [string, string, number, number][] =
        host === "app-1"
          ? [["/", "/dev/sda1", 80 * GIB, 0.42]]
          : host === "app-2"
            ? [
                ["/", "/dev/sda1", 80 * GIB, 0.38],
                ["/var/lib/postgresql", "/dev/sdb1", 200 * GIB, 0.78],
              ]
            : [
                ["/", "/dev/sda1", 40 * GIB, 0.55],
                ["/var/lib/postgresql", "/dev/nvme1n1", 500 * GIB, 0.89],
              ];
      for (const [mountpoint, device, size, base] of mounts) {
        const usedShare = base + (0.04 * index) / ticks.length;
        const reserved = size * 0.05;
        const usedBytes = size * usedShare;
        for (const [state, value] of Object.entries({
          used: usedBytes,
          free: size - usedBytes - reserved,
          reserved,
        })) {
          filesystem.push(
            point(
              tick,
              start,
              { device, mountpoint, mode: "rw", type: "ext4", state },
              Math.round(value),
            ),
          );
        }
      }
      received += Math.round(
        (host === "app-1" ? 900_000 : 450_000) * traffic * seconds * rng.logNormal(1, 0.1),
      );
      transmitted += Math.round(
        (host === "app-1" ? 2_400_000 : 800_000) * traffic * seconds * rng.logNormal(1, 0.1),
      );
      network.push(point(tick, start, { device: "eth0", direction: "receive" }, received));
      network.push(point(tick, start, { device: "eth0", direction: "transmit" }, transmitted));
      read += Math.round(
        (host === "app-1" ? 150_000 : 900_000) * traffic * seconds * rng.logNormal(1, 0.15),
      );
      written += Math.round(
        (host === "app-1" ? 220_000 : 1_600_000) * traffic * seconds * rng.logNormal(1, 0.15),
      );
      disk.push(point(tick, start, { device: "sda", direction: "read" }, read));
      disk.push(point(tick, start, { device: "sda", direction: "write" }, written));
      const now = Math.max(0.05, share * 2 * 1.4 + rng.normal(0, 0.08));
      lastLoad = lastLoad * 0.6 + now * 0.4;
      load["1m"]?.push(point(tick, start, {}, Math.round(now * 100) / 100));
      load["5m"]?.push(point(tick, start, {}, Math.round(lastLoad * 100) / 100));
      load["15m"]?.push(
        point(tick, start, {}, Math.round((lastLoad * 0.8 + share * 0.5) * 100) / 100),
      );
    }
    const sum = (name: string, unit: string, monotonic: boolean, dataPoints: object[]) => ({
      name,
      unit,
      sum: { aggregationTemporality: CUMULATIVE, isMonotonic: monotonic, dataPoints },
    });
    batch.add(resource, SCRAPER("cpu"), sum("system.cpu.time", "s", true, cpu));
    batch.add(resource, SCRAPER("memory"), sum("system.memory.usage", "By", false, memory));
    batch.add(
      resource,
      SCRAPER("filesystem"),
      sum("system.filesystem.usage", "By", false, filesystem),
    );
    batch.add(resource, SCRAPER("network"), sum("system.network.io", "By", true, network));
    batch.add(resource, SCRAPER("disk"), sum("system.disk.io", "By", true, disk));
    for (const [window, dataPoints] of Object.entries(load)) {
      batch.add(resource, SCRAPER("load"), {
        name: `system.cpu.load_average.${window}`,
        unit: "{thread}",
        gauge: { dataPoints },
      });
    }
    requests.push(batch.request("resourceMetrics", "scopeMetrics", "metrics"));
  }
  return requests;
}
