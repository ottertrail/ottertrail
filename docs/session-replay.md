# Session replay

**Status: the first version is built, replays around errors, as described here, with a Replays page that lists and filters them, a timeline beside the player, and a user's replays on the user's page ([Finding replays](#finding-replays)); what it leaves out is under [Not in the first version](#not-in-the-first-version). Stage 5 of the [roadmap](roadmap.md).**

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

A marker applies to the element and everything inside it, and the stricter one wins: block, then mask, then unmask. `data-ottertrail-block` and `data-ottertrail-mask` also keep [heatmaps](web-analytics.md#heatmaps) out: a click inside either is not recorded at all.

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

A browser test proves the result rather than trusting either (`packages/tracker/tests/browser/replay.test.ts`): it records a fixture page full of planted values (a name, an email, a card number, tokens in a link's, an image's, a `srcset`'s, and a style's addresses, text in `title`, `placeholder`, `alt`, `aria-label`, `data-*`, and `<meta>`, a typed password, text input, text area, chosen option, an edited region, text inserted and an attribute changed after load, and text in masked and blocked regions), with the default settings, then decompresses what the recorder sent and checks that none of the planted values appears in it. Only the events' times are left out of that search, each after it is checked to be a time while the page was recorded: a 13-digit time now and then holds a planted number such as `4111` by chance. It runs the same with rrweb's own masking turned off, where raw rrweb does send a dozen of them, so the filter alone is proven. Each loosening (`data-replay-text`, `data-replay-media`, `data-ottertrail-unmask`) has its own case, including that unmasking never shows a typed value. One more case starts the recording as a site waiting for consent does: the tracker runs with `data-replay-consent="wait"`, requests nothing, then `replay(true)` adds `r.js`, whose entry point runs with the configuration the tracker gave it; errors go through `captureError()`, and the replay is sent with the recorder's own timings. None of the planted values is in it, and nothing was written to cookies or storage. The test runs in `vp run ready`; a new rrweb version is only taken when it passes.

## Recording

### Turning it on

Two switches, both needed:

- **The project's setting,** in the dashboard: Replay off (the default) or "around errors". While it is off, the API refuses recordings (403 `replay_off`), and a recorder that is refused stops for the rest of the page load.
- **The snippet,** on the site's pages: `data-replay="errors"` loads the recorder. The privacy settings are in the snippet too (`data-replay-text`, `data-replay-media`), as the site's own choice, because public keys never read a project's configuration (only collection is allowed with them). The dashboard shows the snippet to copy, with the chosen settings.

The site decides about consent ([below](#waiting-for-consent)): with `data-replay-consent="wait"`, recording starts only when the page says the visitor agreed, and `window.ottertrail.replay(false)` stops it and drops the buffer.

A site should keep personal data out of its paths, such as an email address or a reset token in `/users/ada@example.com/reset/tok_…`. Query strings and fragments are always dropped, but a path is kept whole, as page analytics keeps it, and the Replays page lists and searches the paths of each replay ([below](#what-the-worker-derives)).

### Waiting for consent

For sites that ask visitors before recording. Add `data-replay-consent="wait"` beside `data-replay="errors"`:

```html
<script
  defer
  src="https://ottertrail.example.com/tracker.js"
  data-key="pk_00000000000000000000000000000000"
  data-host="https://ottertrail.example.com"
  data-replay="errors"
  data-replay-consent="wait"
></script>
```

The tracker then does not load `r.js` until the page calls `window.ottertrail.replay(true)`. Everything else works as usual: pageviews, errors, Web Vitals. Errors before then carry no replay ID. The dashboard's Session replay tab has a "Wait for the visitor's consent" switch that adds the attribute to the code to copy and shows the calls below; it changes only what is shown, and nothing is saved, as for the privacy options.

What each call does:

- **`replay(true)`** starts recording, with the snippet's privacy settings (`data-replay-text`, `data-replay-media`): it loads `r.js` the first time, and the recorder records from then on, as described above. Calling it again while recording does nothing. Without `data-replay="errors"` on the tag it records nothing and warns in the console once: replay is the site's declared choice, with its privacy settings in the snippet, never something a call turns on alone. A tag pinned with `integrity` never loads `r.js` ([the recorder script](#the-recorder-script)), so there it records nothing either, and warns once. It never throws into the page, nor into a consent tool's callback: if the recorder fails to start or stop (such as an older `r.js` still in the browser's cache after an upgrade), it warns once and records nothing more.
- **`replay(false)`** stops recording and drops what was recorded, in memory on the page. Called before `replay(true)`, or while `r.js` is still loading, it cancels the start: the recorder stops as soon as it runs, before it records. A replay already sent stays sent.
- **`replay(true)` after `replay(false)`** starts a new, empty recording: what was dropped stays dropped, and the new one begins with a fresh snapshot, as on a page load. `r.js` is not downloaded again. The last call wins, so a visitor who declines and then agrees, or agrees, withdraws, and agrees again, is recorded from their last "yes". This also means a consent tool that reports "not yet given" when the page loads and "given" later works without special care. The exceptions: a recorder that stopped itself, because the API refused it (`replay_off`) or the filter failed, stays stopped for the page load, and each new recording sends at most one replay, so a page load whose visitor changes their mind can send more than one.

The rule is the same without `data-replay-consent`: recording starts on load, as before, `replay(false)` stops it, and only an explicit `replay(true)` starts a new one.

**Nothing is stored on the visitor's device.** The tracker writes no cookie, `localStorage`, or `sessionStorage`, for consent or anything else; it keeps the answer in memory for the page load only. The site's own consent tool remembers what the visitor chose, and the site calls `replay(true)` on every page load once that answer is known: from its consent tool's "consent given" callback, or right after the tag when the tool already has a stored "yes".

**Calls before the tracker runs.** The tracker is `defer`red, so a consent banner can answer before `window.ottertrail` exists. A site that may call that early defines this stand-in first, before the tracker's tag and its consent tool's:

```html
<script>
  window.ottertrail =
    window.ottertrail ||
    (function () {
      var q = [];
      function noop() {}
      return {
        q: q,
        replay: function (on) {
          q.push(on);
        },
        track: noop,
        identify: noop,
        reset: noop,
        captureError: noop,
      };
    })();
</script>
```

It keeps the answers to `replay()` in `q`. Its other methods, `track()`, `identify()`, `reset()`, and `captureError()`, do nothing: those calls are not queued, and are lost if they come before the tracker runs, but they never throw, so code written as `window.ottertrail?.track(…)` keeps working. When the tracker runs, it puts the real `window.ottertrail` in its place, points the stand-in's methods at its own (so a reference the page kept, such as `var ot = window.ottertrail`, reaches the tracker too), and makes the last queued call as `replay()` takes it: only `true` starts, and anything else, such as `"denied"`, stops. So a "yes" followed by a "no" before it ran never loads `r.js`. If the tracker never runs (blocked, or a tag without `data-key`), the answers stay queued and nothing is recorded.

**The tracker twice on one page,** such as in a tag manager and in the page's template: the second copy finds the first's `window.ottertrail` (marked as the real one, which the stand-in is not), warns in the console once, and does nothing more. It sends no events, loads no recorder, and leaves `window.ottertrail` to the first, so `replay(false)` always reaches the one recorder.

A plain HTML banner, for a site without a consent tool, that asks on each page load (a real site would remember the answer in its own way and call `replay(true)` without asking again):

```html
<script>
  window.ottertrail =
    window.ottertrail ||
    (function () {
      var q = [];
      function noop() {}
      return {
        q: q,
        replay: function (on) {
          q.push(on);
        },
        track: noop,
        identify: noop,
        reset: noop,
        captureError: noop,
      };
    })();
</script>
<script
  defer
  src="https://ottertrail.example.com/tracker.js"
  data-key="pk_00000000000000000000000000000000"
  data-host="https://ottertrail.example.com"
  data-replay="errors"
  data-replay-consent="wait"
></script>

<div id="replay-consent" role="region" aria-label="Session recording">
  <p>May we record this visit, masked, to fix errors you run into?</p>
  <button type="button" data-answer="yes">Agree</button>
  <button type="button" data-answer="no">Decline</button>
</div>
<script>
  document.querySelectorAll("#replay-consent button").forEach(function (button) {
    button.addEventListener("click", function () {
      window.ottertrail.replay(button.dataset.answer === "yes");
      document.getElementById("replay-consent").hidden = true;
    });
  });
</script>
```

**With a consent management platform.** Ottertrail shows no banner of its own: most sites that ask already run a consent tool, and a second banner would ask visitors twice. Put session replay in the tool's category for statistics or analytics (or a category of its own), keep the stand-in above the tool's script, and call `window.ottertrail.replay(true)` from the tool's "consent given" callback for that category and `window.ottertrail.replay(false)` from its "consent withdrawn" or "declined" callback. Tools that report the stored answer on every page load, or each time the visitor changes it, need nothing more: the last call wins, and calling `replay(true)` twice is harmless. How each tool names its callbacks is in its own documentation.

**Telling visitors.** Whether a site must ask, and what its privacy notice must say, is for the site's owner and their legal advice: it depends on the law where the site and its visitors are, and on what the site records. A site that records sessions usually says so in its privacy notice, asking first or not. A sample paragraph to adapt, for a site using these defaults:

> When something goes wrong on a page, we may keep a short recording of the page as it appeared and of what you did on it, such as clicks, scrolling, and mouse movements, to find and fix the problem. Page text is hidden in the recording, and so are the characters you type, though the recording shows where and when you typed, and how many characters. With it we keep the addresses of the pages you visited (without the part after a "?" or "#"), the size of your browser window, your browser, operating system, and type of device, and the error that happened. Recordings are kept on our own analytics server for 30 days and are not used for advertising. If you are signed in, a recording is linked to your account.

Keep the last sentence only for a site that names its signed-in users (`identify`, [web analytics](web-analytics.md#known-users)): a replay is then linked to the user of its error. Change the rest when the settings change: with `data-replay-text="show"` the page's text is recorded, with `data-replay-media="show"` its images are, and with `data-replay-consent="wait"` the notice can say that recording starts only after the visitor agrees. "Our own analytics server" holds for a self-hosted instance; a site whose instance someone else hosts names them as it names its other processors. "30 days" is how long the instance keeps replays; backups made with `backup.sh` hold the object store's replays too ([deployment](deployment.md#backups)), for as long as the operator keeps the backups, so a site that keeps its backups longer than 30 days says so (for example, "and in backups for up to 90 days").

The tests: `packages/tracker/tests/script.test.ts` ("session replay after consent") checks that `r.js` is not requested until `replay(true)`, that it then gets the snippet's privacy settings, the warning without `data-replay`, two calls in a row, `replay(false)` before and after `replay(true)` (running or still loading), a new recording after `replay(false)`, the queued calls (the last one counts, `[true, "denied"]` records nothing), the stand-in's other methods, a reference kept to the stand-in, the tracker loaded twice, the warning on a tag pinned with `integrity`, an older `r.js` without `again()`, and that nothing is written to cookies or storage. The stand-in they run is `packages/tracker/tests/stand-in.ts`, the same code as above. The browser test runs the tracker and `r.js`'s entry point in Chromium with the stand-in defined by a real inline script, runs the privacy test on a recording started by `replay(true)` (below), and on one started again after `replay(false)`: the first recording sent nothing, and the replay begins after the second `replay(true)`.

### The recorder script

`r.js`, served beside the tracker as `v.js` is ([Web Vitals](web-analytics.md#web-vitals)), loaded by the tracker only when the snippet asks for it, so pages that do not record never download it: 94 KB, 29 KB gzipped, nearly all of it rrweb. The loader made `tracker.js` 135 bytes larger, gzipped, and waiting for consent (`replay(true)`, the queue, the new recording after `replay(false)`, the guard against a second copy, the warnings) 351 bytes more, from 4,060 to 4,411 bytes gzipped. It inherits `v.js`'s limits: no recorder for a tracker pinned with `integrity`, the tracker's `nonce` under a strict Content Security Policy.

### Only around errors

The recorder records all the time into memory and sends nothing until an error. One of rrweb's documented ways: a full snapshot every 30 seconds (`checkoutEveryNms`), and the buffer keeps the current and the previous stretch, so it always starts with a snapshot and covers 30 to 60 seconds before now. Older stretches are dropped.

When the tracker reports an error ([errors](errors.md#1-capture)), the recorder keeps recording for 10 more seconds, to show what the error did to the page, then sends the buffer. The error event carries the replay's ID (`replayId`, a UUID made by the recorder), and so do later errors of the same page load while it is still recording. One replay per recording, and one recording per page load unless the page stops it and starts a new one ([waiting for consent](#waiting-for-consent)): errors after it was sent get none.

### Sending

- The recording is `{"v":1,"events":[…]}`, cut into pieces of its text, each compressed with gzip in the browser (`CompressionStream`, in every current browser since May 2023) to at most 60,000 bytes, so a chunk fits a beacon when the visitor leaves mid-upload, and unpacking to at most 1,000,000 bytes, under the API's 1 MiB: a masked page's runs of one character compress to almost nothing, so this limit, not the compressed one, cuts those. The part recorded before the error is compressed at once, so it is ready if the page closes.
- `POST /api/replays?key=pk_…&replay=<uuid>&seq=<n>&last=0|1&cut=0|1`, the chunk as `text/plain`, which a page sends without a preflight and as a beacon. Each chunk is one gzip member, and the members joined in order unpack to the recording. Chunks retry as event batches do ([retries](web-analytics.md#retries)), with the same numbers, so the API keeps each once. A 403 stops the replay, and `replay_off` stops recording for the rest of the page load.
- At most 2 MB compressed and 100 chunks per replay (the API numbers chunks 0 to 99; the tracker fills each chunk at least about half, so 2 MB comes first); a page so large or so busy that its recording would need more sends what fits, cut at an event, marked cut, its last chunk closing the JSON.
- At most 16 MiB unpacked per replay, all its chunks together: the API records what each chunk unpacks to (`replay_chunks.unpacked_bytes`) and refuses a chunk that would pass it (413 `replay_too_large`, "A replay unpacks to at most 16 MiB"). One replay's chunks are checked and stored one at a time (a PostgreSQL advisory lock on the project and replay), so chunks arriving together cannot all pass the cap. Should a replay's chunks unpack past it anyway, the worker unpacks them one by one and keeps those that fit, cut after the last whole event, rather than dropping the replay. Masked text compresses far better than the rest of a recording, so the compressed limit alone would let a replay unpack to 100 MiB, which the worker and the viewer's tab would each read whole. A minute of a busy page comes to a few MiB. The chunks kept before the refusal are joined as a replay whose end never came ([below](#storage)).
- Leaving the page: browsers let about 64 KB of beacons and `keepalive` requests be on their way at once, shared with the tracker's events, so a visitor who leaves just after an error often sends only the first chunk. The API keeps what came (below).

## The API

`POST /api/replays` (`apps/api/src/replays/routes.ts`), with the project's public key, checked as `/api/events` is and cheapest first ([collecting](web-analytics.md#2-collecting)): the address's rate (a burst of 100 chunks, then 2 a second; an IPv6 address counts by its /64), the key's form (one `key` of the public key's form, else 400 before the body is read), the body (at most 64 KB, unpacked with a cap of 1 MiB, so a small body cannot unpack into a large one, 413 past it), the key, the page's origin against the project's allowed hostnames, the project's setting and the install's object store (403 `replay_off` without either), the project's blocked addresses, bots, and data centers (accepted and ignored, as their events are, [spam](web-analytics.md#blocked-addresses)), the chunks in progress (once a chunk's body has arrived, an API process works on at most 256 at once, 503 `busy` past it, and on at most 128 of one project's, 429 past it, both with `Retry-After`: a page leaving sends all of a replay's up to 100 pieces at once, by beacon, which never retries, so the caps stay well above that), and the budgets. Every chunk accepted gets the same answer, 202 `{ "received": 1 }`: one stored, a retry of one already stored, and one a filter caught alike, so a sender never learns which. The recorder reads only the status (and `replay_off` on a 403). A chunk is kept as sent; the API does not read into what was recorded, which the player treats as untrusted (below). A request the schema refuses gets a fixed message (400 `invalid_request`), never the validator's own words: the caller is not signed in.

Recordings spend their own budgets, in KiB, per project (a burst of 8 MiB, then 256 KiB a second) and per instance (24 MiB, then 768 KiB a second), apart from events' (`EventBudget`), so recordings cannot crowd out events: a site whose replays hit the limit still has its events counted. The instance may also keep `REPLAY_STORAGE_BYTES` (2 GiB by default) of replays and chunks waiting, all projects together, counted in PostgreSQL: a new replay past it is refused (403 `replay_storage_full`), so the store stays bounded. These numbers are a first guess, to be measured on real sites.

## Storage

Decided on 17 November 2026: recordings are files in an object store, reached through the S3 API, and PostgreSQL holds what is known about them.

- **The object store:** any server that speaks the S3 API, set by its endpoint, bucket, and keys. A hosted deployment uses Cloudflare R2 (or Amazon S3); development and self-hosted installs run [Garage](https://garagehq.deuxfleurs.fr/) (AGPL-3.0) in Docker Compose. Not MinIO: its community edition is no longer maintained upstream, nor published as Docker images. Ottertrail uses only the basic calls (put, get, list, and delete objects), so any of them works the same.
- **Landing in PostgreSQL first:** chunks land in PostgreSQL (`replay_chunks`: project, replay ID, number, the compressed bytes, received time), which confirms them once committed; its unique `(project_id, replay_id, seq)` makes a retry harmless.
- **One object per replay:** every 10 seconds the worker (`apps/api/src/replays/replays.ts`) joins up to 100 replays that can be joined now (complete, or quiet for 5 minutes), oldest first by their first chunk's arrival, so a flood of new replays cannot keep older ones waiting, and replays still waiting for a chunk take none of the 100 places. It joins each complete replay, its chunks from 0 to the last with none missing, unpacks it, checks that it is a recording, and stores it as one gzip-compressed object, recorded in PostgreSQL (`replays`: project, replay ID, the object's key, size, whether it was cut, and what the Replays page lists, [below](#what-the-worker-derives)). A replay costs one write and one read in the store, which charges per request, rather than one per 60 KB chunk. The worker deletes the chunks an hour later, past the tracker's retries (eight attempts, at most a minute apart); a retry after that finds the replay joined and is ignored.
- **A replay whose end never came:** a missing chunk may still come as a retry, so the worker waits until none has come for 5 minutes. Then it keeps what came in order from the first chunk, cut after its last complete event and closed, marked cut; one with no complete event, or that is not a recording, is dropped.
- **What is not a recording is dropped,** its chunks deleted: not JSON, no events, more than 100,000 events (a minute of a busy page has a few thousand), or an event whose time is not a number from 1970 to 2100 in epoch milliseconds. A visitor's clock may be off by years, which the join corrects ([below](#what-the-worker-derives)); a time outside that range is not a clock's.
- **One replay's failure is its own:** the others of the run go on. While the object store refuses a replay (down, or Garage's bucket quota), or PostgreSQL cannot be reached, its chunks wait for the next run, and the worker logs the outage once. When PostgreSQL refuses the replay's own data (a value out of range, a broken constraint), or the join's code fails on it, it would fail on every run, so the replay is dropped, its chunks and object deleted, and the worker logs it, unless another run recorded it meanwhile: the drop locks the replay's chunks, which a join holds shared, then checks for its row. Node's coded errors (such as `ERR_OUT_OF_RANGE`) count as the join's own; system errors (such as `ECONNRESET`) as passing. Tested in `replays.test.ts`.
- **Deleting a project's replays** (its settings offer it when replays are turned off) holds the project's row exclusively, and the worker holds it shared while it joins a replay: a deletion waits for a join in progress, then deletes what that join wrote, and a join after it finds no chunks. A test holds a join's upload open, deletes meanwhile, and checks nothing is left.
- **One bucket per instance,** keys by project: `replays/<project_id>/<replay_id>.gz`. A bucket per project would add nothing, and stores limit how many there can be. Who may read what is decided where it always is: the API's access check. The browser never gets the store's keys; playback reads a replay through the API, after that check.
- **The same store for source maps** ([errors](errors.md)), under `source-maps/<project_id>/`.

Recordings are much larger than events, so what to measure on a real site first is bytes per replay, and PostgreSQL's churn while chunks wait there.

## Playback

On an error group's page, each occurrence says whether its replay is ready, still arriving (its error is under 15 minutes old), or missing; a ready one opens the player in a dialog. The player (`packages/replay-player`, served at `/replay-player.js`) starts 60 seconds before the error at most, with the error marked on its timeline and a button to jump to it, and plays at 1×, 2×, or 4×, skipping time with nothing happening. The project's settings turn replays on or off, show the snippet attribute and the privacy options, count the replays and their size, and delete them all.

A recording is whatever a browser sent with a public key, which anyone can copy from a site, so the player treats it as untrusted HTML:

- `@rrweb/replay` builds the page in an `iframe` sandboxed with exactly `allow-same-origin`, never `allow-scripts`: rrweb 2.2.2 sets that itself and refuses to build into a frame sandboxed otherwise (scripts become `noscript`, forms and popups are blocked). Never `UNSAFE_replayCanvas`, which allows scripts. A test plays a recording with a script and event handlers and checks none ran.
- The player runs in a page of its own, `GET /api/projects/:id/replays/:replayId/player` (`apps/api/src/replays/dashboard-routes.ts`), served with a Content Security Policy (`playerPolicy`) whose directives allow these sources, and nothing else (`default-src 'none'`):
  - `script-src 'self'`: the player's own script, none inline and none from the recording.
  - `connect-src 'self'`: the player reads the recording from the API.
  - `style-src 'unsafe-inline'` and the project's allowed hostnames, over `https:` or `http:` on any port ([keys and allowed hostnames](web-analytics.md#keys-and-allowed-hostnames)): the player's CSS and the recording's stylesheets are written into the page as text.
  - `img-src data: blob:` and the allowed hostnames: rrweb's cursor is a `data:` image.
  - `font-src data:` and the allowed hostnames.
  - `base-uri 'none'`, `form-action 'none'`, and `frame-ancestors 'self'`: no `<base>`, no forms, and only the dashboard may frame it.

  So a forged recording cannot make the viewer's browser call other servers. Styles, images, and fonts never load from Ottertrail's own address: a recorded `<img src="/api/…">` would send the viewer's cookie with a GET to the API. The player's browser tests run under these directives, so they show it needs nothing from there (`packages/replay-player/tests/browser/policy.ts`). The recording itself comes from `GET /api/projects/:id/replays/:replayId`, after the access check every project route runs.

- Nothing from a recording is put into the dashboard's own page.

The same script shows a saved heatmap view ([web analytics](web-analytics.md#saved-views)) in its snapshot mode (`packages/replay-player/src/snapshot.ts`): its page, `GET /api/projects/:id/heatmaps/snapshots/:device/player`, is served with the same policy and names the snapshot and its heatmap in place of a recording. rrweb rebuilds the snapshot in the same sandboxed frame, with no controls; the player finds the heatmap's elements in the frame and draws over it, and tells the dashboard which elements it did not find. A test (`tests/browser/snapshot.test.ts`) rebuilds a snapshot with a script and handlers, checks none ran and links do nothing, and that the elements are found and drawn.

## Finding replays

Replays stay error-only (decided 18 November 2026): the three views below show the recordings the rules above already made, and add nothing to what a page records or sends.

### What the worker derives

When the worker joins a replay, it reads the recording once more, as it is stored, already masked in the visitor's browser (`apps/api/src/replays/derive.ts`), and keeps in the replay's row (migration `0005_replay_details`):

- **When:** the first and last event's times, so the replay's length. A visitor's clock can be wrong, and the recorder sends a replay's first chunk as the recording ends, so a recording that ends more than 10 minutes away from that chunk's arrival is moved by the difference. Ten minutes is far beyond the tracker's retries (eight attempts, at most a minute apart): a first chunk that came only on a retry, minutes late, does not move a right clock, and a clock off by less is left as it is. The row keeps the correction, and the player, which counts on the recording's own clock, gets its times back.
- **Pages:** the paths of rrweb's Meta events, in the order first seen, at most 30, cleaned as page URLs are ([collecting](web-analytics.md#2-collecting)): no origin, query string, or fragment. The path itself is kept whole, so an email address or token a site puts in a path segment is kept too, as page analytics keeps it, and is listed and searchable on the Replays page; sites should keep personal data out of paths ([turning it on](#turning-it-on)). rrweb writes a Meta event when the page loads and with each full snapshot, every 30 seconds, so a single-page app's route change shows at the next snapshot, up to 30 seconds late, and one undone before it is not seen.
- **Counts:** clicks, and page changes (a Meta event with another path).
- **A timeline,** at most 500 items, as JSON in the row: each page change, each click, each run of inputs in one field (one item, "typed in a field" or "changed a field"), scrolls (those less than a second apart are one item), and the recorder's own error marker, each with its time from the recording's start. Past 500, only as many scrolls as needed are dropped, the earliest; when that is not enough, every scroll goes and then the earliest items. The timeline stores which happened (`truncated`: `"scrolls"` or `"earliest"`), and says so.

A click is described only by what the recording holds without text: the element's tag, its role, and the click's position in the viewport. The role is the element's own `role` attribute when it is one of a fixed list (button, link, checkbox, tab, and so on), otherwise its tag's (a link for `<a>`, a text field for `<input type="text">`); a click on the icon inside a button is the button's. `role` and `type` are among the structure attributes the recorder's filter keeps as they are, and here they are only matched against those lists. No text, typed value, or other attribute is read; inputs never say what was typed, which the recording masks anyway (`*` for each character).

Then the worker finds the replay's error (`apps/api/src/replays/link.ts`): the error events in ClickHouse that carry the replay's ID, read by project first, within an hour of the replay. From the first of them it keeps the error's time, group, type, and message, the known user, the environment, and the browser, OS, and device. The page sends its error before its replay, so the error is almost always there at once; one not found is looked for again later after each miss (half the replay's age, from 10 seconds to 10 minutes, `next_link_at`), and given up an hour after the join, when the row says its error was not found. Each run takes the most due replays, at most 20 of one project, so a project whose errors never come keeps no other project's replays waiting. The worker runs this apart from joining, so a ClickHouse outage stops only the search, logged once until it works again.

### The Replays page

`/projects/<id>/replays`, beside Errors in the project's menu ([dashboard](dashboard.md#replays)): every replay of the project, newest first, with when it started, its length, whether it was cut, its error (a link to the error's page), the known user (a link to their page), the paths visited, the environment, and the browser and device. Filters: the period and environment, as on every page; a path visited contains some text (case ignored, matched as it is, no wildcards); a user ID; an error group; and a minimum length. A replay whose error was not found has no environment, and shows in every one.

`GET /api/projects/:id/replays/list` reads PostgreSQL alone, not ClickHouse: the worker has already copied what the list shows and filters by, so a page is one query on the replays table, by project, then start time and replay ID (an index of its own), never a scan across projects. Every value is a parameter, and each is checked before the query: days as on reports, an environment name, a path and user ID of at most 200 characters without control characters, a fingerprint, a minimum length up to an hour. It answers 50 replays at a time (at most 100), and a cursor (the last replay's start and ID) for the next page, so replays joined meanwhile cannot shift the pages. The first page also lists the period's environments and error groups, at most 50 of each, for the filters. Replays are kept 30 days, so a project's table stays bounded by its budgets.

### The timeline

Beside the player, on a replay's own page (`/projects/<id>/replays/<replay ID>`) and in the error page's replay dialog: the timeline's items, each with its time: "On /cart", "Clicked a button at 120, 340", "Typed in a field", "Went to /checkout", "The error". Scrolls are hidden until "Show scrolls" is ticked. Clicking an item moves the player to that moment, and the item the player is at is marked as it plays. `GET /api/projects/:id/replays/:replayId/timeline` serves the stored timeline with the replay's details, so the browser never reads the recording a second time. Paths and tags from a recording are shown as text only.

The player stays on its own page, under the same Content Security Policy, in a frame where no script of the recording runs. The dashboard and the player talk with `postMessage` (`apps/web/src/lib/replay-messages.ts`, `packages/replay-player/src/format.ts`):

- The dashboard sends `{"type":"ottertrail:replay-seek","offsetMs":…}` only to the player's frame, with its own origin as the target.
- The dashboard sends `{"type":"ottertrail:replay-pause"}` the same way when CSS hides the replays workbench's pane (the window narrowed under 64rem). The player takes it only from its parent window, from its own origin, with exactly that one key, and pauses; a player that is paused, or still loading, stays as it is.
- The dashboard sends `{"type":"ottertrail:replay-theme","theme":"light"}` (or `"dark"`) the same way when its theme changes ([design system](design-system.md#color)), and again when the frame loads. The player's page opens in the dashboard's theme already: the dashboard adds `?theme=light` or `?theme=dark` to its address, and the API writes it on the page's `<html>` (`data-theme`) and in its `color-scheme`, so the controls never flash the other theme. Only the player's bar, messages and controls change; the recorded page keeps its own colors.
- The player takes a message only from its parent window, from its own origin (the dashboard's: `frame-ancestors 'self'`), with exactly those two keys and an offset from 0 to a day; a seek that comes while the recording loads is made once it is ready. It answers with `{"type":"ottertrail:replay-time","offsetMs":…,"totalMs":…}`, to its parent and its own origin only, a few times a second while it plays.
- The dashboard takes a message only from the player's frame, from its own origin, in exactly that shape.

Anything else is ignored. The recording's own frame, inside the player, runs no script, so it can send nothing.

### A user's replays

On a user's page, each error the page recorded a replay for links to it ("Play replay"), or says it is on its way; and the page lists the user's latest 10 replays in the environment, from the replays table, by the user ID copied from their error.

## Retention and deletion

- Replays are kept 30 days, the shortest retention a project can choose for events, so a replay outlives its error by a day at most. The worker deletes expired replays, object and row, itself rather than through the store's lifecycle rules, which differ from one store to another.
- Deleting a project deletes its replays, everything under its key prefix, through the same `project_deletions` path as events ([ClickHouse](clickhouse.md#retention-and-deleting-a-project)).
- Turning replay off keeps the recordings already made until they expire; the setting offers to delete them now.
- A recording carries no user or visitor ID. Its row in PostgreSQL keeps the user ID of its first error, copied from that error event, so the user's page can list it. Deleting one user's data (not built) will have to delete those replays, and their rows.

## What has been tested end to end

On 18 November 2026, in headless Chromium against a running API and the development Garage: a page with the built tracker and `data-replay="errors"` threw an error from a click after a card number was typed; the recorder sent its chunks, the API kept them, the worker joined them into one replay, and the error's occurrence named it, ready. None of the page's planted values (a name, an email, the card digits, a token in a link) nor its text appeared in the stored recording. The player page, under its Content Security Policy, rebuilt the page in a frame sandboxed `allow-same-origin`, every character masked, with the error marked on its timeline. Not yet on a real site, nor in the deployment stack.

## Not in the first version

- Whole sessions, or a sample of them, without an error.
- Showing typed values, even for one field.
- Network requests and console output beside the replay.
- `<canvas>`, video frames, and frames from other domains.
- Search by what was clicked, or by anything in a recording that the worker does not derive.
- A single-page app's route changes as they happen: they show at the next full snapshot ([above](#what-the-worker-derives)).
- Mobile apps.
- Click heatmaps ([roadmap](roadmap.md#notes)).

## Decisions still open

1. **Budgets:** the bytes per second and stored set above are a first guess: measure a real site's recordings, and set them from that.
2. **Whole sessions:** decided on 18 November 2026: not recorded. Replays stay error-only, which keeps a privacy-first product's strongest promise, that nothing is kept unless something broke. Server-side failures are seen in logs, traces, and metrics instead ([telemetry](telemetry.md)).
