# Events in ClickHouse

How analytics events move from PostgreSQL to ClickHouse, and why. The decision to use ClickHouse, and the measurements behind it, are in [storage-benchmark.md](storage-benchmark.md).

| Step                                                                        | Status |
| --------------------------------------------------------------------------- | ------ |
| 1. ClickHouse in the stack, its settings for a small server, its migrations | Done   |
| 2. The worker copies events to ClickHouse                                   | Done   |
| 3. Reports read ClickHouse; PostgreSQL keeps only the last day of events    | Next   |
| 4. Retention and project deletion in ClickHouse; backups; terminal scripts  | Later  |

Until step 3, reports still read PostgreSQL, and ClickHouse's copy is not used.

## How events get there

1. The collection endpoint stores events in PostgreSQL, as before, and confirms them once PostgreSQL has committed them. PostgreSQL's unique `(project_id, event_id)` turns a retried event into a duplicate it ignores.
2. Every 5 seconds the worker copies the events not yet copied (`events.copied_at` is null) to ClickHouse, 10,000 at a time, oldest arrivals first, and marks them copied (`apps/api/src/clickhouse/copy-events.ts`).
3. Reports will read ClickHouse, so they trail arrivals by the copy interval plus the copy itself: a few seconds.

ClickHouse's `events` table (`apps/api/src/clickhouse/migrations.ts`) has the same columns as PostgreSQL's. It is ordered by project, then time, so one project's range is one contiguous read; partitioned by month; and a `ReplacingMergeTree`, which keeps one row per `(project_id, occurred_at, event_id)` when it merges parts.

## Each event once

ClickHouse has no unique constraint, so duplicates must be kept out before they arrive:

- **Retries** never get past PostgreSQL's unique key, as before.
- **Two workers** never copy the same events: a batch's rows stay locked (`FOR UPDATE SKIP LOCKED`) until they are marked copied. A test runs two copies at once; without the locks it fails every time.
- **A crash** between ClickHouse storing a batch and PostgreSQL marking it means the next run sends the same rows again. ClickHouse drops an insert identical to one of its last 1,000 (`non_replicated_deduplication_window`), and the batch carries a deduplication token made from its events too. A test sends a batch, clears the marks, and copies again: ClickHouse still holds each event once.
- **Anything else** that gets through is merged away by the `ReplacingMergeTree`, and reports can read with `FINAL`, which the [benchmark](storage-benchmark.md) found costs almost nothing.

Step 3 deletes events from PostgreSQL once they are copied and older than a day: the endpoint refuses events more than 24 hours old (`MAX_EVENT_AGE_MS`), so no retry can arrive after that, and PostgreSQL's unique key still covers every retry that can.

## When ClickHouse is down

Collection does not depend on ClickHouse: events keep arriving in PostgreSQL, the worker logs the failure once, and copies everything when ClickHouse is back. A test copies against an unreachable ClickHouse, checks the events are still waiting, then copies them.

## 64-bit integers

Visitor IDs are 64-bit integers. ClickHouse 26 sends 64-bit integers in JSON as bare numbers, which JavaScript rounds (`-4611686018427387904` came back as `-4611686018427388000`), so the client asks for them as strings (`output_format_json_quote_64bit_integers`). Counts arrive as strings too.

## Not done yet

- Reports reading ClickHouse, and PostgreSQL keeping only the last day (step 3).
- Retention and project deletion in ClickHouse (step 4). Until then, a deleted project's events, or events past their retention, stay in ClickHouse's unused copy.
- ClickHouse backups (step 4).
- Watching how far the copy trails, beyond the worker's log.
