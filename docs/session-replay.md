# Session replay

**Status: the first version is built, replays around errors, as described here; what it leaves out is under [Not in the first version](#not-in-the-first-version). Stage 5 of the [roadmap](roadmap.md).**

A replay shows what a visitor saw and did on a site: the page, their clicks, scrolling, and typing, played back in the dashboard. Its most useful view is the minute before an error: what the visitor did that broke the page. The first version records only that: replays around errors, attached to the error's group ([errors](errors.md)).

Recordings hold whatever is on the screen, so this design starts from privacy: **nothing a visitor reads or types leaves their browser unless the site's owner has chosen to show it.**

## What a recording is

Not a video. The recorder takes a snapshot of the page's HTML once, then records each change with its time: elements added and removed, text changed, a field's value, a click, a scroll, the window's size. The player builds the page again from the snapshot in a frame and applies the changes in time. A recording is much smaller than a video and its text stays sharp, and masking can work element by element.

The recorder is [rrweb](https://github.com/rrweb-io/rrweb) (MIT; `@rrweb/record` to record, `@rrweb/replay` to play back; 2.2.2). Recordings miss what is not in the HTML: what a `<canvas>` draws (rrweb's `recordCanvas` is off by default, and stays off), the frames of a `<video>`, and frames from other domains. Images, fonts, and stylesheets are loaded from the site when the replay plays, so a replay can look off once the site has changed.

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

rrweb's options alone do not cover these rules: it has no option for attribute text, and its documentation does not say whether one selector can mask all text. So `r.js` passes every recorded change through its own filter before keeping it (`packages/tracker/src/replay-filter.ts`). rrweb's own options (`maskAllInputs` with every input type, `blockSelector`, no canvas, fonts, or frames from other sites) mask first; the filter is the second line, and does not rely on the first:

- **Only known events pass,** each rebuilt from a list of the fields it may carry: the page's address and size, full snapshots, and changes of these kinds: the page's elements, mouse and touch, scrolling, the window's size, typed values (always masked), media playing, stylesheet rules, selection. Canvas drawing, fonts, console output, plugins, and anything unknown are dropped. If the filter fails, recording stops and what it held is dropped.
- **Every node's markers are known:** a map from each node to its parent, rebuilt with each full snapshot and kept with each change, holds its own markers; a node's rules are its own and its ancestors'. A node whose parent is unknown is dropped, as is any change to one the map does not know.
- **Stricter than the table, on purpose:** the text of `<option>` elements and of editable regions is treated as typed, so it stays masked even when the snippet shows text; `data-*` and other attributes it does not know are masked as text unless text is shown, which can leave a private replay's styling a little off where a stylesheet selects on them; `<meta>` content is masked.
- **Stylesheets** are kept, as the page needs them, with addresses in `url()`, `@import`, and `image-set()` cleaned to origin and path.
- **A block marker added after the page loaded** cannot take back what was already recorded inside the element: new content there is dropped at once, and what was there before leaves the replay with the next full snapshot, at most 30 seconds later.

A browser test proves the result rather than trusting either (`packages/tracker/tests/browser/replay.test.ts`): it records a fixture page full of planted values (a name, an email, a card number, tokens in a link's, an image's, a `srcset`'s, and a style's addresses, text in `title`, `placeholder`, `alt`, `aria-label`, `data-*`, and `<meta>`, a typed password, text input, text area, chosen option, an edited region, text inserted and an attribute changed after load, and text in masked and blocked regions), with the default settings, then decompresses what the recorder sent and checks that none of the planted values appears in it. It runs the same with rrweb's own masking turned off, where raw rrweb does send a dozen of them, so the filter alone is proven. Each loosening (`data-replay-text`, `data-replay-media`, `data-ottertrail-unmask`) has its own case, including that unmasking never shows a typed value. The test runs in `vp run ready`; a new rrweb version is only taken when it passes.

## Recording

### Turning it on

Two switches, both needed:

- **The project's setting,** in the dashboard: Replay off (the default) or "around errors". While it is off, the API refuses recordings (403 `replay_off`), and a recorder that is refused stops for the rest of the page load.
- **The snippet,** on the site's pages: `data-replay="errors"` loads the recorder. The privacy settings are in the snippet too (`data-replay-text`, `data-replay-media`), as the site's own choice, because public keys never read a project's configuration (only collection is allowed with them). The dashboard shows the snippet to copy, with the chosen settings.

The site decides about consent: it leaves `data-replay` off until a visitor agrees, or calls `window.ottertrail.replay(false)` to stop and drop the buffer.

### The recorder script

`r.js`, served beside the tracker as `v.js` is ([Web Vitals](web-analytics.md#web-vitals)), loaded by the tracker only when the snippet asks for it, so pages that do not record never download it: 93 KB, 29 KB gzipped, nearly all of it rrweb. The loader made `tracker.js` 135 bytes larger, gzipped. It inherits `v.js`'s limits: no recorder for a tracker pinned with `integrity`, the tracker's `nonce` under a strict Content Security Policy.

### Only around errors

The recorder records all the time into memory and sends nothing until an error. rrweb's documented way: a full snapshot every 30 seconds (`checkoutEveryNms`), and the buffer keeps the current and the previous stretch, so it always starts with a snapshot and covers 30 to 60 seconds before now. Older stretches are dropped.

When the tracker reports an error ([errors](errors.md#1-capture)), the recorder keeps recording for 10 more seconds, to show what the error did to the page, then sends the buffer. The error event carries the replay's ID (`replayId`, a UUID made by the recorder), and so do later errors of the same page load while it is still recording. One replay per page load: errors after it was sent get none.

### Sending

- The recording is `{"v":1,"events":[…]}`, cut into pieces of its text, each compressed with gzip in the browser (`CompressionStream`, in every current browser since May 2023) to at most 60,000 bytes, so a chunk fits a beacon when the visitor leaves mid-upload, and unpacking to at most 1,000,000 bytes, under the API's 1 MiB: a masked page's runs of one character compress to almost nothing, so this limit, not the compressed one, cuts those. The part recorded before the error is compressed at once, so it is ready if the page closes.
- `POST /api/replays?key=pk_…&replay=<uuid>&seq=<n>&last=0|1&cut=0|1`, the chunk as `text/plain`, which a page sends without a preflight and as a beacon. Each chunk is one gzip member, and the members joined in order unpack to the recording. Chunks retry as event batches do ([retries](web-analytics.md#retries)), with the same numbers, so the API keeps each once. A 403 stops the replay, and `replay_off` stops recording for the rest of the page load.
- At most 2 MB compressed and 100 chunks per replay (the API numbers chunks 0 to 99; the tracker fills each chunk at least about half, so 2 MB comes first); a page so large or so busy that its recording would need more sends what fits, cut at an event, marked cut, its last chunk closing the JSON.
- Leaving the page: browsers let about 64 KB of beacons and `keepalive` requests be on their way at once, shared with the tracker's events, so a visitor who leaves just after an error often sends only the first chunk. The API keeps what came (below).

## The API

`POST /api/replays` (`apps/api/src/replays/routes.ts`), with the project's public key, checked as `/api/events` is and cheapest first ([collecting](web-analytics.md#2-collecting)): the address's rate (a burst of 100 chunks, then 2 a second), the body (at most 64 KB, unpacked with a cap of 1 MiB, so a small body cannot unpack into a large one, 413 past it), the key, the page's origin against the project's allowed hostnames, the project's setting and the install's object store (403 `replay_off` without either), bots and data centers (accepted and ignored, as their events are), and the budgets. A chunk is kept as sent; the API does not read into what was recorded, which the player treats as untrusted (below).

Recordings spend their own budgets, in KiB, per project (a burst of 8 MiB, then 256 KiB a second) and per instance (24 MiB, then 768 KiB a second), apart from events' (`EventBudget`), so recordings cannot crowd out events: a site whose replays hit the limit still has its events counted. The instance may also keep `REPLAY_STORAGE_BYTES` (2 GiB by default) of replays and chunks waiting, all projects together, counted in PostgreSQL: a new replay past it is refused (403 `replay_storage_full`), so the store stays bounded. These numbers are a first guess, to be measured on real sites.

## Storage

Decided on 17 November 2026: recordings are files in an object store, reached through the S3 API, and PostgreSQL holds what is known about them.

- **The object store:** any server that speaks the S3 API, set by its endpoint, bucket, and keys. A hosted deployment uses Cloudflare R2 (or Amazon S3); development and self-hosted installs run [Garage](https://garagehq.deuxfleurs.fr/) (AGPL-3.0) in Docker Compose. Not MinIO: its community edition is no longer maintained upstream, nor published as Docker images. Ottertrail uses only the basic calls (put, get, list, and delete objects), so any of them works the same.
- **Landing in PostgreSQL first:** chunks land in PostgreSQL (`replay_chunks`: project, replay ID, number, the compressed bytes, received time), which confirms them once committed; its unique `(project_id, replay_id, seq)` makes a retry harmless.
- **One object per replay:** every 10 seconds the worker (`apps/api/src/replays/replays.ts`) joins each complete replay, its chunks from 0 to the last with none missing, unpacks it, checks that it is a recording, and stores it as one gzip-compressed object, recorded in PostgreSQL (`replays`: project, replay ID, the object's key, size, whether it was cut). A replay costs one write and one read in the store, which charges per request, rather than one per 60 KB chunk. The worker deletes the chunks an hour later, past the tracker's retries (eight attempts, at most a minute apart); a retry after that finds the replay joined and is ignored.
- **A replay whose end never came:** a missing chunk may still come as a retry, so the worker waits until none has come for 5 minutes. Then it keeps what came in order from the first chunk, cut after its last complete event and closed, marked cut; one with no complete event, or that is not a recording, is dropped.
- **Deleting a project's replays** (its settings offer it when replays are turned off) holds the project's row exclusively, and the worker holds it shared while it joins a replay: a deletion waits for a join in progress, then deletes what that join wrote, and a join after it finds no chunks. A test holds a join's upload open, deletes meanwhile, and checks nothing is left.
- **One bucket per instance,** keys by project: `replays/<project_id>/<replay_id>.gz`. A bucket per project would add nothing, and stores limit how many there can be. Who may read what is decided where it always is: the API's access check. The browser never gets the store's keys; playback reads a replay through the API, after that check.
- **The same store for source maps** ([errors](errors.md)), under `source-maps/<project_id>/`.

Recordings are much larger than events, so what to measure on a real site first is bytes per replay, and PostgreSQL's churn while chunks wait there.

## Playback

On an error group's page, each occurrence says whether its replay is ready, still arriving (its error is under 15 minutes old), or missing; a ready one opens the player in a dialog. The player (`packages/replay-player`, served at `/replay-player.js`) starts 60 seconds before the error at most, with the error marked on its timeline and a button to jump to it, and plays at 1×, 2×, or 4×, skipping time with nothing happening. The project's settings turn replays on or off, show the snippet attribute and the privacy options, count the replays and their size, and delete them all.

A recording is whatever a browser sent with a public key, which anyone can copy from a site, so the player treats it as untrusted HTML:

- `@rrweb/replay` builds the page in an `iframe` sandboxed with exactly `allow-same-origin`, never `allow-scripts`: rrweb 2.2.2 sets that itself and refuses to build into a frame sandboxed otherwise (scripts become `noscript`, forms and popups are blocked). Never `UNSAFE_replayCanvas`, which allows scripts. A test plays a recording with a script and event handlers and checks none ran.
- The player runs in a page of its own, `GET /api/projects/:id/replays/:replayId/player` (`apps/api/src/replays/dashboard-routes.ts`), served with a Content Security Policy that lets images, stylesheets, and fonts load only from the project's allowed hostnames ([keys and allowed hostnames](web-analytics.md#keys-and-allowed-hostnames)), so a forged recording cannot make the viewer's browser call other servers; scripts only from Ottertrail, none inline; no forms or `<base>`; and only the dashboard may frame it. The recording itself comes from `GET /api/projects/:id/replays/:replayId`, after the access check every project route runs.
- Nothing from a recording is put into the dashboard's own page.

## Retention and deletion

- Replays are kept 30 days, the shortest retention a project can choose for events, so a replay outlives its error by a day at most. The worker deletes expired replays, object and row, itself rather than through the store's lifecycle rules, which differ from one store to another.
- Deleting a project deletes its replays, everything under its key prefix, through the same `project_deletions` path as events ([ClickHouse](clickhouse.md#retention-and-deleting-a-project)).
- Turning replay off keeps the recordings already made until they expire; the setting offers to delete them now.
- Replays carry no user or visitor ID: a person's replays are found through their errors, which do. Deleting one user's data (not built) will have to delete those.

## What has been tested end to end

On 18 November 2026, in headless Chromium against a running API and the development Garage: a page with the built tracker and `data-replay="errors"` threw an error from a click after a card number was typed; the recorder sent its chunks, the API kept them, the worker joined them into one replay, and the error's occurrence named it, ready. None of the page's planted values (a name, an email, the card digits, a token in a link) nor its text appeared in the stored recording. The player page, under its Content Security Policy, rebuilt the page in a frame sandboxed `allow-same-origin`, every character masked, with the error marked on its timeline. Not yet on a real site, nor in the deployment stack.

## Not in the first version

- Whole sessions, or a sample of them, without an error.
- Showing typed values, even for one field.
- Network requests and console output beside the replay.
- `<canvas>`, video frames, and frames from other domains.
- Search across replays (by page, click, or user), and replays on a user's activity timeline.
- A list of the visitor's clicks and pages beside the player.
- Mobile apps.
- Click heatmaps ([roadmap](roadmap.md#notes)).

## Decisions still open

1. **Budgets:** the bytes per second and stored set above are a first guess: measure a real site's recordings, and set them from that.
2. **Whole sessions:** whether to record any without an error. They would need consent wording and much more storage.
