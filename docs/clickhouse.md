# Events in ClickHouse

How analytics events move from PostgreSQL to ClickHouse, and why. The decision to use ClickHouse, and the measurements behind it, are in [storage-benchmark.md](storage-benchmark.md).

| Step                                                                          | Status |
| ----------------------------------------------------------------------------- | ------ |
| 1. ClickHouse in the stack, its settings for a small server, its migrations   | Done   |
| 2. The worker copies events to ClickHouse                                     | Done   |
| 3. Reports read ClickHouse; PostgreSQL keeps only the last two days of events | Done   |
| 4. Retention and project deletion in ClickHouse; backups                      | Next   |

Until step 4, a project's retention and its deletion only reach PostgreSQL. ClickHouse keeps the events, so reports still show events past a project's retention; a deleted project's reports cannot be opened, but its events stay on disk. No backup covers ClickHouse yet.

## How events get there

1. The collection endpoint stores events in PostgreSQL, as before, and confirms them once PostgreSQL has committed them. PostgreSQL's unique `(project_id, event_id)` turns a retried event into a duplicate it ignores.
2. Every 5 seconds the worker copies the events not yet copied (`events.copied_at` is null) to ClickHouse, 10,000 at a time, oldest arrivals first, and marks them copied (`apps/api/src/clickhouse/copy-events.ts`).
3. Reports read ClickHouse, so they trail arrivals by the copy interval plus the copy itself: a few seconds. The same run records when each project's latest event happened (`projects.last_event_at`), which the dashboard shows.
4. Every hour the worker deletes events from PostgreSQL that are copied and over 48 hours old (below).

ClickHouse's `events` table (`apps/api/src/clickhouse/migrations.ts`) has the same columns as PostgreSQL's. It is ordered by project, then time, so one project's range is one contiguous read; partitioned by month; and a `ReplacingMergeTree`, which keeps one row per `(project_id, occurred_at, event_id)` when it merges parts.

## Each event once

ClickHouse has no unique constraint, so duplicates must be kept out before they arrive:

- **Retries** never get past PostgreSQL's unique key, as before.
- **Two workers** never copy the same events: a batch's rows stay locked (`FOR UPDATE SKIP LOCKED`) until they are marked copied. A test runs two copies at once; without the locks it fails every time.
- **A crash** between ClickHouse storing a batch and PostgreSQL marking it means the next run sends the same rows again. ClickHouse drops an insert identical to one of its last 1,000 (`non_replicated_deduplication_window`), and the batch carries a deduplication token made from its events too. A test sends a batch, clears the marks, and copies again: ClickHouse still holds each event once.
- **Anything else** that gets through is merged away by the `ReplacingMergeTree`, and reports read with `FINAL`, which the [benchmark](storage-benchmark.md) found costs almost nothing.
- **A power cut** right after an insert cannot lose the batch: an insert into `events` returns only once its data is on disk (`fsync_after_insert`, ClickHouse migration 0002), as a PostgreSQL commit does, and only then is the batch marked copied. Without it, a batch still in the operating system's cache would be lost for good once PostgreSQL deleted its own copy. The worker inserts one batch every few seconds, so the cost is small.

PostgreSQL keeps each event until it is copied and 48 hours old (`deleteCopiedEvents`). The endpoint refuses events more than 24 hours old (`MAX_EVENT_AGE_MS`), and PostgreSQL's unique key must hold an event as long as a retry of it can arrive. That age is measured on the sender's clock, though: a retry sent after the sender's clock was put back by some hours can arrive more than 24 hours after its event. The second day covers that, and the time requests spend on the way. Past it, a retry would be stored again, and ClickHouse would keep both: its key includes the time, which the server works out anew for each arrival. Events not copied yet stay, however old, so an outage never loses any. A test deletes what is old enough and checks that a retry of a kept event is still ignored.

## When ClickHouse is down

