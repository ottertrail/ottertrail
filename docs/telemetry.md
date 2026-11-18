# Backend telemetry: traces, logs, and metrics

**Status: stage 3 of the [roadmap](roadmap.md). Receiving and storing, exceptions in the error list, and the dashboard's Traces, Logs, Metrics, Services, and Hosts pages (steps 1 to 3 of [How it is built](#how-it-is-built)) are built.**

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

| Case                                                                      | Answer                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Stored                                                                    | 200, an empty `Export…ServiceResponse`                                                   |
| Stored, but some records refused (below)                                  | 200, with `partial_success`: how many were refused and why. Exporters do not retry these |
| Malformed: not OTLP, or not the encoding it says                          | 400                                                                                      |
| No key, or one no project has                                             | 401                                                                                      |
| Over 16 MiB once unpacked, or over a million messages                     | 413: send smaller batches                                                                |
| Costs more than a project's whole budget                                  | 413: send smaller batches                                                                |
| Another content type, or a compression not gzip                           | 415                                                                                      |
| Over the project's or the instance's budget                               | 429, with `Retry-After`                                                                  |
| The project has 4 requests in progress on this process                    | 429, with `Retry-After`                                                                  |
| ClickHouse cannot take it now, or this process has 8 requests in progress | 503, with `Retry-After`                                                                  |

Exporters retry 429, 502, 503, and 504, and nothing else.

## Stored straight in ClickHouse

Decided on 18 November 2026. Analytics events then landed in PostgreSQL first, which confirmed them, and were copied to ClickHouse. Telemetry did not: it is the largest data Ottertrail takes, often many times a site's events, and writing it twice would double the cost of the busiest path. Events have gone straight to ClickHouse the same way since ([ClickHouse](clickhouse.md)). An OTLP request is confirmed once ClickHouse has written it (asynchronous inserts, waiting for the write), and while ClickHouse cannot take it the answer is 503, which every exporter retries, keeping the data in its queue meanwhile.

