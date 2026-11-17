# Session replay

**Status: planned, stage 5 of the [roadmap](roadmap.md). This is the design to build from; nothing in it is built.**

A replay shows what a visitor saw and did on a site: the page, their clicks, scrolling, and typing, played back in the dashboard. Its most useful view is the minute before an error: what the visitor did that broke the page. The first version records only that: replays around errors, attached to the error's group ([errors](errors.md)).

Recordings hold whatever is on the screen, so this design starts from privacy: **nothing a visitor reads or types leaves their browser unless the site's owner has chosen to show it.**

## What a recording is

Not a video. The recorder takes a snapshot of the page's HTML once, then records each change with its time: elements added and removed, text changed, a field's value, a click, a scroll, the window's size. The player builds the page again from the snapshot in a frame and applies the changes in time. A recording is much smaller than a video and its text stays sharp, and masking can work element by element.

The recorder is [rrweb](https://github.com/rrweb-io/rrweb) (MIT; `@rrweb/record` to record, `@rrweb/replay` to play back; 2.2.2 when this was written). Recordings miss what is not in the HTML: what a `<canvas>` draws (rrweb's `recordCanvas` is off by default, and stays off), the frames of a `<video>`, and frames from other domains. Images, fonts, and stylesheets are loaded from the site when the replay plays, so a replay can look off once the site has changed.

## Private by default

### The rules

1. **Off until a project's owner turns it on,** in the project's settings, and the site asks for it in its snippet (below). Recordings for a project that has it off are refused.
2. **Masked in the browser.** Masking happens on the visitor's device, before a recording is kept in memory or sent. The API never receives what was masked, so nothing on the server, nor anyone with access to it, can unmask it.
3. **Private unless loosened.** With no settings, text is masked, typed values are masked, and images and media are blocked (the table below). A site loosens this on purpose, in its own HTML.
4. **Fails closed.** When the recorder cannot tell whether something should be masked, it masks it. A recording that cannot be masked as configured is not sent at all.

### What the defaults hide

| What                                                                                              | By default                                                                    | Shown when                                                                       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Text on the page                                                                                  | Masked: each character becomes `*`, spaces kept, so the layout stays readable | The snippet has `data-replay-text="show"`, or the element is marked unmasked     |
| Text in attributes people read: `title`, `placeholder`, `alt`, `aria-label`, `aria-description`   | Masked, as text                                                               | As text                                                                          |
| Typed values: inputs, text areas, selects                                                         | Masked (rrweb's `maskAllInputs`)                                              | Never in the first version                                                       |
| Images, `<picture>`, `<video>`, `<audio>`, `<svg>`, `<canvas>`, `<iframe>`, `<object>`, `<embed>` | Blocked: a box of the same size (rrweb's `blockSelector`)                     | The snippet has `data-replay-media="show"` (except `<canvas>` and frames, never) |
| Addresses in `href`, `src`, `action`, and the page's own URL                                      | Origin and path only, as the tracker sends page URLs                          | Never: query strings and fragments carry tokens                                  |

Masked text keeps its length, so a replay still shows which button was clicked and where a form was half-filled, without what it said.

### Markers in the site's HTML

A site can mark elements in its own HTML:

- `data-ottertrail-mask`: this element's text is masked, even when the snippet shows text. For an account page's name and email in a site that otherwise shows text.
- `data-ottertrail-block`: this element is not recorded at all, only a box of its size. For a payment form, a chat window, a document preview.
- `data-ottertrail-unmask`: this element's text is shown, even in a private recording. For a site that keeps text masked but wants its menu and headings readable. Never applies to typed values or to anything inside a `data-ottertrail-mask` or `-block`.

A marker applies to the element and everything inside it, and the stricter one wins: block, then mask, then unmask.

### Never recorded

Whatever the settings or markers:

- Typed values, password fields included (rrweb masks passwords even with no options).
- Scripts: rrweb records no script contents, and the player runs none.
- Network requests and responses, console output, cookies, and storage. A later version may add requests' addresses and status codes, cleaned as page URLs are, never their bodies.
- Query strings and fragments, in the page URL or in any link or image address.

### Proving it: the privacy test

rrweb's options alone do not cover these rules: it has no option for attribute text, and its documentation does not say whether one selector can mask all text. So `r.js` passes every recorded change through its own filter before keeping it: it masks text nodes (but not a stylesheet's text, which the page needs to look right), the attributes above, and addresses, and it follows the markers. rrweb's own options (`maskAllInputs`, `blockSelector`) mask first; the filter is the second line.

A browser test proves the result rather than trusting either: it records a fixture page full of planted values (names, emails, a card number, a token in a link's query string, text in `title` and `placeholder`, typed passwords and other input) with the default settings, then decompresses what the recorder sent and checks that none of the planted values appears in it. Each loosening (`data-replay-text`, the markers) has its own case, including that `data-ottertrail-unmask` never shows a typed value. The test runs in `vp run ready`; a new rrweb version is only taken when it passes.

## Recording

### Turning it on

Two switches, both needed:

- **The project's setting,** in the dashboard: Replay off (the default) or "around errors". While it is off, the API refuses recordings (403 `replay_off`), and a recorder that is refused stops for the rest of the page load.
- **The snippet,** on the site's pages: `data-replay="errors"` loads the recorder. The privacy settings are in the snippet too (`data-replay-text`, `data-replay-media`), as the site's own choice, because public keys never read a project's configuration (only collection is allowed with them). The dashboard shows the snippet to copy, with the chosen settings.

The site decides about consent: it leaves `data-replay` off until a visitor agrees, or calls `window.ottertrail.replay(false)` to stop and drop the buffer.

### The recorder script

`r.js`, served beside the tracker as `v.js` is ([Web Vitals](web-analytics.md#web-vitals)), loaded by the tracker only when the snippet asks for it, so pages that do not record never download it. rrweb is most of its size, to be measured when built. It inherits `v.js`'s limits: no recorder for a tracker pinned with `integrity`, the tracker's `nonce` under a strict Content Security Policy.

### Only around errors

The recorder records all the time into memory and sends nothing until an error. rrweb's documented way: a full snapshot every 30 seconds (`checkoutEveryNms`), and the buffer keeps the current and the previous stretch, so it always starts with a snapshot and covers 30 to 60 seconds before now. Older stretches are dropped.

When the tracker reports an error ([errors](errors.md#1-capture)), the recorder keeps recording for 10 more seconds, to show what the error did to the page, then sends the buffer. The error event carries the replay's ID (`replayId`, a UUID made by the recorder), and so do later errors of the same page load while it is still recording. One replay per page load: errors after it was sent get none.

### Sending

- The recording is cut into chunks, each compressed with gzip in the browser (`CompressionStream`, in every current browser since May 2023) to at most 60,000 bytes, so a chunk fits a beacon when the visitor leaves mid-upload (browsers allow beacons and `keepalive` requests about 64 KB).
- Each chunk names its replay, its number (0, 1, 2 …), the time it was sent, and whether it is the last. Chunks retry as event batches do ([retries](web-analytics.md#retries)), with the same numbers, so the API keeps each once.
- At most 2 MB compressed per replay; a page so large or so busy that its recording would be bigger sends the first 2 MB, marked cut.

## The API

`POST /api/replays`, with the project's public key, as `/api/events` takes it: the same allowed hostnames, CORS, and per-IP limit, and the cheapest checks first ([collecting](web-analytics.md#2-collecting)). A body is one gzip chunk, at most 64 KB; the API decompresses it with a cap of 1 MB (more is refused, 413, so a small body cannot unpack into a large one), checks the envelope (IDs, numbers, times) and that the events are JSON, and keeps the compressed bytes as sent. It does not read further into what was recorded; the player treats it as untrusted (below).

Recordings spend their own budgets, in bytes, per project and per organization (as events do with `EventBudget`), so recordings cannot crowd out events: a site whose replays hit the limit still has its events counted. Each organization also has a limit on the bytes it stores, counted in PostgreSQL from each replay's size, so one customer cannot fill a store every customer shares. A deployment sets the defaults; an organization's own limit can be raised.

## Storage

Decided on 17 November 2026: recordings are files in an object store, reached through the S3 API, and PostgreSQL holds what is known about them.

- **The object store:** any server that speaks the S3 API, set by its endpoint, bucket, and keys. A hosted deployment uses Cloudflare R2 (or Amazon S3); development and self-hosted installs run [Garage](https://garagehq.deuxfleurs.fr/) (AGPL-3.0) in Docker Compose. Not MinIO: its community edition is no longer maintained upstream, nor published as Docker images. Ottertrail uses only the basic calls (put, get, list, and delete objects), so any of them works the same.
- **Landing in PostgreSQL first:** chunks land in PostgreSQL (`replay_chunks`: project, replay ID, number, the compressed bytes, received time), which confirms them once committed, the one rule for everything a browser sends; its unique `(project_id, replay_id, seq)` makes a retry harmless.
- **One object per replay:** when a replay is complete (its last chunk came, or none for 5 minutes), the worker joins its chunks into one object and records it in PostgreSQL (`replays`: project, replay ID, the errors it shows, size, start and end, the object's key). A replay costs one write and one read in the store, which charges per request, rather than one per 60 KB chunk. The worker deletes the chunks an hour later, past the tracker's retries (eight attempts, at most a minute apart).
- **One bucket per deployment,** keys by project: `replays/<project_id>/<replay_id>.gz`. A bucket per customer would add nothing, and stores limit how many there can be. Which organization may read what is decided where it always is: the API's access check. The browser never gets the store's keys; playback reads a replay through the API, after that check.
- **The same store for source maps** ([errors](errors.md)), under `source-maps/<project_id>/`.

Recordings are much larger than events, so what to measure on a real site first is bytes per replay, and PostgreSQL's churn while chunks wait there.

## Playback

On an error group's page, an occurrence with a replay offers to play it; the player starts 60 seconds before the error at most, with the error marked on its timeline, and shows clicks and the visitor's path through pages beside it.

A recording is whatever a browser sent with a public key, which anyone can copy from a site, so the player treats it as untrusted HTML:

- `@rrweb/replay` builds the page in an `iframe` sandboxed without `allow-scripts` (rrweb's sandbox: scripts become `noscript`, forms and popups are blocked). Never `UNSAFE_replayCanvas`, which allows scripts.
- The player runs in a page of its own, served with a Content Security Policy that lets images, stylesheets, and fonts load only from the project's allowed hostnames ([keys and allowed hostnames](web-analytics.md#keys-and-allowed-hostnames)), so a forged recording cannot make the viewer's browser call other servers, and scripts only from Ottertrail.
- Nothing from a recording is put into the dashboard's own page.

## Retention and deletion

- Replays are kept 30 days, the shortest retention a project can choose for events, so a replay outlives its error by a day at most. The worker deletes expired replays, object and row, itself rather than through the store's lifecycle rules, which differ from one store to another.
- Deleting a project deletes its replays, everything under its key prefix, through the same `project_deletions` path as events ([ClickHouse](clickhouse.md#retention-and-deleting-a-project)).
- Turning replay off keeps the recordings already made until they expire; the setting offers to delete them now.
- Deleting one user's data (when that exists) includes their replays: chunks carry the user ID, if any, and the visitor ID of the page load.

## Not in the first version

- Whole sessions, or a sample of them, without an error.
- Showing typed values, even for one field.
- Network requests and console output beside the replay.
- `<canvas>`, video frames, and frames from other domains.
- Search across replays (by page, click, or user), and replays on a user's activity timeline.
- Mobile apps.
- Click heatmaps ([roadmap](roadmap.md#notes)).

## Decisions still open

1. **Budgets:** bytes per second, per day, and stored, for a project and an organization, from measuring a real site's recordings.
2. **Garage in development:** its memory beside PostgreSQL and ClickHouse in the 2 GB development VM, to try before it joins the Compose files.
3. **Whole sessions:** whether to record any without an error. They would need consent wording and much more storage.