Collection does not depend on ClickHouse: events keep arriving in PostgreSQL, the worker logs the failure once, and copies everything when ClickHouse is back. A test copies against an unreachable ClickHouse, checks the events are still waiting, then copies them.

## Reports

Reports read ClickHouse's `events` with `FINAL` (`apps/api/src/reports/reports.ts`). PostgreSQL still works out where days start in the organization's timezone (`localDays`, `previousDays`) and holds the projects and their allowed hostnames; ClickHouse puts each event on its local day for the charts. Every timezone Node.js knows (423 names) is in ClickHouse 26.8's list too. Visits are still worked out when reports run, with the same rules as before ([web analytics, section 6](web-analytics.md#6-visits)), now with ClickHouse's window functions (`apps/api/src/visits/visits.ts`). The tests that define the rules kept every expected number and pass on ClickHouse. One detail differs: of two events in the same millisecond, either may come first (their IDs break the tie), and ClickHouse orders IDs differently from PostgreSQL, so such a visit's entry page or source can come from the other event.

The analytics page works out visits once per request, into a temporary table of a ClickHouse session of its own, which every report then reads ([dashboard](dashboard.md#visits-worked-out-once)). Filters, searches, and the timezone reach ClickHouse as typed query parameters, never in the SQL text; row limits and offsets are clamped to whole numbers first.

When ClickHouse runs out of memory for a report, the endpoint answers 503 and asks to try a shorter range or again in a minute. Any other failure answers 500 with a general message: ClickHouse's own error text, which can name servers, settings, and versions, stays in the log.

ClickHouse has no snapshot across queries, as PostgreSQL's REPEATABLE READ gave: events the worker copies while a page is worked out (a few seconds' worth) can reach some of its reports and not others.

### Memory

Working out visits takes memory in proportion to the visits in the range. On fake data, every visit of 200,000 over 30 days (1.2 million events), with all its columns, took 3.5 seconds and 265 MiB at most. Past half the free memory, ClickHouse continues large groupings on disk instead of failing (`max_bytes_ratio_before_external_group_by`, 0.5 by default); it did here. Even forced to go to disk early, the query still held about 250 MiB: some 1.3 KB per visit stays in memory.

How much memory ClickHouse may use is worked out again as it runs: its own memory plus what the system has free, times `max_server_memory_usage_to_ram_ratio` (0.4 in `deploy/clickhouse/`). On an 8 GB server with little else running, that is about 2.8 GB: by the measurement above, enough for one report to work out roughly 2 million visits, shared by the pages loaded at the same time. Larger sites need stored visits (an open decision, [roadmap](roadmap.md)) or a limit on reports per organization at once (not done).

The development stack runs in Podman's machine, 2 GB by default and shared with other containers. There 0.4 left ClickHouse about 350 MiB, nearly all of it its own idle use, and tests running side by side failed with `MEMORY_LIMIT_EXCEEDED`. The development stack alone raises the ratio to 0.75 (`deploy/clickhouse/development.xml`): about 680 MiB. Even so, ClickHouse's own memory there grows during heavy runs and takes minutes to shrink back, so the benchmark's whole-page part failed there in repeated runs at 50,000 and 200,000 visits. For more data locally, give the machine more memory (`podman machine set --memory 8192`, with the machine stopped).

## 64-bit integers

Visitor IDs are 64-bit integers. ClickHouse 26 sends 64-bit integers in JSON as bare numbers, which JavaScript rounds (`-4611686018427387904` came back as `-4611686018427388000`), so the client asks for them as strings (`output_format_json_quote_64bit_integers`). Counts arrive as strings too.

## Not done yet

- Retention and project deletion in ClickHouse (step 4). Until then, a deleted project's events, or events past their retention, stay in ClickHouse.
- ClickHouse backups (step 4). Until then, events older than two days are only in ClickHouse, and no backup holds them.
- A snapshot across a page's reports.
- A limit on how many reports one organization runs at once, so one customer's long ranges cannot use all of ClickHouse's memory.
- Watching how far the copy trails, beyond the worker's log.
