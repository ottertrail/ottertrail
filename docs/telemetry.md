# Backend telemetry: traces, logs, and metrics

**Status: planned, stage 3 of the [roadmap](roadmap.md). This is the design to build from; nothing in it is built.**

A site's servers send what they did, in the OpenTelemetry protocol (OTLP): traces (each request through the services it touched, as spans), logs, and metrics. Ottertrail keeps them in ClickHouse, beside the browser's events, and the dashboard shows each with the others: a slow request's trace and its logs, an exception on a span in the same error list as the browser's errors. Any OpenTelemetry SDK or Collector can send to it; nothing of Ottertrail's own runs on the servers.

## Receiving

OTLP/HTTP, version 1 ([specification](https://opentelemetry.io/docs/specs/otlp/), 1.11.1 when this was written), at the paths an exporter appends to its base address, so pointing one at the instance is enough:

```text
POST /v1/traces
POST /v1/logs
POST /v1/metrics
```

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://analytics.example.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20sk_…
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

- **Both encodings:** protobuf (`application/x-protobuf`, exporters' default) and JSON (`application/json`, with the specification's rules: trace and span IDs in hex, enums as numbers, 64-bit numbers as strings), gzip-compressed or not. The answer comes in the request's encoding.
- **The project's secret key,** `Authorization: Bearer sk_…`, as server-side events take it ([web analytics](web-analytics.md#server-side-events)). Never a public key: these come from servers.
- **Decoding:** [protobufjs](https://github.com/protobufjs/protobuf.js) (BSD-3-Clause) with the official message definitions from [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) (Apache-2.0), kept in the repository at a pinned version. OpenTelemetry's own JavaScript package encodes requests but does not decode them, and is marked for internal use.
- **gRPC is not in the first version:** every OpenTelemetry SDK and the Collector can send over HTTP, and a Collector can take gRPC from anything that only speaks that.

## Answers

As the specification has them, so exporters retry what may succeed later and drop what never will:

| Case                                             | Answer                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Stored                                           | 200, an empty `Export…ServiceResponse`                                                   |
| Stored, but some records refused (below)         | 200, with `partial_success`: how many were refused and why. Exporters do not retry these |
| Malformed: not OTLP, or not the encoding it says | 400                                                                                      |
| No key, or one no project has                    | 401                                                                                      |
| Over 16 MiB once unpacked                        | 413                                                                                      |
| Over the project's or organization's budget      | 429, with `Retry-After`                                                                  |
| ClickHouse cannot take it now                    | 503, with `Retry-After`                                                                  |

Exporters retry 429, 502, 503, and 504, and nothing else.

## Stored straight in ClickHouse

Decided on 18 November 2026. Analytics events land in PostgreSQL first, which confirms them, and are copied to ClickHouse ([ClickHouse](clickhouse.md)). Telemetry does not: it is the largest data Ottertrail takes, often many times a site's events, and writing it twice would double the cost of the busiest path. An OTLP request is confirmed once ClickHouse has written it (asynchronous inserts, waiting for the write), and while ClickHouse cannot take it the answer is 503, which every exporter retries, keeping the data in its queue meanwhile.

A retry after an answer that was lost stores a record twice. Each record has an ID, a span its trace and span IDs, a log record or data point a hash of its content, and the tables keep one row per ID (`ReplacingMergeTree`); what counts records reads them deduplicated.

## Storage

Four tables, each ordered by project, then time, then the record's ID, so a project's range is one read and every query filters by project first, and partitioned by day:

- **`spans`:** trace, span, and parent IDs, name, kind, start, duration, status and its message, the service's name and version, environment, attributes, events, links, and the instrumentation scope.
- **`logs`:** time and observed time, severity number and text, body, trace and span IDs, service, environment, attributes, scope, event name.
- **`metric_points`:** gauges and sums: name, unit, kind, temporality, monotonic or not, start and time, value, attributes, service, environment.
- **`metric_histograms`:** histograms with explicit buckets: bounds, counts, count, sum, minimum, maximum.

The service comes from the resource's `service.name`, the release from `service.version`, the environment from `deployment.environment.name` (or the older `deployment.environment`), in lower case, `production` when left out, as the tracker's environments are ([environments and releases](web-analytics.md#environments-and-releases)), so a release's errors, traces, and logs line up. Attributes are kept as text in maps (`Map(LowCardinality(String), String)`): strings as they are, numbers and booleans as written, arrays and nested values as JSON. A bloom filter finds a trace's spans and logs by trace ID, and a text index (ClickHouse's `text` index, in 26.8) finds logs by the words in their body.

## Limits

- **Requests:** 16 MiB once unpacked (the specification suggests 64 MiB as a ceiling; a Collector's batches are far smaller).
- **Budgets:** spans, log records, and data points together, per project and per organization, apart from events', so telemetry cannot crowd out a site's events: a burst of 50,000 a project, then 5,000 a second; an organization's three times that. A first guess, to be measured.
- **Records:** attribute values cut to 4 KB, at most 128 attributes a record (the rest dropped, and counted, as OTLP counts its own dropped attributes), log bodies cut to 64 KB, at most 128 events and links a span. Times outside the retention, or more than an hour ahead, are refused and counted in `partial_success`.
- **Retention:** telemetry is kept 30 days by default (`TELEMETRY_RETENTION_DAYS`, 1 to 365; decided on 18 November 2026, as long as session replays), dropped by whole days by ClickHouse itself (TTL), which costs nothing. Deleting a project deletes its telemetry, through `project_deletions` as for events.

## Exceptions join the error list

A server's exception is recorded on its span, as an event named `exception`, or, as OpenTelemetry now leans to, as a log record with `exception.type`, `exception.message`, and `exception.stacktrace` ([semantic conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)). Ottertrail turns each into an error event ([errors](errors.md)): grouped with the same fingerprint rule, in the same list as the browser's, with the service's environment and release, the span's route as its path, its user (`user.id`) if any, and its trace and span IDs, so the error's page links to the trace. An exception on a span whose status is not an error, or in a log below the error severity, counts as handled.

## The dashboard

- **Traces:** a project's recent traces, by their root span: service, name, duration, status, filtered by service, environment, name, errors, duration, and period. A trace's page shows its spans as a waterfall, each with its attributes and events, and the trace's logs beside them.
- **Logs:** search by period, service, environment, severity, words in the body, and trace; newest first; each record with its attributes, and its trace when it has one.
- **Metrics:** each metric by name, with its kind and unit, as a chart over the period: a gauge's average, minimum, and maximum; a sum's rate (from cumulative values, the change between a series' points); a histogram's percentiles from its buckets; split by one attribute.
- **Services:** for each service, and each route of its server spans: requests, the share that failed, and the median and 95th-percentile duration, over the period.

## Not in the first version

- gRPC, and OTLP from browsers.
- Exponential histograms and summaries (refused, and counted in `partial_success`).
- Profiles, a live tail of logs, alerts (stage 4), sampling.
- Retention chosen per organization.
- Linking a browser's page load to the backend trace it started (`traceparent`).

## How it is built

1. ClickHouse's tables, decoding, the three routes, their answers, limits, and budgets; tests with protobuf and JSON requests.
2. Exceptions into the error list.
3. The dashboard's Traces, Logs, Metrics, and Services pages.
4. Deployment: the settings, and what has been tested.
