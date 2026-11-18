# Events in ClickHouse

How analytics events reach ClickHouse, and why. The decision to use ClickHouse, and the measurements behind it, are in [storage-benchmark.md](storage-benchmark.md). Events, traces, logs, and metrics ([telemetry](telemetry.md)) all go straight to ClickHouse, each table ordered by project first, then time (metrics by project, then name, then time, [telemetry](telemetry.md#storage)); PostgreSQL holds accounts, projects, and settings. Deleting a project, the orphan sweep, and backups below cover every table.

| Step                                                                        | Status |
| --------------------------------------------------------------------------- | ------ |
| 1. ClickHouse in the stack, its settings for a small server, its migrations | Done   |
| 2. The worker copies events from PostgreSQL to ClickHouse (until step 5)    | Done   |
| 3. Reports read ClickHouse                                                  | Done   |
| 4. Retention and project deletion in ClickHouse; backups                    | Done   |
| 5. Events go straight to ClickHouse; PostgreSQL's events table is dropped   | Done   |

## How events get there

1. The collection endpoints (`POST /api/events` from browsers, `POST /api/server-events` from a site's server) check a batch, then write it to ClickHouse's `events` table in one insert (`apps/api/src/collection/event-store.ts`).
2. The insert is asynchronous and waited for (`async_insert` with `wait_for_async_insert`, `apps/api/src/clickhouse/insert.ts`, which telemetry uses too): ClickHouse gathers many small requests into one part and answers each only once that part is written, and on disk (`fsync_after_insert`, set in `apps/api/src/clickhouse/migrations.ts`). Only then does the endpoint answer 202. Without asynchronous inserts, every small request would make a part of its own.
3. Reports read the same table, so an event shows as soon as it is written: there is no copy to wait for.
4. After the insert, the API records when the project's latest event happened (`projects.last_event_at`), which the dashboard shows (`apps/api/src/collection/last-event.ts`). Each API process does this at most once a minute per project, with `greatest()`, so a late, earlier event never moves it back; a project's first events are recorded at once. The time can trail by up to that minute. A failure is logged and never fails the request.

ClickHouse's `events` table (`apps/api/src/clickhouse/migrations.ts`) has the columns PostgreSQL's had. It is ordered by project, then day, then event ID (`(project_id, toDate(occurred_at), event_id)`), so one project's days are one contiguous read; partitioned by month; and a `ReplacingMergeTree`, which keeps one row per sorting key when it merges parts. Within a day rows are in event ID order, so a report reads whole days of a project, which at Ottertrail's sizes costs little.

Until 18 November 2026, events arrived in PostgreSQL first, which confirmed them and kept retries out with its unique `(project_id, event_id)`; the worker copied them to ClickHouse every few seconds, and PostgreSQL deleted its copy after two days. That wrote every event twice, kept reports a few seconds behind, and needed the copy, its marks, and its pruning. Telemetry went straight to ClickHouse from the start ([telemetry](telemetry.md#stored-straight-in-clickhouse)); events now do the same.

## Each event once

ClickHouse has no unique constraint, and the endpoints look nothing up before they insert. A retried event counts once because it is the same row:

- **The table keeps one row per project, day, and event ID.** Rows with the same key are merged into one when ClickHouse merges parts, and reports read with `FINAL`, which merges at query time, so a retry not merged yet still counts once. The [benchmark](storage-benchmark.md) found `FINAL` costs almost nothing.
- **The day, not the exact time.** A server-side event keeps the time its server sent, the same on every attempt. A browser's time is corrected for a wrong clock from when its request arrives ([clock correction](web-analytics.md#clock-correction)), so a retry, which spends another time on the way, comes out a few milliseconds or seconds apart. With the exact time in the key, such a retry would be a second row. A test sends a batch twice, with a new `sentAt` and 4 seconds more on the way, from a right clock and from clocks 10 minutes slow and fast, and ClickHouse counts each event once.
- **One case still counts twice:** a retry whose time and the first attempt's fall either side of midnight UTC, which needs the retry to arrive within its extra time on the way of midnight. A test shows it.
- **The answer cannot say which events were repeats.** `stored` counts the events accepted and written, a retry's included; the answers no longer have `duplicates`.
- **A batch is all or nothing.** One insert: if ClickHouse refuses it, nothing of the batch is stored. A test sends a batch with one row ClickHouse cannot read.

## When ClickHouse is down

Collection depends on ClickHouse now. While it cannot take an insert, the endpoints store nothing and answer 503 with `Retry-After: 5` (`storage_unavailable`). The tracker keeps the batch and retries, with its queue of at most 200 events ([web analytics](web-analytics.md#retries)); a site's server should retry too. Events the tracker hands to `sendBeacon` as a page is hidden or left cannot be retried, since the page is gone: those sent during an outage are lost. That is an accepted cost: keeping PostgreSQL in front as a buffer cost a second write of every event. Tests send to an unreachable ClickHouse and check for 503 and that nothing was stored.

A refused batch gets back the event budget it spent, as telemetry does, so its retries are not refused for the budget once ClickHouse is back. A test checks it.

A project deleted in one API process can still have its key in another process's cache for up to a minute, and ClickHouse cannot check that the project exists, as PostgreSQL's foreign key did. Events accepted then are deleted with the project if they arrive before the worker's next purge, and by the orphan sweep after it ([Retention](#retention-and-deleting-a-project)).

## Reports

Reports read ClickHouse's `events` with `FINAL` (`apps/api/src/reports/reports.ts`). PostgreSQL still works out where days start in the instance's timezone (`localDays`, `previousDays`) and holds the projects and their allowed hostnames; ClickHouse puts each event on its local day for the charts. Every timezone Node.js knows (423 names) is in ClickHouse 26.8's list too. Visits are still worked out when reports run, with the same rules as before ([web analytics, section 6](web-analytics.md#6-visits)), now with ClickHouse's window functions (`apps/api/src/visits/visits.ts`). The tests that define the rules kept every expected number and pass on ClickHouse. One detail differs: of two events in the same millisecond, either may come first (their IDs break the tie), and ClickHouse orders IDs differently from PostgreSQL, so such a visit's entry page or source can come from the other event.

The analytics page works out visits once per request, into a temporary table of a ClickHouse session of its own, which every report then reads ([dashboard](dashboard.md#visits-worked-out-once)). Filters, searches, and the timezone reach ClickHouse as typed query parameters, never in the SQL text; row limits and offsets are clamped to whole numbers first.

When ClickHouse runs out of memory for a report, the endpoint answers 503 and asks to try a shorter range or again in a minute. Any other failure answers 500 with a general message: ClickHouse's own error text, which can name servers, settings, and versions, stays in the log.

ClickHouse has no snapshot across queries, as PostgreSQL's REPEATABLE READ gave: events stored while a page is worked out can reach some of its reports and not others.

### Memory

Working out visits takes memory in proportion to the visits in the range. On fake data, every visit of 200,000 over 30 days (1.2 million events), with all its columns, took 3.5 seconds and 265 MiB at most. Past half the free memory, ClickHouse continues large groupings on disk instead of failing (`max_bytes_ratio_before_external_group_by`, 0.5 by default); it did here. Even forced to go to disk early, the query still held about 250 MiB: some 1.3 KB per visit stays in memory.

How much memory ClickHouse may use is worked out again as it runs: its own memory plus what the system has free, times `max_server_memory_usage_to_ram_ratio` (0.4 in `deploy/clickhouse/`). On an 8 GB server with little else running, that is about 2.8 GB: by the measurement above, enough for one report to work out roughly 2 million visits, shared by the pages loaded at the same time. Larger sites need stored visits (an open decision, [roadmap](roadmap.md)) or a limit on reports at once (not done).

The development stack runs in Podman's machine, 2 GB by default and shared with other containers. There 0.4 left ClickHouse about 350 MiB, nearly all of it its own idle use, and tests running side by side failed with `MEMORY_LIMIT_EXCEEDED`. The development stack alone raises the ratio to 0.75 (`deploy/clickhouse/development.xml`): about 680 MiB. Even so, ClickHouse's own memory there grows during heavy runs and takes minutes to shrink back, so the benchmark's whole-page part failed there in repeated runs at 50,000 and 200,000 visits. For more data locally, give the machine more memory (`podman machine set --memory 8192`, with the machine stopped).

## Retention and deleting a project

ClickHouse has no foreign keys, so nothing deletes its events with a project or a retention limit on its own. The worker does (`apps/api/src/clickhouse/delete-events.ts`):

- **Retention.** At start and every 6 hours, the worker deletes each project's events past its limit, up to a midnight in the instance's timezone (`retention/retention.ts`, [web analytics, section 1](web-analytics.md#how-long-events-are-kept)).
- **Traces, logs, and metrics.** ClickHouse drops their days past `TELEMETRY_RETENTION_DAYS` on its own (TTL, [telemetry](telemetry.md#limits)); the worker does nothing for them.
- **Uptime check results.** ClickHouse drops their days past 90 on its own (TTL, [uptime and alerts](uptime-alerts.md#step-1-uptime-checks-as-built)). A deleted check's results stay until then, out of reach of every page.
- **A deleted project.** A trigger records every deleted project in `project_deletions`, in the deleting transaction, however the delete came about. Every minute the worker deletes those projects' events, spans, logs, metric points, and check results from ClickHouse, then the records. While ClickHouse is down, the records wait, so a deletion is never lost; a test checks it.
- **Projects ClickHouse should not have.** With retention, the worker also looks for projects ClickHouse holds events, telemetry, or check results of but PostgreSQL no longer knows, and records them for deletion. That can happen after a restore, when ClickHouse's backup holds a project PostgreSQL's dump does not, when an insert that timed out lands after the purge, or when an API process still had a deleted project's key cached ([When ClickHouse is down](#when-clickhouse-is-down)). Those cases leave a project or two. When PostgreSQL knows no projects, or more are missing than 5 and a tenth of ClickHouse's, PostgreSQL is more likely the wrong one (emptied for an upgrade, or a wrong `DATABASE_URL`), so the worker deletes nothing and logs an error instead; a test checks it. If those projects really are gone, record them by hand (`insert into project_deletions (project_id) values ('…')`) and the worker deletes their events within a minute.

Both use ClickHouse's lightweight `DELETE`: the rows leave every report at once. They leave the disk when ClickHouse rewrites the parts that held them without them (`APPLY DELETED MASK`), which the worker starts with retention, table by table, whenever a part holds deleted rows and no other change to that table is still under way (a change that keeps failing is logged as an error); a test reads the table with deleted rows included to check. Without it, deleted rows would stay on disk until ClickHouse merged those parts again, which for an old month may be never. Because the worker looks at the table rather than at what it just deleted, rows a failed run left behind go with the next.

Both cost more than they seem:

- ClickHouse carries out a `DELETE` in the background, part by part. On the development stack, one took 1 to 9 seconds, however few rows it deleted. So the worker deletes for a thousand projects per statement (query values travel in the URL, which ClickHouse limits to 1 MiB), and sends none when nothing is due, as on most runs.
- A part holds every project's events of its month, so taking one project's rows off the disk rewrites whole months (telemetry's partitions are days, so only those days): those the deleted project had events in, and, for retention, the oldest month kept, about once a day. That is why it runs every 6 hours, not after each deletion. On a large instance this rewriting is real disk work; partitions per project, or dropping whole months, would avoid it, and are not done.

## Backups

`deploy/backup.sh` makes a backup of both databases: PostgreSQL's with `pg_dump` (accounts, projects, settings), then ClickHouse's with its own `BACKUP DATABASE` (events, traces, logs, and metrics). PostgreSQL holds no events now, so no event can fall between the two. The order still matters for projects: with PostgreSQL's dump first, every project in it has its events in ClickHouse's backup, taken after.

ClickHouse's backup may hold events from after the dump, which is mostly harmless:

- Those of a project created after the dump belong to no restored project. The orphan sweep deletes them, unless more projects are missing than its guard allows; then it only logs an error ([Retention](#retention-and-deleting-a-project)).
- A project deleted between the two comes back from the dump, without the events ClickHouse had already purged.
- If the two backups straddle a midnight in the instance's timezone, ClickHouse's may hold events whose visitor IDs came from the new day's salt, which the dump does not have. A restore within that day makes a new salt, so a visitor who returns that day counts twice. The window is the time ClickHouse's backup takes.

`deploy/restore.sh` puts both back into an empty instance. How to use them: [deployment](deployment.md#backups).

## 64-bit integers

Visitor IDs are 64-bit integers. ClickHouse 26 sends 64-bit integers in JSON as bare numbers, which JavaScript rounds (`-4611686018427387904` came back as `-4611686018427388000`), so the client asks for them as strings (`output_format_json_quote_64bit_integers`). Counts arrive as strings too.

## Not done yet

- Automated and off-site backups (see [deployment](deployment.md#backups)).
- A snapshot across a page's reports.
- A limit on how many reports run at once, so one project's long ranges cannot use all of ClickHouse's memory.
