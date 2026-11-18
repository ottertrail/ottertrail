# Errors

Browser errors: the tracker reports them, Ottertrail groups them, and the Errors pages show each group with how often it happens, to whom, and since when. Part of stage 2 ([roadmap](roadmap.md)). Servers' exceptions, sent over OpenTelemetry, join the same list ([server errors](#server-errors), stage 3).

| Part                                                  | Status  |
| ----------------------------------------------------- | ------- |
| Capture in the browser (uncaught, rejections, caught) | Done    |
| Storage, with the rest of the project's events        | Done    |
| Grouping (fingerprint version 1)                      | Done    |
| Counts, affected users, first and last seen, status   | Done    |
| Errors in a user's activity                           | Done    |
| Source maps (original file names and lines)           | Done    |
| Server errors (exceptions over OTLP, stage 3)         | Done    |
| Alerts on new errors and spikes (stage 4)             | Planned |

## 1. Capture

The tracker (`packages/tracker/src/errors.ts`) reports:

- **Uncaught exceptions:** the window's `error` events that are `ErrorEvent`s. A failed image or script also fires `error`, but on its element, not the window, so it is not reported.
- **Unhandled promise rejections:** an `Error` reason gives its name, message, and stack. Any other value is reported as type `UnhandledRejection`, with JSON for a plain object and `String()` otherwise, and no stack.
- **Errors the site caught itself:** `window.ottertrail.captureError(error, properties)`, marked `handled`. Properties are cleaned as a custom event's are. A value that is not an `Error` is reported as type `Error` with its text as the message.

`data-errors="off"` on the script tag turns automatic capture off; `captureError()` still works.

Skipped as noise:

- `Script error.` without a stack: a script from another origin, loaded without CORS, whose errors the browser hides entirely. Loading such scripts with `crossorigin="anonymous"` (and CORS headers on their server) makes their errors visible.
- Errors whose file, or the first stack frame with a URL, belongs to a browser extension (`chrome-extension://`, `moz-extension://`, `safari-extension://`, `safari-web-extension://`): they are the extension's bugs, not the site's.

