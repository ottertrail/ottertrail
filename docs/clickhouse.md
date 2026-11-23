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
2. The insert is asynchronous and waited for (`async_insert` with `wait_for_async_insert`, `apps/api/src/clickhouse/insert.ts`, which telemetry uses too): ClickHouse gathers many small requests into one part and answers each only once that part is written, and on disk (`fsync_after_insert` and `fsync_part_directory`, set in `apps/api/src/clickhouse/migrations.ts` on events, heatmaps, AI calls, and, since migration `0010_telemetry_fsync`, spans, logs, and metrics). Only then does the endpoint answer 202. Without asynchronous inserts, every small request would make a part of its own.
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

ClickHouse also refuses inserts while less than 5% of its disk is free (`min_free_disk_ratio_to_perform_insert`, [deployment](deployment.md#clickhouse-keeps-5-of-the-disk-free)): collection then answers the same 503, and the tracker retries until there is room. A test makes the events table ask for more free space than the disk has and checks that collection answers 503, stores nothing, and stores the retry once the table has room again.

A refused batch gets back the event budget it spent, as telemetry does, so its retries are not refused for the budget once ClickHouse is back. A test checks it.

A project deleted in one API process can still have its key in another process's cache for up to a minute, and ClickHouse cannot check that the project exists, as PostgreSQL's foreign key did. Events accepted then are deleted with the project if they arrive before the worker's next purge, and by the orphan sweep after it ([Retention](#retention-and-deleting-a-project)).

## Reports

Reports read ClickHouse's `events` with `FINAL` (`apps/api/src/reports/reports.ts`). PostgreSQL still works out where days start in the instance's timezone (`localDays`, `previousDays`) and holds the projects and their allowed hostnames; ClickHouse puts each event on its local day for the charts. Every timezone Node.js knows (423 names) is in ClickHouse 26.8's list too. Visits are still worked out when reports run, with the same rules as before ([web analytics, section 6](web-analytics.md#6-visits)), now with ClickHouse's window functions (`apps/api/src/visits/visits.ts`). The tests that define the rules kept every expected number and pass on ClickHouse. One detail differs: of two events in the same millisecond, either may come first (their IDs break the tie), and ClickHouse orders IDs differently from PostgreSQL, so such a visit's entry page or source can come from the other event.

The analytics page works out visits once per request, into a temporary table of a ClickHouse session of its own, which every report then reads ([dashboard](dashboard.md#visits-worked-out-once)). Filters, searches, and the timezone reach ClickHouse as typed query parameters, never in the SQL text; row limits and offsets are clamped to whole numbers first.

When ClickHouse runs out of memory for a report, the endpoint answers 503 and asks to try a shorter range or again in a minute. Any other failure answers 500 with a general message: ClickHouse's own error text, which can name servers, settings, and versions, stays in the log.

ClickHouse has no snapshot across queries, as PostgreSQL's REPEATABLE READ gave: events stored while a page is worked out can reach some of its reports and not others.

### Memory

Working out visits takes memory in proportion to the visits in the range. On fake data, every visit of 200,000 over 30 days (1.2 million events), with all its columns, took 3.5 seconds and 265 MiB at most. Past half the free memory, ClickHouse continues large groupings on disk instead of failing (`max_bytes_ratio_before_external_group_by`, 0.5 by default); it did here. Even forced to go to disk early, the query still held about 250 MiB: some 1.3 KB per visit stays in memory.

How much memory ClickHouse may use is worked out again as it runs: its own memory plus what the system has free, times `max_server_memory_usage_to_ram_ratio` (0.4 in `deploy/compose.yaml`). On an 8 GB server with little else running, that is about 2.8 GB: by the measurement above, enough for one report to work out roughly 2 million visits, shared by the pages loaded at the same time. Larger sites need stored visits (an open decision, [roadmap](roadmap.md)) or a limit on reports at once (not done).

The development stack runs in Podman's machine, 2 GB by default and shared with other containers. There 0.4 left ClickHouse about 350 MiB, nearly all of it its own idle use, and tests running side by side failed with `MEMORY_LIMIT_EXCEEDED`. The development stack alone raises the ratio to 0.75 (`deploy/clickhouse/development.xml`): about 680 MiB. Even so, ClickHouse's own memory there grows during heavy runs and takes minutes to shrink back, so the benchmark's whole-page part failed there in repeated runs at 50,000 and 200,000 visits. For more data locally, give the machine more memory (`podman machine set --memory 8192`, with the machine stopped).

## First-seen times

`user_first_seen` holds when each signed-in user was first seen, per project and environment: one row per user (`project_id`, `environment`, `user_id`), with the earliest time as a `min` aggregate state (`AggregatingMergeTree`). A materialized view fills it as events are stored: each insert adds the earliest time of its batch for each user, and ClickHouse merges the rows in the background, so reads take `minMerge`. Events that are not something the user did, time-on-page reports and Web Vitals, do not count, as on the Users and Retention pages. A retried event adds its time again, which a min ignores, so the table needs no `FINAL`. ClickHouse migration 0004 created it and copied in the events already stored.

The overview reads it for new signed-in users and weekly cohorts ([dashboard](dashboard.md#overview)), instead of every signed-in event the project keeps.

It follows the events:

- **Retention.** When the worker deletes a project's old events, it deletes the project's rows here and works them out again from the events kept. A user whose early events are gone is first seen at their earliest event kept; a user with none left is gone. Events stored meanwhile are added back after the delete (below), so a user first seen during the rebuild keeps their row.
- **Deleted spam visits.** The same, when a deleted visit had a signed-in user ([below](#deleting-spam-visits)).

A rebuild works the new rows out first, into a temporary table of a ClickHouse session of its own: the read of every signed-in event, the step that can time out or run out of memory, happens before anything is removed. Then it deletes the project's rows and copies the new ones in, a copy of a few rows. Events keep arriving meanwhile, and the view writes each one's row as it is stored; the delete takes the project's rows whatever wrote them, so a user first seen in an event the snapshot did not read would lose their row. So after the copy, the rebuild reads the project's events received from 10 minutes before it started (`ARRIVAL_MARGIN_MS`; `received_at`, the API's clock) and adds their users again: an event the snapshot missed was received after then, since an insert gives up after the ClickHouse client's 2 minutes, and the rest allows for the API's and the worker's clocks to differ. A user counted by the snapshot, the view, and this read alike has the same time each time, which a min ignores. A minmax index on `received_at` (migration `0013_events_received_at_index`) lets that read skip the granules that arrived earlier. A test stores a new user's event between the snapshot and the delete and checks the user keeps their first-seen time. The table cannot be swapped in one step, since it has no partition per project, so if that last copy failed, the project would have no first-seen times. A rebuild therefore marks each project in PostgreSQL first (`first_seen_rebuilds`, migration 0010), and removes the mark only once the copy is in. ClickHouse refuses inserts under 5% free disk ([deployment](deployment.md#clickhouse-keeps-5-of-the-disk-free)), which would refuse that copy after the delete, so a rebuild runs only with 7% of the disk free (`REBUILD_FREE_RATIO`); without that room it removes nothing, and the project keeps its old first-seen times, marked. The worker's storage check, every 5 minutes, rebuilds the marked projects once there is room (`retryFirstSeenRebuilds`), as it does for a rebuild that failed part way; the view adds every user seen meanwhile. A test runs retention with 6% free, checks that the first-seen times stay and the project is marked, then retries with room.

- **A deleted project.** Its rows are deleted with its events.

## Retention and deleting a project

Every table's retention, beside PostgreSQL's and the object store's, is in [where data is stored](data.md).

ClickHouse has no foreign keys, so nothing deletes its events with a project or a retention limit on its own. The worker does (`apps/api/src/clickhouse/delete-events.ts`):

- **Retention.** At start and every 6 hours, the worker deletes each project's events past its limit, up to a midnight in the instance's timezone (`retention/retention.ts`, [web analytics, section 1](web-analytics.md#how-long-events-are-kept)).
- **Traces, logs, and metrics.** ClickHouse drops their days past `TELEMETRY_RETENTION_DAYS` on its own (TTL, [telemetry](telemetry.md#limits)); the worker does nothing for them.
- **Uptime check results.** ClickHouse drops their days past 90 on its own (TTL, [uptime and alerts](uptime-alerts.md#step-1-uptime-checks-as-built)). A deleted check's results stay until then, out of reach of every page.
- **Heatmaps.** ClickHouse drops their days past 90 on its own (TTL, [below](#heatmaps)), whatever the project's event retention.
- **AI calls.** Kept as long as the project's events: retention deletes a project's AI calls older than its cut-off in the same run, by the call's start ([AI usage](ai-usage.md#storage)). The table is keyed by day, as events are, so a retried call with a corrected time is one row; when its two times fall either side of the cut-off, the copy before it goes and the later one stays.
- **A deleted project.** A trigger records every deleted project in `project_deletions`, in the deleting transaction, however the delete came about. Every minute the worker deletes those projects' events, spans, logs, metric points, check results, first-seen times, heatmaps, and AI calls from ClickHouse, then the records. While ClickHouse is down, the records wait, so a deletion is never lost; a test checks it.
- **Projects ClickHouse should not have.** With retention, the worker also looks for projects ClickHouse holds events, telemetry, check results, heatmaps, or AI calls of but PostgreSQL no longer knows, and records them for deletion. That can happen after a restore, when ClickHouse's backup holds a project PostgreSQL's dump does not, when an insert that timed out lands after the purge, or when an API process still had a deleted project's key cached ([When ClickHouse is down](#when-clickhouse-is-down)). Those cases leave a project or two. When PostgreSQL knows no projects, or more are missing than 5 and a tenth of ClickHouse's, PostgreSQL is more likely the wrong one (emptied for an upgrade, or a wrong `DATABASE_URL`), so the worker deletes nothing and logs an error instead; a test checks it. If those projects really are gone, record them by hand (`insert into project_deletions (project_id) values ('…')`) and the worker deletes their events within a minute.

Both use ClickHouse's lightweight `DELETE`: the rows leave every report at once. They leave the disk when ClickHouse rewrites the parts that held them without them (`APPLY DELETED MASK`), which the worker starts with retention, table by table, whenever a part holds deleted rows and no other change to that table is still under way (a change that keeps failing is logged as an error); a test reads the table with deleted rows included to check. Without it, deleted rows would stay on disk until ClickHouse merged those parts again, which for an old month may be never. Because the worker looks at the table rather than at what it just deleted, rows a failed run left behind go with the next.

Both cost more than they seem:

- ClickHouse carries out a `DELETE` in the background, part by part. On the development stack, one took 1 to 9 seconds, however few rows it deleted. So the worker deletes for a thousand projects per statement (query values travel in the URL, which ClickHouse limits to 1 MiB), and sends none when nothing is due, as on most runs.
- A part holds every project's events of its month, so taking one project's rows off the disk rewrites whole months (telemetry's partitions are days, so only those days): those the deleted project had events in, and, for retention, the oldest month kept, about once a day. That is why it runs every 6 hours, not after each deletion. On a large instance this rewriting is real disk work; partitions per project, or dropping whole months, would avoid it, and are not done.

## Deleting spam visits

A project's owner or admin can delete whole visits that match filters (the routes and filters: [web analytics](web-analytics.md#deleting-spam-that-got-in); code: `apps/api/src/spam/delete-visits.ts`). Visits are not stored, so a delete works them out first, then deletes their events:

1. **Find the visits.** One read of the project's events with `FINAL`, filtered by `project_id` first, over the period and 25 hours either side, works out visits as reports do (window functions over each visitor's events, a new visit after 30 minutes without one, per environment) and keeps those with an event in the period that matches every filter. The preview runs the same query and only counts. Both read with the dashboard's limits (15 seconds, 300 MB): a period too large answers 503 and asks for a shorter one.
2. **Delete them.** A lightweight `DELETE`, as retention uses, names each visit by environment, visitor ID, and its first and last event, 2,000 visits per statement (query values travel in the URL, which ClickHouse limits to 1 MiB): `WHERE project_id = … AND occurred_at` between the chunk's earliest and latest time `AND` the visitor is one of the chunk's `AND` the event lies within its visit's times. Each statement waits until ClickHouse has applied it, which takes seconds, so one delete takes at most 10,000 visits (5 statements); past that it refuses before deleting anything, and the dashboard asks to delete in parts.
3. **A failure partway.** Each statement is applied whole or not at all, but a failure between statements leaves the earlier ones done. Whatever happens, the visits of the statements that ran then take their replays and first-seen times with them (in a `finally`), and the route answers 500 `delete_failed` ("some visits may have been deleted"): the user counts again and deletes the rest.
4. **Retries.** A retried event not merged yet is a second row, a few seconds from the one `FINAL` showed. Each visit's times are widened by 10 minutes either side, less than the 30 minutes that part two visits of a visitor, so such a copy goes too and `FINAL` cannot bring it back. The window is tested on fixed rows, not a table ClickHouse merges (`visitsWhere` against a `values()` table): the visit's event and a copy 3 seconds out are taken, the same visitor 31 minutes later, another environment, visitor, or project are not. A second test stores retries of a visit's first and last events and a neighbour 31 minutes on, and records how many copies were still unmerged before the delete, which depends on ClickHouse's merge timing.
5. **After it.** Reads with `FINAL` stop seeing the rows at once. They leave the disk when the worker next rewrites the parts that hold them (`APPLY DELETED MASK`, with retention, every 6 hours, [above](#retention-and-deleting-a-project)).

What a delete reaches, and what it does not:

| Derived from events                                                                            | Reached?                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports, visits, the overview, funnels, retention, Speed, Users, Errors                        | Yes: all are worked out from `events` when asked                                                                                                                                                                                                |
| `user_first_seen` (ClickHouse, filled by `user_first_seen_mv`)                                 | Yes: when a deleted visit had a signed-in user, the project's rows are worked out again from the events kept, as after retention ([First-seen times](#first-seen-times))                                                                        |
| Session replays of the visits' errors (object store, `replays`, `replay_chunks`)               | Yes: the replays named by the deleted errors (`replay_id`) are deleted, objects and rows, holding the project's row as deleting all replays does. If the object store fails, the events stay deleted and the replays expire after their 30 days |
| `projects.last_event_at` (PostgreSQL)                                                          | No: it may name the time of a deleted event until the next event arrives                                                                                                                                                                        |
| `alert_error_groups` (PostgreSQL: when each error group first arrived, for "new error" alerts) | No: an error group first seen in a deleted visit keeps its first arrival, so the same error later counts as known, not new. Alerts already sent, and `alert_history`, stay as they were                                                         |
| Error resolutions (`error_resolutions`)                                                        | Not derived: a resolution stays, and applies if the error comes back                                                                                                                                                                            |
| Backups                                                                                        | No: deleted events stay in backups taken before                                                                                                                                                                                                 |

Every other ClickHouse table (`spans`, `logs`, `metric_points`, `metric_histograms`, `check_results`) holds telemetry, not events, and no other materialized view reads `events`. `heatmaps` holds no visitor ID, so a deleted visit's clicks and scroll depth stay until their 90 days are over.

## Heatmaps

`heatmaps` (ClickHouse migration 0006, `dead` added by 0007) holds the clicks and scroll depths of sampled pageviews ([web analytics](web-analytics.md#heatmaps)), straight from `POST /api/heatmaps`, acknowledged once written, as events are:

| Column                                             | Meaning                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`, `record_id`                          | The project; the record's ID, made in the browser                                                                                                   |
| `kind`                                             | `click`, or `scroll` (one per pageview)                                                                                                             |
| `occurred_at`, `received_at`                       | A click's time, or its pageview's start, corrected for the browser's clock, to the minute; arrival                                                  |
| `environment`, `release`                           | As the tag names them                                                                                                                               |
| `path`                                             | The page's path, cleaned as pageviews'                                                                                                              |
| `device`                                           | `mobile`, `tablet`, or `desktop`, from the viewport's width (768 and 1024 pixels)                                                                   |
| `label`, `element`                                 | The site's `data-ottertrail-name`, and the structural path of the clicked element; `''` for scroll rows                                             |
| `x`, `y`                                           | Where in its element a click fell, in thousandths                                                                                                   |
| `viewport_width`, `viewport_height`, `page_height` | In CSS pixels                                                                                                                                       |
| `rage`                                             | A rage click                                                                                                                                        |
| `dead`                                             | A dead click: nothing on the page responded within a second (migration 0007; 0 for rows before it and for scroll rows)                              |
| `depth`, `fold`, `dropped`                         | A scroll row's deepest share of the page and its fold as it first showed, in thousandths, and the pageview's clicks past the 100 sent; 0 for clicks |
| `version`                                          | A scroll row's `depth` × 65,536 + `dropped`; 0 for clicks                                                                                           |

- **Ordered by project, then day, then page, then device** (`(project_id, toDate(occurred_at), path, device, kind, record_id)`): a report reads one page of one project, one short range per day.
- **Each record once:** a `ReplacingMergeTree(version)`, read with `FINAL`. A retry is the same row, keyed by project, day, and record ID as events are (the page, device, and kind are the retry's too): the day, not the exact time, which clock correction moves on each attempt. A pageview's scroll row comes again with the same ID when the visitor scrolled further or clicked past the 100: its version grows with both, so the latest is kept, whatever order the copies arrive in. One page's report reads with `FINAL`: one page's rows are few (at an estimated 2 to 4 rows per pageview, a page with 10,000 sampled pageviews in the period has 20,000 to 40,000), so merging them at query time costs little. The page list reads without `FINAL`, which would merge every page of the project over up to 90 days, and counts distinct record IDs instead (`uniqExactIf`), so a scroll row sent again or a retried copy counts once. Like the telemetry tables (migration 0002), the table merges a day's parts into one once they are all an hour old (`min_age_to_force_merge_seconds`), so copies do not stay.
- **Kept 90 days**, partitioned by day: ClickHouse drops a day once past it (TTL with `ttl_only_drop_parts`), as uptime results. Deleting a project, the orphan sweep, and the deleted-row cleanup cover the table; backups include it.
- On disk as events are: `fsync_after_insert`.

## Backups

`deploy/backup.sh` makes a backup of both databases: PostgreSQL's with `pg_dump` (accounts, projects, settings), then ClickHouse's with its own `BACKUP DATABASE` (events, traces, logs, metrics, and every other table, AI calls among them). PostgreSQL holds no events now, so no event can fall between the two. The order still matters for projects: with PostgreSQL's dump first, every project in it has its events in ClickHouse's backup, taken after.

ClickHouse's backup may hold events from after the dump, which is mostly harmless:

- Those of a project created after the dump belong to no restored project. The orphan sweep deletes them, unless more projects are missing than its guard allows; then it only logs an error ([Retention](#retention-and-deleting-a-project)).
- A project deleted between the two comes back from the dump, without the events ClickHouse had already purged.
- If the two backups straddle a midnight in the instance's timezone, ClickHouse's may hold events whose visitor IDs came from the new day's salt, which the dump does not have. A restore within that day makes a new salt, so a visitor who returns that day counts twice. The window is the time ClickHouse's backup takes.

After both, it backs up the object store's source maps and session replays. `deploy/restore.sh` puts them all back into an empty instance. How to use them: [deployment](deployment.md#backups).

The worker's scheduled backups take the same three parts in the same order ([deployment](deployment.md#scheduled-backups)). ClickHouse's runs `ASYNC`, and the worker polls `system.backups` for its end, so a long backup holds no HTTP request open. It writes into the `clickhouse-backups` volume that `deploy/compose.yaml` mounts at ClickHouse's backups path and shares with the worker, which reads the file, encrypts and uploads it, and deletes it. A run that fails or is stopped first cancels the backup with `KILL QUERY` on the query `system.backups` names, and waits for its end, so ClickHouse does not finish writing a file the run deleted. The `ottertrail` user may run `BACKUP` and read `system.backups` (checked on 26.8.38.9).

## 64-bit integers

Visitor IDs are 64-bit integers. ClickHouse 26 sends 64-bit integers in JSON as bare numbers, which JavaScript rounds (`-4611686018427387904` came back as `-4611686018427388000`), so the client asks for them as strings (`output_format_json_quote_64bit_integers`). Counts arrive as strings too.

## Not done yet

- Automated and off-site backups (see [deployment](deployment.md#backups)).
- A snapshot across a page's reports.
- A limit on how many reports run at once, so one project's long ranges cannot use all of ClickHouse's memory.