A retry after an answer that was lost stores a record twice. Each record has an ID, a span its trace and span IDs, a log record or data point a hash of its content, and the tables keep one row per ID (`ReplacingMergeTree`); what counts records reads them deduplicated, except the large aggregates of spans ([how the pages read](#how-the-pages-read)). One exception: a log record with neither a time nor an observed time takes the time it arrived, which differs on a retry, so a retry of it stays twice. OpenTelemetry's SDKs and the Collector always set the observed time.

## Storage

Four tables, partitioned by day. Spans and logs are ordered by project, then time, then the record's ID, so a project's range is one read and every query filters by project first. Metrics are ordered by project, then name, then time: a chart reads one metric, and an export holds all of a process's metrics at one time, so ordered by time alone a chart read every metric's rows of the range.

- **`spans`:** trace, span, and parent IDs, name, kind, start, duration, status and its message, the service's name and version, environment, attributes, events, links, and the instrumentation scope.
- **`logs`:** time and observed time, severity number and text, body, trace and span IDs, service, environment, attributes, scope, event name.
- **`metric_points`:** gauges and sums: name, unit, kind, temporality, monotonic or not, start and time, value, attributes, service, environment, and the series (below).
- **`metric_histograms`:** histograms with explicit buckets: bounds, counts, count, sum, minimum, maximum, and the series.

ClickHouse merges a table's parts when it decides, and never promises to: a day that gets no more inserts can keep a retried copy in a part of its own for its whole retention. So every telemetry table merges a day's parts into one once all of them are an hour old (`min_age_to_force_merge_seconds = 3600` with `min_age_to_force_merge_on_partition_only = 1`, migration `0002_force_telemetry_merges`): a copy is gone within about an hour of its day's last insert, plus the merge's own time. A day still being written to merges as ClickHouse decides until then. `telemetry-retention.test.ts` shows a day of 1,000,000 spans and a 10-span copy merged on its own once its parts pass the age (cut to a second in the test), while the same day without the setting keeps both parts and counts 1,000,010 rows.

A metric row's `series` is a `cityHash64` of its service, scope name and version, attributes, resource attributes, and temporality (a histogram's also its bounds), a `MATERIALIZED` column worked out when the row is written, so a chart does not hash every row's attribute maps.

The service comes from the resource's `service.name`, the release from `service.version`, the environment from `deployment.environment.name` (or the older `deployment.environment`), in lower case, `production` when left out, as the tracker's environments are ([environments and releases](web-analytics.md#environments-and-releases)), so a release's errors, traces, and logs line up. Attributes are kept as text in maps (`Map(LowCardinality(String), String)`): strings as they are, numbers and booleans as written, arrays and nested values as JSON. A bloom filter finds a trace's spans and logs by trace ID, and a text index (ClickHouse's `text` index, in 26.8) finds logs by the words in their body.

## Limits

What one project sends must not slow the API for the others, so every limit bounds the work a request makes, not only its size.

- **Requests:** 16 MiB once unpacked (the specification suggests 64 MiB as a ceiling). At most a million messages, the records, attributes, values, and what holds them, which the API counts from the body before decoding it: decoding allocates for each, and an empty one takes two bytes, so 16 MiB of them would take gigabytes of memory. A million take about as long and as much memory as a large real batch (20,000 spans of 20 attributes: 120 ms and 120 MB on the development machine). Each API process works on at most 8 requests at once, at most 4 of them one project's, so one project's exporters cannot take every place: each holds its body in memory until ClickHouse has it.
- **Budgets:** per project and per instance, apart from events', so telemetry cannot crowd out a site's events: a burst of 50,000 a project, then 5,000 a second; the instance's three times that (150,000, then 15,000 a second), all projects together. A request costs one per record, or, when it is more, one per 64 messages it decodes into or per 2 KiB its rows hold (its body, and the resource attributes each row repeats), so a few records with many attributes, or with a large resource, cost what the work they make costs. Each exception that becomes an error event ([below](#exceptions-join-the-error-list)) costs one more, so a span's exceptions cannot multiply rows for free. Decoding is paid for before it is done, and kept when the request is then refused. A first guess, to be measured.
- **Batches:** a request that costs more than a project's whole budget is refused (413), as it could never fit. A Collector's batch processor sends 8,192 records at a time by default, but with no upper limit (`send_batch_max_size: 0`), so one large incoming batch can pass through whole: set `send_batch_max_size` to 50,000 or less.
- **Records:** an all-zero trace, span, or parent span ID (a log record's, a span's parent, a link's) is stored as none, as OTLP says it means, so such a span is a root. Labels (service, scope name and version, severity text, event name, unit) lose control characters before they are cut to 256 characters. Attribute values cut to 4 KB, at most 128 attributes a record (the rest dropped, and counted, as OTLP counts its own dropped attributes), log bodies cut to 64 KB, at most 128 events and links a span. A resource's attributes are kept in key order up to 8 KiB in all, since each of its records' rows carries a copy; its service, release, and environment are read from all of them. Times outside the retention, or more than an hour ahead, are refused and counted in `partial_success`, and so are histogram points with more than 64 bounds (a chart's memory grows with the buckets; OpenTelemetry's default has 15) or a count or bucket count of 2^63 or more (a chart takes differences as signed 64-bit numbers).
- **Retention:** telemetry is kept 30 days by default (`TELEMETRY_RETENTION_DAYS`, 1 to 365; decided on 18 November 2026, as long as session replays), dropped by whole days by ClickHouse itself (TTL), which costs nothing. Deleting a project deletes its telemetry, through `project_deletions` as for events.

## Exceptions join the error list

A server's exception is recorded on its span, as an event named `exception`, or, as OpenTelemetry now leans to, as a log record with `exception.type`, `exception.message`, and `exception.stacktrace` ([semantic conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)). Ottertrail turns each into an error event ([errors](errors.md#server-errors)): a row of the events table named `error`, grouped with the same fingerprint rule, in the same list as the browser's.

- **What becomes an error:** a span event named `exception` with `exception.type` or `exception.message`, at most the first 10 of a span, among the 128 events its row keeps; and a log record with `exception.type` or `exception.message` among its attributes. Only records that are stored make errors: a refused span or log record makes none.
- **Type, message, and stack:** `exception.type`, or `Error` when only a message is given; `exception.message`; `exception.stacktrace`. Each is cut to what a browser's error may hold (type 200 characters, message 2,000, stack 16,000), without the control characters a browser's may not have (tabs and line feeds stay in the message and stack). They are read from the record as sent, not from its row, whose attribute values are cut to 4 KB; each is cut to four times its limit before it is cleaned, so a huge value costs no more than a large one.
- **Handled:** an exception on a span counts as handled unless the span's status is `ERROR`. One in a log record counts as handled below the error severity (`severity_number` 1 to 16), and as not handled from it (17 to 24) or without a severity.
- **Time:** the span event's time when it falls within the span (up to a minute after its end), else the span's start, decided from the span alone so every attempt gives the same time; the log record's time (its arrival's when it has none). Servers' clocks are trusted, as server-side events' are: no correction.
- **Environment, release, and service:** the resource's, as the telemetry rows have them ([storage](#storage)), so a release's errors, traces, and logs line up.
- **Path:** the span's `http.route`; for a log record, its own `http.route` if it has one; otherwise none. Cut to 2,048 characters, a browser's path's limit.
- **User:** the record's `user.id`, or the older `enduser.id`, when it is an ID a browser could send (1 to 200 characters, no control characters, [known users](web-analytics.md#known-users)); otherwise none. A server's user ID is not signed: it comes with the project's secret key.
- **Trace and span:** three columns of the events table, `trace_id`, `span_id` (in hex, as the spans table has them), and `service`, empty for every other event. A log record without a trace leaves them empty but the service. No visitor, browser, operating system, device, or location: a server has none.
- **Retries:** each error event's ID is made from a SHA-256 of the project and the exception's identity (a span's: its trace ID, span ID, the event's place among the span's events, its time as sent, type, and message; a log record's: its resource, its times as sent, and its content, so a record with no time keeps its ID even though it takes its arrival's time), as a UUID with version 8. A retried request makes the same IDs, and two alike exceptions on one span stay two, and the events table keeps each once ([ClickHouse](clickhouse.md)). The route writes the telemetry rows and the error events before it answers 200; if either insert fails, the budget is given back and the answer is 503, and the retry writes both again.
- **Grouping:** the fingerprint reads the file of the frame where the exception was raised from Python, Ruby, Go, Java (and other JVM languages; the class, not the file), and .NET stacks as well as browsers' and Node.js's ([errors](errors.md#3-grouping)).
- **Kept** as long as the project's events, not the 30 days of telemetry: an error can outlive the trace it names.

The error's page shows the latest occurrence's service, trace ID, and span ID. The trace ID, there and in each server occurrence's row, opens the trace's page on the span the exception happened in, looked for a day either side of the occurrence ([below](#how-the-pages-read)). Errors are kept longer than traces, so the page may say the trace is no longer kept.

## The dashboard

- **Traces** (built): a project's recent traces, by their root span: service, name, duration, status, filtered by service, environment, name, errors, duration, and period. A trace's page shows its spans as a waterfall, each with its attributes and events, and the trace's logs below them.
- **Logs** (built): search by period, service, environment, severity, words in the body, and trace; newest first; each record with its attributes, and its trace when it has one.
- **Metrics** (built): each metric by name, with its kind, unit, services, and when it was last seen; a metric's page charts it over the period: a gauge's average, minimum, and maximum; a counter's rate per second; a histogram's percentiles from its buckets and its observations per second; split by one attribute ([below](#how-metrics-are-charted)).
- **Services** (built): for each service, and each route of its server spans: requests, the share that failed, the median, 95th, and 99th-percentile duration, and the requests by status class, over the period; a service's or route's page charts them over the period ([below](#how-services-are-counted)).
- **Hosts** (built): the servers an OpenTelemetry Collector reports on, by host name, with their latest CPU, memory, fullest filesystem, and load, and each host's charts over the period ([below](#hosts)).

### How the pages read

Twelve routes, beside the other project routes (`apps/api/src/telemetry/dashboard-routes.ts`, queries in `traces.ts`, `logs.ts`, `metrics.ts`, `services.ts`, `hosts.ts`, and `dashboard-query.ts`). Each runs the access check every project route runs and reads only the project it found; an unknown project gets 404. Every query filters by project first, then time (a metric's, by project, then name, then time), passes every value as a query parameter, and has a `LIMIT`. Each runs with the same settings (`DASHBOARD_SETTINGS`): it stops after 15 seconds (`max_execution_time`) or 300 MB (`max_memory_usage`), and either answers 503, saying to narrow the range or filters; a grouping or sort past 100 MB goes on in parts on disk first (`max_bytes_before_external_group_by`, `max_bytes_before_external_sort`). A request's queries end once it is answered or closed, whichever comes first: when the browser gives up, and when one query fails and the route answers with an error while the request's other queries still run or wait. The route passes an abort signal to the ClickHouse client, which closes the query's connection, and `cancel_http_readonly_queries_on_client_close` has ClickHouse stop the query. That setting acts only on a read-only query, and the client sends its queries as POST with `readonly` 0 unless told otherwise, so the dashboard's queries run with `readonly` 2 (read-only, settings still changeable; a grouping or sort spilled to disk is still a read). Without it, a query whose request was gone ran on to its 15-second limit (`telemetry-dashboard-limit.test.ts` checks that an aborted query leaves `system.processes` within a second). At most 4 dashboard queries run at once on each API process (`dashboard-limit.ts`), and at most 2 of one request's, so a page that makes many queries, such as a host's, leaves places for the other pages; the next waits for a place, and after 10 seconds answers 503 with `Retry-After`, so the dashboard's pages cannot fill ClickHouse. The dashboard does not retry a telemetry request the API answered, a 503 included, which would only add to the load: the page says it failed and offers Retry. A request that never reached the API is retried once. The pages are described in the [dashboard](dashboard.md#89-traces-and-logs).

A retried record may be stored twice until ClickHouse merges its day ([storage](#storage)), so what counts or shows records must not see a copy, with one exception: the pages and alert rules that add up large windows of spans (the Services page, a service's and route's charts, and route alert rules) read without `FINAL`, since `FINAL` was measured to fail past the 300 MB a query may use on a busy project's unmerged parts ([how services are counted](#how-services-are-counted)). There a copy counts twice until its day is merged, which the tables force within about an hour of the day's last insert. Queries that read a few rows found by a key or an index read `FINAL`: a trace's spans and logs, a span, a log record, and each listed trace's span count. The two lists do not: `FINAL` merges every row of the range before the first can be sent, so each page of the Logs list read every record of the period (410,283 of 410,283 rows, on 400,000 records over 8 days). Without it, ClickHouse reads the project's rows in key order, newest first (`Read type: InReverseOrder` in `EXPLAIN actions = 1`), and stops at the `LIMIT`: 82,603 rows for the same page, about one block per day's part, however many records the period holds; the traces list read 23,168 of 400,000 root spans instead of all of them. A list fetches twice its page and one more row, and drops a row with the same time and ID as the row before it: copies of one record share those, so they sit next to each other in that order. The cursor is the last row's time and ID, as before. The environments and services lists, and "has the project sent anything", read no `FINAL` either: copies do not change them.

```text
GET /api/projects/:id/traces?period=7d&environment=…&service=…&name=…&errors=true&minDuration=<ms>&before=<cursor>
GET /api/projects/:id/traces/:traceId[?at=<ISO time>]
GET /api/projects/:id/traces/:traceId/spans/:spanId?start=<ns since 1970>
GET /api/projects/:id/logs?period=7d&environment=…&service=…&severity=warn&search=…&traceId=…&before=<cursor>
GET /api/projects/:id/logs/:logId?time=<ns since 1970>
GET /api/projects/:id/metrics?period=7d&environment=…
GET /api/projects/:id/metrics/chart?period=7d&environment=…&name=…&kind=gauge|counter|updown|histogram&split=<attribute key>&host=<host.name>&attr=<key>&attrValue=<value>
GET /api/projects/:id/services?period=7d&environment=…
GET /api/projects/:id/services/chart?period=7d&environment=…&service=<name>&route=<route>
GET /api/projects/:id/services/routes?environment=…
GET /api/projects/:id/hosts?period=7d&environment=…
GET /api/projects/:id/hosts/charts?host=<host.name>&period=7d&environment=…
```

- **Time:** the days asked for, in the instance's timezone, as on the other pages (at most 366), cut to the retention: nothing older than `TELEMETRY_RETENTION_DAYS` is read.
- **The traces list:** root spans (no parent) of the range and environment, newest first, 100 a page; the next page starts below the last row's time and ID (`before`, a cursor the API gives as `next`). A name filter is a part of the root's name, any case; a minimum duration is the root's. "With errors" keeps traces with a failed span in the range or an hour either side, from the latest 10,000 failed spans there, so the set ClickHouse builds for the filter stays bounded; with more failures than that in a period, a shorter period finds the older ones. Each row's span count and Error badge come from a second query for the page's trace IDs, in the same window (the range, an hour either side), so the badge and the filter agree. A trace whose root never arrived is not listed; a trace with two roots is listed twice. The environments and services to choose from come from the range's root spans, grouped (1,000 pairs at most).
- **A trace:** its spans by trace ID, which the bloom filter on `trace_id` finds (on a table of 3 million spans, it read 4 of 381 granules), within the retention, or a day either side of `at` when the page knows when the trace ran (an error's occurrence, the list's start time). At most 2,000 spans, by start; past that, a count of all of them says how many the page leaves out. Its log records the same way, at most 500, oldest first, as summaries (below). A trace with nothing kept answers with no spans, not an error, and the page says it may be past the retention.
- **A span:** found by its row's key (project, start, and ID), so its attributes, events, links, and resource attributes are read only when it is chosen: a trace's page lists only what the waterfall needs.
- **Logs:** newest first, 50 a page, by cursor as the traces list. A list sends a summary of each record: its ID, time, severity, service, environment, trace and span, event name, and the first 1,000 characters of its body, cut by ClickHouse (`substringUTF8`), with `bodyTruncated` when there is more. A record may hold a 64 KB body, 128 attributes of 4 KB, and 8 KiB of resource attributes, so whole records would make a page of 50 about 30 MB, and a trace's 500 about 290 MB; a summary is about 1 KB. Opening a record reads it whole (`/logs/:logId?time=`), found by its row's key (project, time, and ID), as a span is. A minimum severity is a severity number: Info and above is 9 and up; records with no severity (0) are left out once one is chosen. A trace ID uses the bloom filter. Words use the text index on `body`: the search is cut into words as the index cuts bodies (`splitByNonAlpha`: ASCII letters and digits, and anything beyond ASCII, so `card_declined` is the two words `card` and `declined`), at most 8, and each must be in the body, in any case, whole or as part of a longer word (`body ILIKE '%word%'` per word, all of them). A word never holds `%`, `_`, or a backslash, which separate words. In ClickHouse 26.8, `hasToken`, `hasAnyTokens`, `hasAllTokens`, `LIKE '%word%'`, and `ILIKE '%word%'` read the index: on a table of 2 million records with a word in 11 of them, `EXPLAIN indexes = 1` showed `body_text` keeping 1 of 254 granules for each, with query parameters and `FINAL` too. `hasTokenCaseInsensitive` reads every body, and so does a pattern of two words with a space between them, which is why each word is its own condition. A test (`telemetry-dashboard.test.ts`) checks that the plan still names the index, so an upgrade that loses it fails.

### How metrics are charted

- **The list:** the metrics with points in the range and environment, from both metric tables, grouped by name and kind, by name, at most 1,000 (the answer says when there were more). A kind is what the dashboard calls each: a gauge; a counter (a monotonic sum); an up-down counter (a sum that is not monotonic); a histogram (explicit buckets). A name sent as two kinds is listed twice. Each has its latest unit, up to 10 of its services and how many there are, and its latest point's time. Read without `FINAL`: copies change none of these.
- **A series** is one value of the `series` column ([storage](#storage)). A chart reads at most 1,000 series, those with the most points in the range, found by a first query; the answer gives how many it read and whether there were more. The metric's name is a query parameter of at most 1,024 bytes, as ingestion stores it; a split key at most 256 characters.
- **Time buckets:** from the start of the range's first day in the instance's timezone, of the shortest length of 1, 2, 5, 10, 15, or 30 minutes, 1, 2, 3, 6, or 12 hours, 1 or 2 days, or a week that keeps them within 300, up to the end of the range or now, whichever is sooner. A day is 288 buckets of 5 minutes; 7 days, hours; 30 days, 3 hours. Points are read `FINAL`, so a retried point counts once, from an hour (or a bucket, if longer) before the range, so a cumulative series' first point in the range has the one before it.
- **Gauges:** the average, minimum, and maximum of the points in each bucket.
- **Up-down counters:** each series' last value in each bucket, added up: how many connections were open, across all the processes. A series that sent nothing in a bucket adds nothing to it.
- **Counters:** a rate per second. ClickHouse orders each series' points by time (`lagInFrame`), apart for each start time: two processes that share a series (the same attributes, no `service.instance.id`) but started at different times are two runs, so their values do not mix. A cumulative point's increase is its value less the previous point's. A value below the previous one is a reset: the new value is the increase. A run's first point counts from its start time when that is known and within what was read; otherwise it is only the base for the next. Each increase is spread over the buckets its interval (from the previous point, or the start, to the point) covers, in proportion to the overlap, at most the chart's buckets, so a process that exports every 15 minutes counts in each 5-minute bucket, not a third of them. A delta point's value counts in its own bucket. A bucket's rate is its increases over its seconds (the first and last cut to the range and now). Unspecified temporality is read as cumulative.
- **Histograms:** the observations per second are worked out from the count as a counter's rate, per point, with every series. The percentiles come from the bucket counts of the series with the bounds that have the most points: each series' counts per bucket are its last point's in the bucket (cumulative) or all its points' added up (delta), and a cumulative series' bucket counts less the bucket before's (all of them when any went down, or the run started then). The window that takes these differences sorts one row per series and bucket rather than per point, so its memory does not grow with the points; a reset inside a bucket counts only the counts since it. A bucket's counts are added up, then the 50th, 95th, and 99th percentiles are interpolated: the rank `q × total` falls in one bucket, and the value is that far along a straight line between the bucket's lower and upper bound. The first bucket starts at the minimum when known (else 0, or its bound when that is not above 0); the last, which has no upper bound, ends at the maximum when known, else at its lower bound. A cumulative point's minimum and maximum are those since its start, so they can be wider than the bucket's. Series with other bounds, or without bucket counts, are left out of the percentiles and counted in the answer; a histogram whose points carry no bucket counts has a rate and no percentiles.
- **Split by an attribute:** one line per value of an attribute key the metric's series have (the chart offers up to 100, by name), with points without it as one line of their own. Lines rank by volume over the whole range: points for gauges and up-down counters, the increase for counters, observations for histograms. With more than 8 values, the 7 with the most volume keep their lines and the rest are added up as one "other" line, in ClickHouse (`dense_rank` over the values), so a chart sends at most 8 lines of 300 values. A gauge's other line is the average, minimum, and maximum of all their points.
- **Cost,** measured on the development machine (ClickHouse 26.8, the 4 GB Podman machine, scratch databases dropped after), with the settings above:
  - A busy project: 200 metrics of 25 series each, a cumulative point a minute, one day (7.2 million rows). Ordered by time, one metric's chart read every row of the day, about 3.4 GiB, and a 30-day chart about 107 GiB, past the 15 seconds. Ordered by name, a chart reads its metric's granules only: 65,536 rows and 3 MiB to find the series (5 ms, 8 MiB of memory), 90,112 rows and 5.4 MiB for the chart (27 ms, 12 MiB); split by an attribute, 9.2 MiB read (31 ms, 16 MiB).
  - A cumulative histogram of 30 series with 64 bounds (65 buckets), a point a minute. Before the per-bucket counts, a 7-day chart passed 300 MB and failed. Now 7 days: 267,392 rows and 146 MiB to find the series (27 ms), 539,264 rows and 165 MiB for the chart (181 ms, 75 MiB of memory); 30 days (1.3 million points): 1,260,992 rows and 688 MiB (104 ms, 27 MiB), then 2,521,984 rows and 770 MiB for the chart (593 ms, 84 MiB); split by an attribute, 983 ms and 134 MiB. The chart reads the metric's rows twice, once for the rate and once for the counts.

### How services are counted

A request is a span of kind `SERVER`; its route is its `http.route` attribute, or its name when it has none. For each service, and each of its routes, the page counts the requests in the range and environment, the failed ones (status `ERROR`), the median, 95th, and 99th-percentile duration, interpolated between the two nearest durations (`quantilesExactInclusive`, as the Speed page's p75), and the requests by status class. Two queries (`listServices` in `services.ts`), each over the spans `serverSpans` reads:

1. The counts, by a hash of each route rather than its name, for each service and each route at once (`GROUPING SETS ((service), (service, route))`), keeping each service's 100 busiest routes (`LIMIT 101 BY service`), at most 200 services. A service's route count is `uniq`: exact up to 65,536 routes, then approximate.
2. The names and the exact percentiles of each service and of the routes listed only: every other route's spans fall in one group per service, so the percentiles keep a few hundred groups however many routes there are.

- **Status classes:** a request's status code is its `http.response.status_code` attribute, else the older `http.status_code` (the newer name wins when a span has both). Its class is the code's hundreds: 2xx, 3xx, 4xx, or 5xx. A request with neither attribute, or with a code that is not a whole number from 200 to 599 (such as 101 or "OK"), counts as "no status". The five classes add up to the requests. A class is a count, not a failure: a 404 is not failed unless its span's status is `ERROR`.
- **A service's or route's charts** (`serviceChart`, `GET /api/projects/:id/services/chart?service=…&route=…`): one query over the same spans, grouped by time bucket and over the whole range at once (`GROUPING SETS ((), (bucket))`). The buckets are a metric chart's (`bucketsOf`): 5 minutes for a day, an hour for 7 days, 3 hours for 30 days. Each bucket has its requests and failed ones, each class's requests, and the exact median, 95th, and 99th percentile of its durations. The API gives each class's requests per second (its count over the bucket's seconds within the range and before now) and the failed share per bucket; a bucket without a request is 0 per second, and a gap in the failed share and the durations. A span later than the last bucket (a clock ahead of the server's) counts in the last, so the buckets add up to the totals. The totals come from the same read and are the Services page's numbers for the same range and environment: `telemetry-services.test.ts` checks both. A service name is a query parameter of at most 256 characters, a route of at most 4 KB, as ingestion stores them.
- **Without `FINAL`.** The Services page and these charts read spans without `FINAL` (`SERVICES_FINAL`), as the alert rules do ([uptime and alerts](uptime-alerts.md#step-4-alerts-on-telemetry-as-built)): a retried span counts twice, in the requests, the classes, and the percentiles alike, until its day is merged, which the spans table forces within about an hour of the day's last insert ([storage](#storage)). A retry is rare, and a copy barely moves a share or a percentile; with `FINAL`, a busy project's page failed (below). The list and the charts read the same way, so they agree, copies included (`telemetry-services.test.ts` sends one batch twice, with merges stopped, and finds both doubled). `PREWHERE` reads the project's rows of the range (and of the service, for a chart) before a span's attributes, which hold its route and status code.
- **Measured** on the development machine (ClickHouse 26.8, the 4 GB Podman machine, scratch databases dropped after), with the dashboard's settings: a project with 6 million spans over 7 days (4.8 million server spans, 5 services, 200 routes, each span with 6 attributes as an HTTP server's, a tenth with the older names). "Unmerged": 60 inserts, each spread over the whole 7 days, merges stopped, 421 parts (about 60 a day), plus 1,000 retried copies; "merged": one part a day. Rows and bytes read, then the query's memory and time:

  | Read, 7 days                | Unmerged, without `FINAL`               | Unmerged, `FINAL`                     | Merged, either                |
  | --------------------------- | --------------------------------------- | ------------------------------------- | ----------------------------- |
  | Services page: environments | 6,001,000 rows, 155 MiB; 14 MiB, 0.47 s | never `FINAL`                         | 154 MiB; 6–9 MiB, 0.28 s      |
  | Services page: counts       | 6,001,000 rows, 926 MiB; 14 MiB, 1.3 s  | failed at 300 MB after 1,288,043 rows | 924 MiB; 6 MiB, 1.0–1.1 s     |
  | Services page: percentiles  | 6,001,000 rows, 972 MiB; 107 MiB, 1.4 s | not reached                           | 970 MiB; 99 MiB, 1.2 s        |
  | A service's charts          | 6,001,000 rows, 965 MiB; 38 MiB, 0.85 s | failed at 300 MB after 5,721,337 rows | 964 MiB; 27 MiB, 0.47–0.50 s  |
  | A route's charts            | 6,001,000 rows, 973 MiB; 15 MiB, 0.66 s | failed at 300 MB after 1,413,603 rows | 970 MiB; 6–8 MiB, 0.47–0.48 s |

  Over one day (349,575 rows), every query passed either way: at most 86 MiB with `FINAL` on the unmerged parts, 8 MiB without. With one part a day, `FINAL` costs nothing, since a part alone has nothing to merge; with many parts, it fails past the 300 MB a query may use. Without it, the largest read is the percentiles' 107 MiB. Every read covers all the project's spans in the range, of every kind, with their attributes, since spans are ordered by project and time, not by service, kind, or environment: a route's chart reads as much as the whole page. At these rates, about 60 million spans of every kind in a period would reach the 15 seconds, and the page says to narrow the period; fewer with large attributes such as SQL statements. A project whose requests are 10% of its spans, the other 90% client spans carrying `db.statement`, read 355 MiB per 100,000 requests, so about 6 million requests would reach the 15 seconds. A per-minute rollup of requests by route, which the route alert rules' 30-minute cap also waits for, would make these reads small.

Earlier, on 3 million server spans over 7 days with a million span names and no `http.route`, one query keeping every route's durations used 443 MiB; split in two as above, the counts read 3,000,000 rows (174 MiB) in 1.7 s with 206 MiB of memory, a million route groups spilled to disk past 100 MB, and the percentiles the same rows in 268 ms with 84 MiB.

A route on the Services page opens its page; a link beside it opens the Traces page filtered by its service and the route as part of the root span's name, so a route that is only ever a child span's (behind a gateway) finds no trace there.

## Hosts

A server's own health (its CPU, memory, disks, network, and load) comes from an OpenTelemetry Collector running on it, with the Collector's host metrics receiver. The Collector sends these as ordinary OTLP metrics, which Ottertrail stores as any other ([storage](#storage)); the Metrics page can chart each one alone. The Hosts pages read them together, per host. Nothing of Ottertrail's own runs on the server.

### What the pages read

A host is the `host.name` attribute of the metrics' resource, which the Collector's resource detection processor sets ([below](#the-collector)). The host's name is matched as ingestion stores it: a value of at most 4 KB, any characters.

Only the receiver's metrics count. An app's SDK can send metrics with the same names under the same `host.name`: OpenTelemetry's Node.js SDK sets `host.name` with its host detector, and its `@opentelemetry/host-metrics` package sends `system.cpu.time`, `system.cpu.utilization`, and `system.memory.usage` for the app's machine. Counted as the host's, an app alone would be listed as a host, and an app beside a Collector would add its own series to the host's CPU and memory. So every query keeps only the series of an instrumentation scope whose name starts as the receiver's scrapers name theirs: `github.com/open-telemetry/opentelemetry-collector-contrib/receiver/hostmetricsreceiver/` (now: the scraper's package, such as `…/internal/scraper/cpuscraper`), or `otelcol/hostmetricsreceiver/` (older releases, such as `otelcol/hostmetricsreceiver/cpu` in v0.80.0). Both were read in the receiver's generated code (`internal/metadata`) on 18 November 2026.

The names, units, and attributes are those of the host metrics receiver's scrapers and of OpenTelemetry's semantic conventions for system metrics, checked on 18 November 2026 (the receiver's [CPU](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/cpuscraper/documentation.md), [memory](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/memoryscraper/documentation.md), [filesystem](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/filesystemscraper/documentation.md), [network](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/networkscraper/documentation.md), [disk](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/diskscraper/documentation.md), and [load](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/internal/scraper/loadscraper/documentation.md) scrapers; the [semantic conventions](https://opentelemetry.io/docs/specs/semconv/system/system-metrics/), still in development):

| Metric                                                             | Kind and unit          | Attributes read                                                          | On by default |
| ------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------ | ------------- |
| `system.cpu.time`                                                  | Counter, seconds       | `state` (`idle`, `user`, `system`, `wait`, …)                            | Yes           |
| `system.cpu.utilization`                                           | Gauge, 0 to 1          | `state`                                                                  | No            |
| `system.memory.usage`                                              | Up-down counter, bytes | `state` (`used`, `free`, `buffered`, `cached`, `slab_…`)                 | Yes           |
| `system.memory.utilization`                                        | Gauge, 0 to 1          | `state`                                                                  | No            |
| `system.filesystem.usage`                                          | Up-down counter, bytes | `mountpoint`, `mode`, `state` (`used`, `free`, `reserved`)               | Yes           |
| `system.filesystem.utilization`                                    | Gauge, 0 to 1          | `mountpoint`, `mode` (the receiver's has no state: it is the share used) | No            |
| `system.network.io`                                                | Counter, bytes         | `direction` (`receive`, `transmit`), every `device` added up             | Yes           |
| `system.disk.io`                                                   | Counter, bytes         | `direction` (`read`, `write`), every `device` added up                   | Yes           |
| `system.cpu.load_average.1m`, `system.cpu.load_average.5m`, `…15m` | Gauge, threads         | none                                                                     | Yes           |

The semantic conventions name some attributes differently from the receiver: `cpu.mode` for the CPU's state, `system.memory.state`, `system.filesystem.state`, `system.filesystem.mountpoint`, `system.filesystem.mode`, `network.io.direction`, and `disk.io.direction`; older conventions had `system.cpu.state`. The pages read any of them, the receiver's first, so a receiver that moves to the conventions' names keeps working. The conventions define no load average; the receiver's names are read.

The utilization metrics are off by default, so without them the shares are worked out from the default metrics, the fallbacks below. The configuration the page shows ([below](#the-collector)) turns them on, so the shares are exact; the pages prefer them when sent.

### How the values are worked out

Each chart reads its metrics as the Metrics page does ([above](#how-metrics-are-charted)): rates from cumulative sums with resets and restarts, a gauge's average per bucket, an up-down counter's last value per series and bucket added up. Every chart query also filters by the host (`resource_attributes['host.name']` equal to a query parameter) and the receiver's scopes, and splits by the first of the attribute's names a point has. Shares are percentages from 0 to 100.

- **CPU busy:** the share of CPU time not in the `idle` state, all CPUs together. From `system.cpu.utilization` when the host sends it: per bucket, each state's average, and the busy share is all states but idle over all states. Otherwise from `system.cpu.time`: each state's time per second (its rate, all CPUs added up), and the busy share is the same ratio of rates. `wait` (time waiting for I/O) counts as busy: it is not idle. The page also charts each state's share.
- **Memory used:** from `system.memory.utilization`'s `used` state when sent. Otherwise `system.memory.usage`'s `used` over the sum of its states but `slab_reclaimable` and `slab_unreclaimable`, which the receiver reports as parts of the others. That fallback is the default case, and it reads a little low: the receiver's feature gate that reads Linux's `MemAvailable` is in beta, so on by default, and with it `used` is the total less available memory, so the states add up to a little more than the total. (With the gate off, `used` is the total less free, buffers, and cache, and the states add up to the total exactly.) `system.memory.utilization` divides by the true total. The bytes chart is `system.memory.usage`'s `used`.
- **Filesystem used, per mount point:** read-only filesystems (`mode` `ro`) are left out: a snap package's squashfs image is always 100% used, so on Ubuntu the fullest would always be a snap. Then `system.filesystem.utilization` when sent (its `used` state, if it has states as the conventions define them); otherwise `system.filesystem.usage`'s `used` over all its states (used, free, and reserved): the share of the whole filesystem. Two charts of `system.filesystem.usage` are read, one of its `used` points and one of all, and divided line by line. Past eight mount points, the rest are added up as one line, as a split chart's are.
- **Network and disk:** `system.network.io` and `system.disk.io` per second, by direction, every device the receiver reads added up. The receiver reads the loopback interface, containers' virtual interfaces, whole disks with their partitions, and device-mapper and loop devices too, so without exclusions loopback traffic counts and a disk's bytes count two or three times (`sda`, `sda1`, and the `dm-0` on it). The configuration below leaves them out.
- **Load:** the 1, 5, and 15-minute load averages, each bucket's average, read in one query (`name IN (…)`, a line per metric).

The list shows each host's latest values in the period:

- a gauge's latest point per series (utilization, load), shares worked out as above;
- `system.cpu.time`: each series' increase between its last two points when both are of one run and the value did not go down (a delta point's value is its increase); a scrape interval up to about 7 minutes leaves two points in the window;
- per state, the latest value across the host's series of a metric (`argMax`), not their sum: after a Collector is upgraded, the old and new series (their scopes differ) both have recent points, and added up the memory share could pass 100%. A CPU's series stay apart, one per CPU, and are added up;
- the fullest filesystem: the share per mount point, read-only ones left out, then the highest, with its mount point.

A host is stale when nothing arrived from it in the 5 minutes before the request. That says something only while the period runs to now: for a period that ended before, the answer's `stale` is null and the page shows no badge.

### Routes

```text
GET /api/projects/:id/hosts?period=7d&environment=…
GET /api/projects/:id/hosts/charts?host=<host.name>&period=7d&environment=…
```

- **The list** makes three queries. The first finds the hosts and when each was last seen, from the host metrics' names (`name IN (…)`, so with the project ID a prefix of the sort key: only those metrics' rows are read), at most 500, by name; the answer says when there were more. The second lists the environments, as the other pages do. The third reads the latest values of the hosts listed, and only of the metrics the list shows (CPU, memory, filesystem, and the 1-minute load). Its time condition is each host's own window, from 15 minutes before its last point to that point, merged where they overlap, as ranges of the sort key (`(timestamp >= a AND timestamp < b) OR …`); each row is then kept only within its own host's window (`transform(host, hosts, cutoffs, 0)`). A host that stopped early in a long period thus reads its last minutes, not the period since. Measured on the development machine with 100 hosts sending 8 series a minute for 2 days, one of which stopped after its first hour (2.28 million rows): the query read 2,273,248 rows in 390 ms when bounded by the earliest window, and reads 86,860 rows in 30 ms by each host's. The first two queries still read the whole period's rows of those metrics, as finding the hosts needs.
- **A host's charts** make at most 10 chart queries and one for when it was last seen: each chart ranks its series (at most 1,000) inside its own query, rather than in a query of its own as the Metrics page does, since one host has few series. Each reads within its metric's rows of the project.
- A host name is refused past 4 KB, as ingestion cuts attribute values there.

All carry the dashboard's settings and the limit on queries at once ([how the pages read](#how-the-pages-read)).

### The Collector

The configuration the Hosts page shows, with the instance's address, while a project has sent no host metrics:

```yaml
receivers:
  host_metrics:
    collection_interval: 1m
    scrapers:
      cpu:
        metrics:
          system.cpu.utilization:
            enabled: true
      memory:
        metrics:
          system.memory.utilization:
            enabled: true
      filesystem:
        exclude_fs_types:
          fs_types: [squashfs]
          match_type: strict
        exclude_mount_points:
          mount_points: ["^/snap/.*$"]
          match_type: regexp
        metrics:
          system.filesystem.utilization:
            enabled: true
      network:
        exclude:
          interfaces: ["^(lo|veth.*|docker.*|br-.*)$"]
          match_type: regexp
      disk:
        exclude:
          devices:
            - "^(loop|ram|sr|dm-)[0-9]*$"
            - "^(sd|vd|xvd|hd)[a-z]+[0-9]+$"
            - "^(nvme[0-9]+n[0-9]+|mmcblk[0-9]+)p[0-9]+$"
          match_type: regexp
      load:

processors:
  resource_detection:
    detectors: [system]
    system:
      hostname_sources: [os]
  batch:
    send_batch_max_size: 8192

exporters:
  otlp_http:
    endpoint: https://analytics.example.com
    headers:
      Authorization: Bearer sk_…

service:
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [resource_detection, batch]
      exporters: [otlp_http]
```

- **Names:** the Collector's components were renamed with underscores (`host_metrics`, `resource_detection`, `otlp_http`); older releases know them as `hostmetrics`, `resourcedetection`, and `otlphttp`. The exporter's and the processor's documentation keep the old names as deprecated aliases.
- **Utilization metrics:** on, so CPU, memory, and filesystem shares are the receiver's own, divided by the true totals.
- **Filesystems:** snap packages' read-only squashfs images and their `/snap/…` mount points are left out (the pages also leave out any read-only filesystem).
- **Network:** the loopback interface and containers' (`veth…`, `docker…`, `br-…`) are left out, so only traffic in and out of the machine counts.
- **Disks:** loop, RAM, optical, and device-mapper devices, and partitions (`sda1`, `nvme0n1p1`, `mmcblk0p1`) are left out, so each disk's bytes count once, from the whole disk. The patterns are anchored (`^…$`), so they mean the same whether the receiver matches a whole name or a part of one.
- **`host.name`:** the resource detection processor's `system` detector sets it. `hostname_sources: [os]` takes the operating system's name; its default tries DNS first, for a fully qualified name.
- **Batches:** `send_batch_max_size` bounds each request ([limits](#limits)).
- **In a container,** the receiver needs the host's root filesystem mounted and named with `root_path` (such as `/hostfs`), or it measures the container.
- **The key** is the project's secret key, under "Your server" in its settings; the page shows `sk_…` in its place and never prints the key.

## Planned next

Decided on 18 November 2026, after the alerts of stage 4 ([uptime and alerts](uptime-alerts.md)), in this order:

1. **Alerts on telemetry:** a route's p95 or p99 duration, or its failed share, above a value, and any metric (a queue's depth, a dead-letter queue, a connection pool's use, a host's CPU) above or below one, over a window; stage 4's fourth step. Done on 18 November 2026: [what was built](uptime-alerts.md#step-4-alerts-on-telemetry-as-built). The rules count requests as the Services page does, a project's route rules of one environment in one read without `FINAL` (`routeWindows` in `services.ts`), and read a metric as its chart does, as one bucket covering the window (`metricWindow` in `metrics.ts`); a metric's chart also takes a host and an attribute value now (`host`, `attr`, `attrValue`), and `GET /api/projects/:id/services/routes` lists up to 200 services and routes of the last day for the alert form.
2. **Services over time:** per route, the 99th percentile beside the median and the 95th, requests by status class (2xx, 3xx, 4xx, 5xx, from `http.response.status_code`), and charts over the period of requests per second, the failed share, and p95, as well as the totals. Done on 18 November 2026: [how services are counted](#how-services-are-counted). Each service and route has a page with its totals and charts of requests per second by status class, the failed share, and the median, 95th, and 99th percentile (`GET /api/projects/:id/services/chart`); the Services page and these charts read spans without `FINAL`, measured to fail past 300 MB with it on a busy project's unmerged parts.
3. **Databases:** the database calls inside traces (client spans with `db.system`), summed by database and operation: calls, the 95th-percentile duration, and failures, over the period, with a link to traces that hold them. The answer to "which query got slow".

## Not in the first version

- Charts that combine metrics, such as a cache's hit ratio from its hit and miss counters; saturation on the Hosts pages beyond the load average.
- gRPC, and OTLP from browsers.
- Exponential histograms and summaries (refused, and counted in `partial_success`).
- Profiles, a live tail of logs, sampling.
- Retention chosen per project.
- Linking a browser's page load to the backend trace it started (`traceparent`).
- Searching log bodies for a phrase: each word is matched on its own ([above](#how-the-pages-read)).
- Filtering traces by an attribute, and a trace's whole span count in the list (it counts the trace's spans in the period, an hour either side).
- "With errors" over more than the latest 10,000 failed spans of a period.
- Splitting a metric by a resource attribute or by service, filtering a chart by an attribute on the Metrics page (the Hosts pages filter by `host.name`), and a histogram's series with other bounds in the same chart.
- On the Hosts pages: swap, paging, disk operations and time, per-CPU and per-interface charts, processes (`process.*` metrics), and a total memory from `system.memory.limit`. Each can be charted alone on the Metrics page when the receiver sends it.
- A route's request methods apart: `GET` and `POST` of one `http.route` are one route.

## How it is built

| Step                                                                                                                          | Status                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1. ClickHouse's tables, decoding, the three routes, their answers, limits, and budgets; tests with protobuf and JSON requests | Done                         |
| 2. Exceptions into the error list                                                                                             | Done                         |
| 3. The dashboard's Traces, Logs, Metrics, Services, and Hosts pages                                                           | Done                         |
| 4. Deployment: the settings ([deployment](deployment.md#traces-logs-and-metrics)), and what has been tested                   | Waiting for the hosting work |

Step 1 is in `apps/api/src/telemetry/` (routes, decoding, rows) and ClickHouse migration `0001_create_tables`. Besides requests built by hand in both encodings, its tests send through OpenTelemetry's own JavaScript exporters (protobuf and JSON, for traces, logs, and metrics) and check what ClickHouse stored. The message definitions are those of opentelemetry-proto 1.11.1, kept in `apps/api/src/telemetry/proto/` with their licence, which the built API carries in its `THIRD_PARTY_LICENSES.txt`.

Step 2 is in `apps/api/src/telemetry/exceptions.ts` (the error events), `normalize.ts` (finding the exceptions), the server stack parsers in `apps/api/src/errors/fingerprint.ts`, and the events table's `service`, `trace_id`, and `span_id` columns (ClickHouse migration `0001_create_tables`). Its tests send exceptions on spans and in log records, in both encodings, and check the error events stored, a retry kept once, their cost, the Errors API, and a ClickHouse failure.

Step 3's first half, the Traces and Logs pages, is in `apps/api/src/telemetry/dashboard-routes.ts`, `traces.ts`, `logs.ts`, and `dashboard-query.ts`, and `apps/web/src/features/telemetry/`. Its API tests (`apps/api/tests/telemetry-dashboard.test.ts`) send spans and log records over OTLP and check the list, its filters and pages, a trace's spans, parents, logs, and cap, a span's detail, the log search (words, severity, service, trace, pages), log summaries (their size and cut body) and a record's detail, a retried span's and record's copies dropped across pages of rows at one time, all-zero IDs and labels with control characters, that the plans still use the indexes, bad parameters, and that an unknown project gets 404.

Step 3's second half, the Metrics and Services pages, is in `metrics.ts` and `services.ts` beside them, and `apps/web/src/features/telemetry/`. Its API tests (`apps/api/tests/telemetry-metrics.test.ts`) send metrics and spans over OTLP, each twice as a retry would, and check numbers worked out by hand: a gauge's average, minimum, and maximum per bucket; a cumulative counter's rate with a reset and a restart; a delta counter's; sparse, staggered senders; two writers of one series told apart by their start; an up-down counter's total; a cumulative and a delta histogram's percentiles and rate, and one without bucket counts; a split with its top values and "other"; the series cap; the list of metrics; services' requests, failures, median, and 95th percentile per service and route; bad parameters; and that an unknown project gets 404. `telemetry-dashboard-limit.test.ts` checks the 300 MB limit and its 503, and the limit of queries at once (waiting, refusal with `Retry-After`, a closed request leaving the queue); `telemetry-normalize.test.ts` the refusal of histograms with more than 64 bounds or counts of 2^63 or more.

The Hosts pages are in `hosts.ts`, which reads through `metrics.ts`'s charts with a filter by a resource attribute, and `apps/web/src/features/telemetry/` (`hosts-page.tsx`, `host-page.tsx`). Their API tests (`apps/api/tests/telemetry-hosts.test.ts`) send two hosts' metrics over OTLP as the receiver would, each twice as a retry would, and check numbers worked out by hand: the list's CPU busy share from the last two points of `system.cpu.time` across two CPUs, memory without the slab, the fullest of two filesystems, the latest load, last seen and stale against a fixed clock; a host's charts (CPU busy and by state, memory in percent and bytes, filesystems per mount point, network bytes per second by direction, load); the utilization metrics preferred when sent, with the conventions' `cpu.mode`; that one host's chart leaves the other's out; that metrics without `host.name`, and an SDK's with it (`@opentelemetry/host-metrics`, `system.cpu.state`), are no host's, even under a Collector's host name; scopes of older and newer receivers; a snap's read-only filesystem left out of the fullest and the charts; an upgraded Collector's two series counted once; that a host that stopped early in the day leaves the latest values' query reading its last minutes (under 40,000 rows of `system.query_log`'s `read_rows`, where the day holds 247,600); the merged windows; staleness only for a period that runs to now; that a failed query ends its request's other queries over a real connection, so they free their places; bad parameters; and that an unknown project gets 404. `telemetry-dashboard-limit.test.ts` checks a request's share of the places.
