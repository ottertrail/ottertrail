# Storage benchmark: PostgreSQL and ClickHouse

**Decision (17 November 2026):** analytics events, and later logs, traces, and metrics, will be stored in ClickHouse. PostgreSQL keeps users, projects, and settings. TimescaleDB, PostgreSQL with time-series extensions, was considered and not pursued. This page records the measurements behind the decision and what they mean for the design. Nothing has moved to ClickHouse yet.

## How it was measured

`vp run bench:storage` ([apps/api/scripts/bench-storage.ts](../apps/api/scripts/bench-storage.ts)) generates fake visits in a temporary PostgreSQL schema ([bench-data.ts](../apps/api/scripts/bench-data.ts), the same generator as `vp run bench:reports`), then copies them into a temporary ClickHouse database, so both hold exactly the same events. Each report then runs in both:

- PostgreSQL through the API's own report functions (`src/reports/reports.ts`).
- ClickHouse through the same rules written in its SQL: visits split after 30 idle minutes, engagement reports that extend a visit but never start one, stale engagement reports ignored (`src/visits/visits.ts`), then the summary, visitors per day, top pages, countries, and custom events.

Every answer is compared before any time is shown. **In every run, every report gave the same answer in both databases.**

Times are the median of three runs after a warm-up run. The setup:

|                  |                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL       | 18.7, the development container, default settings (`shared_buffers` 128 MB, `work_mem` 4 MB)                                                                                                       |
| ClickHouse       | 26.8.38.9 (long-term support), its own container limited to 2 CPUs, which also caps it at 2 threads per query ([bench-clickhouse.compose.yaml](../apps/api/scripts/bench-clickhouse.compose.yaml)) |
| Machine          | Podman VM on an Apple silicon Mac: 7 CPUs and 2 GB of memory, shared with other containers (0.5 to 0.9 GB available)                                                                               |
| ClickHouse table | `ReplacingMergeTree`, partitioned by month, ordered by `(project_id, occurred_at, event_id)`                                                                                                       |

## Events: 200,000 visits over 30 days (1.23 million events)

| Report           | 1 day: PostgreSQL | 1 day: ClickHouse | 7 days: PostgreSQL | 7 days: ClickHouse | 30 days: PostgreSQL | 30 days: ClickHouse |
| ---------------- | ----------------- | ----------------- | ------------------ | ------------------ | ------------------- | ------------------- |
| Summary          | 134 ms            | 38 ms             | 925 ms             | 123 ms             | 2,435 ms            | 447 ms              |
| Visitors per day | 77 ms             | 23 ms             | 530 ms             | 70 ms              | 1,322 ms            | 252 ms              |
| Top pages        | 28 ms             | 12 ms             | 124 ms             | 48 ms              | 412 ms              | 170 ms              |
| Countries        | 89 ms             | 29 ms             | 496 ms             | 94 ms              | 1,240 ms            | 395 ms              |
| Custom events    | 7 ms              | 4 ms              | 40 ms              | 9 ms               | 51 ms               | 26 ms               |

- **Speed:** ClickHouse was 3 to 8 times faster on the reports that work out visits, and 2 to 4 times on the simple counts.
- **Disk:** PostgreSQL 342 MB (table and indexes), ClickHouse 55 MB.
- **ClickHouse's memory per query:** up to 171 MB (countries, 30 days). The visit reports need the most, because they sort all of a range's events by visitor.
- **Duplicates:** reading with `FINAL`, which removes rows with the same key at query time, cost almost nothing here. There were no duplicates to remove, so its cost with real retries is not measured.
- **ClickHouse beside PostgreSQL:** with ClickHouse stopped, PostgreSQL's times were the same within a few percent (summary, 30 days: 2,350 ms). Its presence did not slow PostgreSQL at this size.

The same PostgreSQL benchmark (`vp run bench:reports`) measured the whole 30-day analytics page at 0.87 s on 16 November and 5.5 s on 17 November, on the same machine. The memory left in the VM moves absolute numbers a lot, so only numbers from the same run compare.

## Events: 1 million visits (6.1 million events)

- **Loading:** PostgreSQL took 417 s to generate and index them. ClickHouse took 15 s to copy and merge them.
- **Disk:** PostgreSQL 1,709 MB, ClickHouse 272 MB.
- **The reports could not run in 2 GB.** At the first report, the kernel's out-of-memory killer stopped ClickHouse, at 865 MB resident. PostgreSQL survived, but its data no longer fit in memory, and it read 500 to 600 MB/s from disk. The 3-million-visit run was not attempted.

## Logs: 3 million lines over 7 days

| Query                                        | PostgreSQL | ClickHouse | ClickHouse memory |
| -------------------------------------------- | ---------- | ---------- | ----------------- |
| Lines per hour and level, 7 days             | 878 ms     | 106 ms     | 10 MB             |
| "timeout", 1 day, newest 50                  | 4 ms       | 5 ms       | 10 MB             |
| "timeout", 7 days, newest 50                 | 4 ms       | 16 ms      | 20 MB             |
| Errors of one service, last hour, newest 100 | 3 ms       | 4 ms       | 9 MB              |
| "timeout" count, 7 days                      | 434 ms     | 100 ms     | 12 MB             |

Disk: PostgreSQL 428 MB (table and its `(project_id, ts)` index), ClickHouse 64 MB. ClickHouse wins whenever a query reads the whole range: counts and charts. "Newest lines matching" ties, because PostgreSQL walks back through its time index and stops once it has enough. The lines come from a few templates with numbers in them; real logs vary more.

## What this means for the design

1. **The rules port.** The visit logic, the hardest part, gives identical answers in ClickHouse's SQL, using window functions.
2. **ClickHouse needs memory headroom.** Working out visits at query time sorts a range's events in memory, and that grows with the range, the project, and the number of projects reporting at once. Two ways to handle it, not yet decided:
   - Work out each event's visit when it arrives and store it with a visit ID. Reports then count stored visits instead of sorting events.
   - Let large sorts spill to disk with ClickHouse's external sort and group-by settings.

   Either way, servers need more memory than PostgreSQL alone. 2 GB is too little; sizing is still to be measured.

3. **Data is 6 to 7 times smaller,** so it stays in memory much longer as it grows. Logs and traces are where this matters most.
4. **Retried events still need counting once.** ClickHouse has no unique constraint. `ReplacingMergeTree`, keyed by `(project_id, occurred_at, event_id)`, removes a retried event when it merges parts: a retry keeps its time and ID. Reports read with `FINAL` until then. The alternative is to keep landing events in PostgreSQL, which confirms them only once saved and keeps its unique key, then move batches to ClickHouse.
5. **Retention** becomes dropping old partitions, not deleting rows.

## Not measured

- A real server, real traffic, or more memory than 2 GB.
- Many projects in one table. The table is ordered by project first, so other projects mostly add disk rather than query time, but this is untested.
- Writing to ClickHouse in the small batches the tracker sends. ClickHouse prefers large inserts; its asynchronous inserts are the usual answer.
- Filtered reports, the whole 14-report page in ClickHouse, 3 million visits, and 10 million log lines.