A broken page can throw in a loop, so per page load (a single-page app's navigation does not reset it) an identical error, the same type, message, and stack, is sent once, and 25 errors at most. Errors that happen before the tracker runs (it loads with `defer`) are not seen.

Each error is an event named `error` in the tracker's normal batches, with the page and signed-in user of that moment, like a custom event:

```json
{
  "id": "<UUID>",
  "name": "error",
  "occurredAt": 1794823396705,
  "url": "https://shop.example/cart",
  "userId": "42",
  "error": {
    "type": "TypeError",
    "message": "Cannot read properties of undefined (reading 'total')",
    "stack": "TypeError: Cannot read …\n    at renderCart (https://shop.example/assets/index-BfK3x9A2.js:1:2345)",
    "handled": false
  }
}
```

| Field     | Limit                                                                             |
| --------- | --------------------------------------------------------------------------------- |
| `type`    | 1 to 200 characters, no control characters                                        |
| `message` | Up to 2,000 characters; tabs and line breaks allowed, no other control characters |
| `stack`   | Optional, up to 16,000 characters, the same characters as the message             |
| `handled` | Optional, `true` for `captureError()`                                             |

The tracker cuts and cleans to these limits; the API refuses a batch that breaks them (400). The tracker reserves the name: `track("error")` warns and sends nothing. The API counts an event as an error only with the `error` object, and refuses the object on an event with another name. An `error` event without the object stays a custom event, as sites could send before errors existed: an older tracker still in a browser's cache may send one, and refusing it would lose its whole batch. These limits count characters, and a character can take up to four bytes: the tracker also cuts an error's stack, then its message, until the event fits in one request (`fitError` in `tracker.ts`), so a long stack in another script cannot pass the API's 64 KB and lose the error. The tracker grew from 2.9 KB to 3.6 KB gzipped with errors.

## 2. Storage

An error is an event with five more columns, `error_type`, `error_message`, `error_stack`, `error_handled`, and `error_fingerprint`, empty for every other event (PostgreSQL migration 0018, ClickHouse migration 0005). So errors share everything events have: the visitor ID and user ID, environment and release, browser and location, retention, project deletion, and backups. ClickHouse compresses stacks with ZSTD, and a bloom filter on the fingerprint lets one group's page skip the parts without it. A server's exception also fills `service`, `trace_id`, and `span_id` (ClickHouse migration 0009, [server errors](#server-errors)), empty for every other event.

Errors are not web analytics: visits, pages, sources, custom events, and the environment list of the analytics page leave them out (`NOT_AN_ERROR` in `visits.ts`: only errors have a fingerprint), so a page that throws does not turn a bounce into an engaged visit. They are part of the user's activity, with a link to their group.

## 3. Grouping

Occurrences with the same fingerprint form one group (`apps/api/src/errors/fingerprint.ts`). The API works it out on arrival, never trusting a sender with it. Version 1 hashes three things:

1. **The type,** such as `TypeError`.
2. **The message, without what differs between occurrences of one bug:** UUIDs and hex IDs of 8 or more characters become `<id>`, URLs `<url>`, numbers of 4 or more digits `<n>`, and runs of white space one space. Shorter numbers stay, since a status such as `404` or `500` often tells failures apart.
3. **The file of the stack's top frame,** read from V8 (Chrome, Edge, Node.js), Firefox, or Safari stacks, without its origin, query, or fragment, and without the content hash bundlers put in file names (`index-BfK3x9A2.js`, `main.3f2a1c9d.js`, and `page-1a2b3c4d5e6f.js` all lose it). A stack with V8 frames (`at …`) is read as V8's only, so its first line, `Type: message`, is never taken for a frame, even with an `@` in the message. A stack those formats find no frame in is read as a server's: Python, Ruby, Go, Java (and other JVM languages), or .NET, the first format with a frame. A server's error (over OTLP) is read the other way round, server formats first, then V8's for Node.js: Firefox's format takes any line with an `@` and a path for a frame, which a Python message can be (`…: postgresql://app@/shop`). Its top frame is where the exception was raised: Python's traceback lists it last, the others first, and Go's stacks start with the runtime's and OpenTelemetry's own frames, which are skipped. A JVM frame gives its class (`com.example.shop.CartService`), since a file name such as `CartService.java` is the same in every package; a .NET frame its file when the build kept it, else its type. Browsers' fingerprints are what they were before servers' stacks were read (tested). Frames are read with plain string work on lines cut to 1,000 characters, 200 lines at most (Python's last 200): the API does this for every error it receives, and a hostile 16,000-character stack costs no more than a real one, in every format (tested: a hundred hostile stacks of each server format in well under 200 milliseconds, where a pattern that backtracked took most of a second). A server's frame keeps the path its runtime or build gives it, so a different build path or a library's new version (`…/python3.12/site-packages/…`) can start a new group for the same error.

The fingerprint is `1-` and the first 20 hex digits (80 bits) of the SHA-256 of these three, one per line.

Function names and line numbers are left out on purpose: in minified code both change with every build, so each release would start new groups for old bugs. The cost: two bugs with the same message in the same bundle share a group, and browser engines word the same failure differently (Chrome: `Cannot read properties of undefined (reading 'total')`; Safari: `undefined is not an object (evaluating 'cart.total')`), so one bug forms one group per engine. [Source maps](#5-source-maps) give the original files and lines on the error page; a version 2 of the rule could group by them.

The number in front is the rule's version. A new rule gets a new number, so old and new groups never mix; old occurrences keep the groups they were given.

## 4. Status and counts

A group is **unresolved** until someone marks it **resolved**. If it happens again after that, it is **regressed**, which counts as unresolved: the Errors list shows it again, marked. The status belongs to the project, across environments, and is kept in PostgreSQL's `error_resolutions` (migration 0019) with the time and the dashboard user who resolved it. Whether a group regressed is worked out when the list is read, from its latest occurrence in any environment, so collection never writes there: a group resolved and seen again on staging shows as regressed in production's list too.

For a range of days in the organization's timezone and one environment, each group shows:

- **Occurrences,** in the range.
- **Users,** distinct known user IDs ([web analytics](web-analytics.md#known-users)), and **visitors,** distinct visitor IDs. Visitor IDs change every day, so a visitor who hits the error on three days counts three times, as in web analytics.
- **First and last seen,** over all the time the project keeps, in that environment: "first seen" tells a new error from an old one.

One group's page adds the occurrences per day, where they happen (page, browser, OS, release, and a server's service, the top 5 each), its latest 20 occurrences, and the latest one's stack, raw.

```text
GET   /api/projects/:id/errors?period=7d&environment=production&status=unresolved|resolved|all
GET   /api/projects/:id/errors/:fingerprint?period=7d&environment=production
PATCH /api/projects/:id/errors/:fingerprint   { "status": "resolved" | "unresolved" }
```

The list reads at most 1,000 groups, the most recently seen, and says when there were more (`truncated`). Like every project route, these run the organization access check first; the PATCH also needs the dashboard's origin.

## 5. Source maps

Code: `apps/api/src/source-maps/`. A site's build can write a source map beside each minified file: where each position in the minified code came from in the original files, often with the original code itself. Uploaded to Ottertrail, they turn the error page's stack back into the site's own code: `src/cart.ts:3:10` and the lines around it, not `index-4f3a.js:1:28431`.

**Uploading.** One request per minified file and release, with the project's secret key:

```text
PUT /api/source-maps?release=1.4.2&path=/assets/index-4f3a.js
Authorization: Bearer sk_…
Content-Type: application/json
Content-Encoding: gzip   (optional)

{"version":3,"sources":[…],"mappings":"…", …}
```

- `path` is the minified file's path as browsers report it in a stack, without the origin, so a CDN's host does not matter: percent-encoded, without `.` or `..` segments, at most 1,024 characters. A frame matches a map when its URL's path is the map's `path`; a path in any other form is refused, as it could never match.
- `release` is the tracker's `data-release` ([web analytics](web-analytics.md#environments-and-releases)): an error picks the maps of its own release, so a deploy never reads another build's maps. An error without a release cannot be mapped.
- The map is checked before it is kept: JSON, version 3, `sources`, and `mappings` of base64 VLQ; at most 25 MiB once unpacked (a gzip body is unpacked with that cap, so a small body cannot unpack into a large one), 100,000 lines, and 1,000,000 segments. Reading a map builds an array for each line and segment, so those counts, not its size, decide its memory: a few hundred bytes of empty lines would otherwise take gigabytes. They are counted, not decoded, so checking costs little. Index maps (`sections`) are refused for the same reason: their offsets alone could make reading one take any amount of memory. 201 for a new map; 200 when it replaces the release's earlier map of the same file.
- What a request costs before its body is read: the key's form, the address's rate (a burst of 200, then 5 a second), and the key itself are checked from its headers, and an API process stores at most 4 maps at once, answering others 503 with `Retry-After`. A build's uploads wait and try again; the command does so without counting it as a failure.
- The secret key, never the public one: a map often holds the site's source code (`sourcesContent`), and a public key is on every page, so it can only send events.
- `packages/sourcemaps` is a command that uploads a build's maps (not yet published to npm). Build the maps without publishing them, so visitors cannot read the code: Vite's `build.sourcemap: "hidden"` writes them without the comment that points browsers at them, and the command can delete them after uploading.

**Keeping.** The maps are in the install's object store, gzip-compressed, one object per project, release, and path under `source-maps/<project>/`: uploading again replaces. PostgreSQL records each with its size (`source_maps`, migration 0022). An upload writes its row, then its object, then commits, and deleting a release holds its rows until its objects are gone, so the two never leave a row without its map, or a map nothing counts. An install without an object store has source maps off ([deployment](deployment.md#source-maps-and-session-replays)): uploads answer 503 and the error page says so.

- Each organization may keep `SOURCE_MAP_BYTES_PER_ORGANIZATION` (1 GiB by default) of compressed maps, all its projects together; an upload past it answers 409. A soft limit: uploads at the same moment can each pass the check.
- Maps stay until someone deletes them: a release can still run in browsers long after its maps were uploaded, so neither their age nor the project's event retention removes them. The project's settings list each release's maps, with their size, newest or oldest first (the oldest are the ones to delete for room), and delete a release's maps.
- Deleting a project deletes its maps, with its events: the worker, from the same record (`project_deletions`), which stays until the object store has confirmed.

**Reading.** When the error page asks for a group, the API maps the latest occurrence's stack with the maps of that occurrence's release. Each frame's file is looked up by its URL's path; [`@jridgewell/trace-mapping`](https://github.com/jridgewell/sourcemaps) (MIT) gives the original file, line, column, and the name at that position; with the original code in the map, the three lines before and after are shown too. Frames no map covers, such as another site's script, stay as the browser reported them. Maps the API read are kept in its memory, about 128 MB per process counted as they take once decoded, so the next look is quick; one page's maps are read at a time, one after another, and a stack's maps are read for its first 10 files at most. Calls to the object store give up after 30 seconds, and the page then shows the stack as reported. The answer says what happened: mapped; no release; no frame in a file a map could be for (a script written into the page, the browser's own code); no maps for these files; maps for them that cover none of the frames, which may be another build's (both with the paths it looked for, which is what to upload); source maps off; or the store could not be read. The stack as reported stays, and the page shows it on request; grouping still uses it.

**Limits.**

- Only the latest occurrence's stack is mapped.
- The name shown is the one the map has at that position, which is not always the enclosing function's.
- Maps are matched by release and path, not by an ID the build puts in each file: two builds given the same release and the same file names would share maps.
- The object store is not in the backups ([deployment](deployment.md#backups)): after a restore, upload the maps of the releases still in use again.

## Server errors

A server's exception, recorded on a span or in a log record and sent over OTLP ([telemetry](telemetry.md#exceptions-join-the-error-list)), is stored as an error event too, in the same table, grouped by the same rule, and listed with the browser's. It has the service's environment and release, the span's route as its path, the user's ID when the record names one (`user.id`), and three columns of its own: the service, and the trace and span it happened in. It has no visitor, browser, operating system, or location, so it counts towards a group's users but never its visitors.

The error's page shows a server's group by route and service instead of page, browser, and operating system, and the latest occurrence's service, trace ID, and span ID. The trace's own page is planned (telemetry's step 3), so the trace ID is not a link yet. A server's stack is shown as it was sent: source maps are for browser code, so it is never mapped.

## 6. Not done yet

- Grouping by the original files and functions that source maps give (fingerprint version 2), and mapping the stacks of occurrences other than the latest.
- A link from a server's error to its trace, with the Traces page ([telemetry](telemetry.md#how-it-is-built), step 3).
- Alerts on a new or regressed group, or a spike (stage 4).
- Ignoring a group, merging two, searching messages, and "resolved in the next release".
- The visit around an error: for a known user, their activity shows it; for an anonymous visitor there is no timeline page yet.
- Errors from resources (images, scripts that fail to load) and from before the tracker runs.
