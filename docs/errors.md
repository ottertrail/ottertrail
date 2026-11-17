# Errors

Browser errors: the tracker reports them, Ottertrail groups them, and the Errors pages show each group with how often it happens, to whom, and since when. Part of stage 2 ([roadmap](roadmap.md)).

| Part                                                  | Status  |
| ----------------------------------------------------- | ------- |
| Capture in the browser (uncaught, rejections, caught) | Done    |
| Storage, with the rest of the project's events        | Done    |
| Grouping (fingerprint version 1)                      | Done    |
| Counts, affected users, first and last seen, status   | Done    |
| Errors in a user's activity                           | Done    |
| Source maps (original file names and lines)           | Planned |
| Back-end errors (exceptions on traces, stage 3)       | Planned |
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

The tracker cuts and cleans to these limits; the API refuses a batch that breaks them (400), and the database checks them again (migration 0018). The tracker reserves the name: `track("error")` warns and sends nothing. The API counts an event as an error only with the `error` object, and refuses the object on an event with another name. An `error` event without the object stays a custom event, as sites could send before errors existed: an older tracker still in a browser's cache may send one, and refusing it would lose its whole batch. These limits count characters, and a character can take up to four bytes: the tracker also cuts an error's stack, then its message, until the event fits in one request (`fitError` in `tracker.ts`), so a long stack in another script cannot pass the API's 64 KB and lose the error. The tracker grew from 2.9 KB to 3.6 KB gzipped.

## 2. Storage

An error is an event with five more columns, `error_type`, `error_message`, `error_stack`, `error_handled`, and `error_fingerprint`, empty for every other event (PostgreSQL migration 0018, ClickHouse migration 0005). So errors share everything events have: the visitor ID and user ID, environment and release, browser and location, retention, project deletion, backups, and the copy from PostgreSQL to ClickHouse. ClickHouse compresses stacks with ZSTD, and a bloom filter on the fingerprint lets one group's page skip the parts without it.

Errors are not web analytics: visits, pages, sources, custom events, and the environment list of the analytics page leave them out (`NOT_AN_ERROR` in `visits.ts`: only errors have a fingerprint), so a page that throws does not turn a bounce into an engaged visit. They are part of the user's activity, with a link to their group.

## 3. Grouping

Occurrences with the same fingerprint form one group (`apps/api/src/errors/fingerprint.ts`). The API works it out on arrival, never trusting a sender with it. Version 1 hashes three things:

1. **The type,** such as `TypeError`.
2. **The message, without what differs between occurrences of one bug:** UUIDs and hex IDs of 8 or more characters become `<id>`, URLs `<url>`, numbers of 4 or more digits `<n>`, and runs of white space one space. Shorter numbers stay, since a status such as `404` or `500` often tells failures apart.
3. **The file of the stack's top frame,** read from V8 (Chrome, Edge, Node.js), Firefox, or Safari stacks, without its origin, query, or fragment, and without the content hash bundlers put in file names (`index-BfK3x9A2.js`, `main.3f2a1c9d.js`, and `page-1a2b3c4d5e6f.js` all lose it). A stack with V8 frames (`at …`) is read as V8's only, so its first line, `Type: message`, is never taken for a frame, even with an `@` in the message. Frames are read with plain string work on lines cut to 1,000 characters, 200 lines at most: the API does this for every error it receives, and a hostile 16,000-character stack costs no more than a real one (tested).

The fingerprint is `1-` and the first 20 hex digits (80 bits) of the SHA-256 of these three, one per line.

Function names and line numbers are left out on purpose: in minified code both change with every build, so each release would start new groups for old bugs. The cost: two bugs with the same message in the same bundle share a group, and browser engines word the same failure differently (Chrome: `Cannot read properties of undefined (reading 'total')`; Safari: `undefined is not an object (evaluating 'cart.total')`), so one bug forms one group per engine. Source maps (planned) would give real function names and files, and a version 2 could use them.

The number in front is the rule's version. A new rule gets a new number, so old and new groups never mix; old occurrences keep the groups they were given.

## 4. Status and counts

A group is **unresolved** until someone marks it **resolved**. If it happens again after that, it is **regressed**, which counts as unresolved: the Errors list shows it again, marked. The status belongs to the project, across environments, and is kept in PostgreSQL's `error_resolutions` (migration 0019) with the time and the dashboard user who resolved it. Whether a group regressed is worked out when the list is read, from its latest occurrence in any environment, so collection never writes there: a group resolved and seen again on staging shows as regressed in production's list too.

For a range of days in the organization's timezone and one environment, each group shows:

- **Occurrences,** in the range.
- **Users,** distinct known user IDs ([web analytics](web-analytics.md#known-users)), and **visitors,** distinct visitor IDs. Visitor IDs change every day, so a visitor who hits the error on three days counts three times, as in web analytics.
- **First and last seen,** over all the time the project keeps, in that environment: "first seen" tells a new error from an old one.

One group's page adds the occurrences per day, where they happen (page, browser, OS, release, the top 5 each), its latest 20 occurrences, and the latest one's stack, raw.

```text
GET   /api/projects/:id/errors?period=7d&environment=production&status=unresolved|resolved|all
GET   /api/projects/:id/errors/:fingerprint?period=7d&environment=production
PATCH /api/projects/:id/errors/:fingerprint   { "status": "resolved" | "unresolved" }
```

The list reads at most 1,000 groups, the most recently seen, and says when there were more (`truncated`). Like every project route, these run the organization access check first; the PATCH also needs the dashboard's origin.

## 5. Not done yet

- Source maps: original file names, function names, and lines in stacks, and grouping by them.
- Back-end errors: exceptions recorded on traces join this list in stage 3. Until then, a server can report its own errors as [server-side events](web-analytics.md#server-side-events), without grouping.
- Alerts on a new or regressed group, or a spike (stage 4).
- Ignoring a group, merging two, searching messages, and "resolved in the next release".
- The visit around an error: for a known user, their activity shows it; for an anonymous visitor there is no timeline page yet.
- Errors from resources (images, scripts that fail to load) and from before the tracker runs.
