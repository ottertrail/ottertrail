# Dashboard

How the dashboard works, and the decisions behind it. It is built in parts, as step 8 of [web analytics](web-analytics.md), and then [organizations](#organizations):

| Part                 | Status |
| -------------------- | ------ |
| 8.1 Signing in       | Done   |
| 8.2 Projects         | Done   |
| 8.3 Report endpoints | Done   |
| 8.4 Analytics page   | Done   |

## 8.1 Signing in

Code: `apps/api/src/auth/` and `apps/web/src/features/auth/`.

### Who can sign in

The install's first account is its **owner**, created with the first organization ([Organizations](#organizations)). Teammates will join an organization by invitation, with roles (not built yet). Nobody can sign up yet: open sign-up, for the hosted service, needs Ottertrail's own account email for verification and password resets.

### Creating the owner

There is no default password. Whoever runs the install creates the owner:

```sh
vp run setup
```

The command prints a link such as `https://analytics.example.com/setup#token=…`. Opening it shows a form for the owner's name, email, password, and organization, which is created with the account. The link:

- works once, and for one hour; running the command again replaces it;
- stops working for good once an owner exists, and the command then refuses;
- carries its token after `#`, in the fragment. Browsers never send the fragment to a server, so the token cannot end up in request logs or proxy logs. The page reads it, then removes it from the address bar.

The database stores only a SHA-256 hash of the token, so reading the database does not reveal a working link. Using the link, checking that no owner exists, and creating the account happen in one transaction, and a unique index allows at most one owner, so two people opening the same link at once cannot both become owners.

A setup page that let the first visitor become the owner would hand a freshly deployed instance to whoever found it first.

The setup endpoint is public, so it does the cheap work first. It refuses a request when an owner already exists or the link is invalid, which costs one database query, before it hashes the password, which costs about 40 ms and 32 MB on purpose. Attempts are also limited per client address: 10, then one a minute. Without that order, anyone could send made-up links and keep the API busy hashing.

The owner's email must pass the check sign-in uses (Better Auth checks addresses with zod's `z.email()`), which is stricter than the usual email format: `ops!alerts@example.com` is refused. Otherwise setup could create an owner who can never sign in, and setup cannot run again once an owner exists. A code review found both of these problems.

### Sessions

Signing in creates a **session**: a random token stored in the `dashboard_sessions` table and sent to the browser in a cookie. Each request carries the cookie; the API looks the token up to know who is asking.

- The cookie is `httpOnly` (page scripts cannot read it, so an injected script cannot steal it), `SameSite=Lax` (another site's background requests and form posts do not carry it; following a link to the dashboard does), and `Secure` over HTTPS.
- A session lasts 7 days and renews while in use. Signing out deletes the session, so its cookie stops working at once, even if it was copied. A signed token that the server does not store (a JWT) could not be revoked before it expires.
- Session rows keep the browser's User-Agent but no IP address; a check constraint rejects one.
- Requests that change something must come from a trusted origin (the instance's own `PUBLIC_URL`), which blocks cross-site request forgery: a page on another site cannot sign someone in or out.

The session token is stored as it is in the database, so anyone who can read the database could act as a signed-in user. Database access must be protected like the dashboard itself.

### Passwords

Passwords are at least 12 characters and are stored as scrypt hashes. scrypt is slow on purpose and needs a lot of memory, so guessing passwords from a stolen hash costs time and hardware. Sign-in attempts are rate-limited per client address; the API passes the address it trusts (from `TRUST_PROXY`), so a client cannot dodge the limit by sending a fake `X-Forwarded-For` header.

### Built on Better Auth

[Better Auth](https://better-auth.com) handles passwords, sessions, cookies, origin checks, and rate limits. Ottertrail uses only its core (email and password, database sessions), with no plugins, and keeps the owner, setup, and later invitations and roles in its own code and tables. Most of Better Auth's security advisories in 2026 were in plugins this setup does not use. The version is pinned; an advisory that affects the core means a new Ottertrail release.

Settings that differ from Better Auth's defaults, and why:

| Setting                                   | Why                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Sign-up disabled                          | The owner comes from the setup link; teammates will come by invitation.                                |
| No IP address on sessions                 | Ottertrail keeps no IP addresses.                                                                      |
| Rate limits keyed on the API's own header | Better Auth reads `X-Forwarded-For` by default, which a client can forge.                              |
| Origin and CSRF checks always on          | Better Auth turns them off when `NODE_ENV` is `test` unless they are set; set, they cannot be skipped. |
| Telemetry off                             | Already off by default; set explicitly so it stays off.                                                |
| Table and column names                    | Ottertrail's snake_case `dashboard_*` tables instead of Better Auth's camelCase names.                 |

### Configuration

| Variable      | Development default     | In production                                                                   |
| ------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `PUBLIC_URL`  | `http://localhost:5173` | Required: the instance's HTTPS address, such as `https://analytics.example.com` |
| `AUTH_SECRET` | A fixed, public value   | Required: at least 32 random characters (`openssl rand -base64 32`)             |

`AUTH_SECRET` signs the session cookies. In development, the dashboard dev server may run on another port; any `http://localhost` port is trusted then.

### Not done yet

- Invitations and roles per module (planned with the access model).
- Password reset. It needs email, which is not set up yet. Until then, an owner who forgets their password cannot get back in without help from the database.
- Two-factor sign-in and passkeys.
- Serving the dashboard from the API in production. In development, the dashboard's dev server forwards `/api` to the API.

## 8.2 Projects

Code: `apps/api/src/projects/`, `apps/api/src/tracker-script/`, and `apps/web/src/features/projects/`.

A project is one website or app. The Projects page lists them with their allowed sites and when their last event happened. A project's Settings page (`/projects/<id>/settings`) shows its install snippet and public key to copy, whether events are arriving, a form for its name and allowed sites, its uploaded source maps, and its session replay setting; a new project opens there.

### The workspace and a project

The dashboard has two levels, the way hosting dashboards treat each site:

- **The organization** (the sidebar's first group, under its name): the project list (`/projects`), the design-system reference, and the organization's settings (`/settings`). Members will go there too.
- **Inside a project** (`/projects/<id>/…`): the sidebar becomes the project's own menu, with a switcher to the other projects and a link back to all of them. It lists the project's modules (web analytics, speed, product analytics, users, errors), then the project's settings. The header shows the project's name before the page title.

Every module belongs to one project (its records carry `project_id`), so a module's pages sit under the project instead of at the top with a project picker. The switcher keeps the current page: from one project's web analytics for the last 90 days, it opens the other project's web analytics for the last 90 days.

`/projects/<id>` opens the project's web analytics until projects have an overview page. The home page (`/`) opens the project this browser showed last (kept in `localStorage`), or else the first project; with no projects, it opens the project list.

### The install snippet

```html
<script
  defer
  src="https://analytics.example.com/t.js"
  data-key="pk_…"
  data-host="https://analytics.example.com"
></script>
```

- `src`: the instance serves the built tracker at `/t.js`, and the Web Vitals script it loads at `/v.js`. A short, neutral name, because ad-block lists often match file names such as `tracker.js` or `analytics.js`. Browsers may cache it for an hour, then check it again with its ETag, so a new tracker reaches sites within an hour. The API reads the file on each request, so a new build needs no restart; until the tracker is built (`vp run -r build`), `/t.js` and `/v.js` answer 503, and a missing one is logged once.
- `data-key`: the project's public key. It only lets pages on the allowed sites send events; it cannot read anything.
- `data-host`: where events go (`/api/events` on the same instance).
- `data-environment` and `data-release` (optional): where the site runs, such as `staging`, and which version of it ([web analytics](web-analytics.md#environments-and-releases)). The Install card explains both under the snippet; without them, events count as `production`.

The page shows "Waiting for the first event" and checks every 10 seconds, so after installing, opening the site in a browser turns it into "Receiving events".

### Allowed sites

Events are accepted only from pages whose hostname is listed, compared exactly (step 2 of [web analytics](web-analytics.md)). So the list holds bare hostnames: `example.com` and `www.example.com` are separate entries, and there are no wildcards. The API stores each one the way browsers send it in the `Origin` header: lowercase, with internationalized names in their ASCII form (`bücher.example` becomes `xn--bcher-kva.example`). The form accepts a pasted address and keeps only its hostname; the API refuses anything else and names the entry. A change reaches the collection endpoint within a minute, the lifetime of its project cache.

### Requests from the dashboard only

The session cookie is `SameSite=Lax`, which keeps it off other sites' form posts and background requests. Sites on a sibling subdomain of the same domain still count as the same site, though, so the API also checks the `Origin` header on every request that changes something: it must be the instance's own address (`PUBLIC_URL`; in development, any `localhost` port). Better Auth makes the same check for its own sign-in endpoints.

### Keeping events

The Settings form's "Ignore visits from data centers", on by default, makes collection ignore browser events from cloud and hosting providers' addresses, as bots ([web analytics](web-analytics.md#data-centers)); a project whose visitors use remote desktops in a cloud turns it off. It applies from the next event: the route makes the key cache forget the project.

The Settings form's "Keep events" sets how long the project keeps its events: forever (the default), 6 months, 1 year, 2 years, or 5 years ([web analytics](web-analytics.md#how-long-events-are-kept), section 1). Choosing a stricter limit than the current one says, before saving, that older events will be deleted for good within a few hours. The worker deletes them.

### Your server

The "Your server" card holds the project's secret key, hidden until "Show" and then copyable, with an example of a server-side event, and the switch "Only accept user IDs signed by your server", with an example of signing in Node.js ([web analytics](web-analytics.md#signed-user-ids)). The switch saves at once (`PATCH /api/projects/:id` with `requireSignedUserIds`), and collection uses the new rule from the next event: the route makes the key cache forget the project.

### Source maps

The "Source maps" card (`apps/web/src/features/projects/source-maps-card.tsx`, the routes in [errors](errors.md)) shows what the project has uploaded:

- On an install without an object store, it only says source maps are off there, and that the operator turns them on with `OBJECT_STORE_URL`.
- Otherwise: the organization's use against its limit ("14 MB of 1 GB used", all its projects together), then the releases with maps, by their latest upload, newest first or, with "Oldest first", oldest first (the ones to delete for room); at most 100, with a note saying how many there are in all when there are more: release, files, size, and when the last map was uploaded. Each row has a button that lists the release's files with their sizes in a dialog, and a Delete button. Deleting asks first, and says the maps go for good, the errors stay, and that release's stacks show minified code again; afterwards the row goes at once and focus moves to the card's heading (Cancel returns it to the button). Error pages are fetched again.
- Without maps, and behind "Show how to upload" once there are some: the upload command of the CLI (from this repository's `packages/sourcemaps`, which is not on npm yet), a `curl` example for one file, and the rules: one upload per release and minified file, `path` is the file's path as the browser loads it, the release must match `data-release`, and maps built without publishing them (Vite's `build.sourcemap: "hidden"`). The secret key appears only as a placeholder (`sk_…`, `$OTTERTRAIL_SECRET_KEY`) pointing at the "Your server" card; the card never prints the real key.

Sizes use powers of 1,024 with the short units KB, MB, and GB. `source-maps.test.tsx` covers the list, oldest first on request, the files dialog, deleting (the request, the list, focus), the install without an object store, and the empty state.

### Session replay

The "Session replay" card (`apps/web/src/features/projects/replays-card.tsx`; the design in [session replay](session-replay.md), the routes in `apps/api/src/replays/dashboard-routes.ts`) reads `GET /api/projects/:id/replays`:

- On an install without an object store, it only says replays are off there, and that the operator turns them on with `OBJECT_STORE_URL`.
- Otherwise, a choice of two radio buttons, "Off" (the default) and "Around errors", each with a line saying what it does. Choosing saves at once (`PATCH /api/projects/:id` with `replayMode`): while saving the choices are disabled and "Saving…" shows, then "Saved."; a failure shows the API's message and the saved choice again.
- "On your site": both switches are needed, this setting and `data-replay="errors"` on the tracker's script tag (shown to copy), which a site leaves off until a visitor agrees if it asks. Then the privacy defaults in plain words (the page's text, typed values, and images and media are masked in the visitor's browser, and what is masked never reaches Ottertrail) and the site's opt-ins, one line each: `data-replay-text="show"`, `data-replay-media="show"`, `data-ottertrail-mask`, `data-ottertrail-block`, and `data-ottertrail-unmask`.
- "Stored": the project's replays (how many, and their size) and the organization's use against its limit, all its projects together; replays are kept 30 days. With at least one replay, "Delete all replays" (`DELETE /api/projects/:id/replays`) asks first and says it cannot be undone and the errors stay; afterwards the count shows none at once, the button goes, and focus moves to the card's heading (Cancel returns it to the button). Error pages are fetched again.

`replays.test.tsx` covers each state of the card, the request a choice sends, a failed save, deleting (the confirmation, the request, focus), no delete without replays, and the install without an object store.

### Replacing the key, deleting the project

The Settings page ends with a "Danger zone" of two changes that cannot be undone, each behind a confirmation:

- **Replace the secret key** (`POST /api/projects/:id/secret-key`), for a secret key that ended up where it should not: servers with the old one are refused at once (a request already looking the key up may still pass), and user IDs signed with it no longer count.
- **Replace the public key** (`POST /api/projects/:id/public-key`), for a key that ended up where it should not. The project gets a new key and keeps its data; pages with the old snippet can no longer send events, so the new snippet has to go on the site right after. The Install card shows it at once.
- **Delete the project** (`DELETE /api/projects/:id`), with every event it has received: the worker deletes its events from ClickHouse within a minute, and usually from ClickHouse's disk within 6 hours ([clickhouse.md](clickhouse.md#retention-and-deleting-a-project)). The reports cannot be opened from the moment the project is gone. The request repeats the project's name (`{ "confirmName": "Main site" }`), and the dashboard asks for it to be typed, so a mistaken ID or a stray request cannot delete a project. Afterwards the dashboard opens the project list, and the home page stops opening the deleted project.

The collection endpoint keeps keys in a cache for a minute (a key is checked on every event). The project routes tell it to forget a replaced or deleted key, so the key stops working at once in that API process. A batch already on its way when its project is deleted, or a key cached in another API process, is still stored: ClickHouse cannot check that the project exists. The worker's purge deletes those events with the project, or, if they land after it, the orphan sweep does ([clickhouse.md](clickhouse.md#retention-and-deleting-a-project)).

### Not done yet

- Deleted events can stay in backups until those are deleted; there is no backup policy yet.
- Permissions: any signed-in user can manage projects, which is only the owner until invitations exist.

## 8.3 Report endpoints

Code: `apps/api/src/reports/analytics.ts` and `apps/api/src/reports/routes.ts`.

```text
GET /api/projects/:id/analytics?from=2026-11-01&to=2026-11-16[&limit=10]
GET /api/projects/:id/analytics?period=7d[&environment=staging][&limit=10][&country=DE&page=/pricing …]
```

A `period` (`today`, `7d`, `30d`, `90d`, or `12m`) ends today, and the API works out "today" in the timezone of the project's organization: the browser showing the dashboard may be in another one. `7d` is today and the six days before it; `12m` starts the day after the same date last year.

One request returns every report of the analytics page, for whole days in the timezone of the project's organization, `from` and `to` included: the summary, visitors per day, top pages, eleven breakdowns (sources, campaigns, entry and exit pages, countries, regions, cities, devices, browsers, operating systems, releases), and custom events. All of it counts one environment: `environment` names it, in any case, and is `production` when left out. The response says which (`environment`) and lists `environments`: those with events in the range, most events first, then the one shown and `production` even without any, so the page can always switch back. It needs a signed-in user. A range covers at most 366 days, and lists hold at most `limit` rows (default 10, at most 100).

The response also holds `previous`: the summary of the period before (`firstDay`, `lastDay`, and `until`, the cut-off when the period is still running, on `lastDay`), with the same filters (section 7 of [web analytics](web-analytics.md#comparison-with-the-previous-period)). It costs one more summary over the earlier days: on PostgreSQL's benchmark, the whole page went from 56 to 89 ms for 1 day and from 225 to 313 ms for 7 days at 1,000 visits a day.

Filters narrow every report to the matching visits (defined in section 7 of [web analytics](web-analytics.md#filters)): one parameter per filter, named after the breakdown (`source`, `country`, `deviceType` …) or `page`, at most 2,048 characters. An empty value means unknown. Several filters must all match. An unknown parameter is refused with 400: Fastify's validator would otherwise drop it silently, so a mistyped filter (`contry=DE`) would return unfiltered numbers.

### One list in full

```text
GET /api/projects/:id/analytics/list?report=country&period=7d[&search=germ&offset=0&limit=50][&filters …]
```

Behind "Show all": one list of the page (`pages`, `customEvents`, or one of the ten breakdowns), with the same days and filters, 50 rows at a time at most. The answer holds the rows and `hasMore`, which comes from reading one row more than asked for, so no separate count query is needed. The rows are the same as the page's, from the same report functions.

`search` keeps rows whose name contains the text, ignoring case, in the database, so a site with thousands of pages stays quick. `%` and `_` match themselves. Countries are stored as codes and shown as names, so for them the search finds codes whose English name contains the text (`germ` finds `DE`), from the same country names the dashboard shows.

### Visits worked out once

Most reports count visits, and working out visits is the expensive part: it sorts every event in the range (section 7 of [web analytics](web-analytics.md)). Run separately, each report did that again. The endpoint works the visits out once, into a temporary table of a ClickHouse session that belongs to the request, and every report reads that table. The session runs its queries one after another, and the endpoint drops the table when the reports are done (ClickHouse also drops it when the session expires).

On fake data in ClickHouse (`vp run bench:reports`: 200,000 visits in 30 days, the development stack on an Apple M4 Max), before the change described after the table, the whole page:

| Range   | Each report separately | Visits once | Filtered by a country | Filtered by a page |
| ------- | ---------------------- | ----------- | --------------------- | ------------------ |
| 1 day   | 372 ms                 | 263 ms      | 319 ms                | 394 ms             |
| 7 days  | 1,471 ms               | 1,275 ms    | 1,390 ms              | 1,630 ms           |
| 30 days | 4,952 ms               | 3,948 ms    | 3,880 ms              | 4,472 ms           |

The table of visits took most of that: 3.5 of the 3.9 seconds over 30 days. Each of its 12 columns from the visit's first event (source, campaign, browser, location …) was an aggregate of its own. One aggregate for all of them (`firstEventColumns: "together"` in `visits.ts`) made the table 1.3 seconds on the same data. The whole page with that change has not been measured: in later runs, ClickHouse in Podman's 2 GB machine ran out of memory before the end ([clickhouse.md](clickhouse.md#memory)). Reports that work out visits on their own keep one aggregate per column, because ClickHouse then skips the columns they do not read: a sources breakdown took 485 ms that way, 846 ms with one aggregate.

Before ClickHouse, in PostgreSQL, the same benchmark measured the whole page:

| Visits per day | Range   | Each report separately | Visits once |
| -------------- | ------- | ---------------------- | ----------- |
| 1,000          | 1 day   | 168 ms                 | 54 ms       |
| 1,000          | 30 days | 2,393 ms               | 1,039 ms    |
| about 7,000    | 1 day   | 1,151 ms               | 295 ms      |
| about 7,000    | 30 days | 16,710 ms              | 5,254 ms    |

With filters, the temporary table holds only the matching visits, so the reports after it have less to read. At 1,000 visits a day over 30 days, the whole page took 864 ms unfiltered, 539 ms filtered by a country, and 745 ms filtered by a page (which looks up the page's pageviews for each visit).

In PostgreSQL, the page's reports also shared one snapshot (REPEATABLE READ), so their numbers agreed with each other even while new events arrived. ClickHouse has no snapshot across queries: events stored while the page is worked out can reach some cards and not others.

The individual report functions (`summary`, `breakdown`, …) still work on their own, as `vp run report` uses them; a test checks that both ways give the same numbers.

### Not done yet

- Caching. Each request works the reports out again; at the volumes measured above, that takes about a second for a month at 1,000 visits a day.

## 8.4 Analytics page

Code: `apps/web/src/features/analytics/`.

`/projects/<id>/web-analytics?period=30d` shows one project for one period: `today`, `7d` (the default), `30d`, `90d`, or `12m`, as in 8.3. `?from=2026-10-01&to=2026-10-31` shows chosen days instead (a custom range). An unknown period, or days the API would refuse, fall back to the default.

From top to bottom, the page shows:

1. A picker for the period, with "Custom range…" for chosen days; a picker for the environment, once there is a choice (another environment has events in the range) and always while another than production is shown, so there is a way back; then the days covered and the organization's timezone. The days come from the API, so they are the organization's days, not the browser's. The environment goes in the address as `env=staging`, left out for production, and switching it keeps the period and filters.
2. Seven numbers: visitors, visits, pageviews, views per visit, bounce rate, visit duration, and time engaged (defined in section 7 of [web analytics](web-analytics.md#the-numbers)). Under each, its change from the period before: an arrow and a size ("12%", or "6 pts" for the bounce rate), read out as a sentence ("Up 12% from 683"). The arrows stay in text colors: status colors are reserved for state, and up is not always better (a bounce rate). A note names the days compared and, for a running period, the time of day the comparison stops; it also says that a visitor is recognized for one day only, so the same person on two days counts twice.
3. Visitors, visits, or pageviews per day, as a line. Hovering over the chart shows all three numbers for the nearest day. "Show the numbers" opens the same data as a table. A one-day period draws no line, since one point shows no trend.
4. Ranked lists, most visitors first, each with a bar for its visitors: pages (top, entry, and exit), sources and campaigns, countries, regions, and cities, devices, browsers, and operating systems, releases, and custom events. While no visit names a release, the Releases card says how to name one instead of listing every visit as "Unknown". An empty period in another environment than production names it, and suggests another environment. Each list shows its first 10 rows; when it shows all 10, "Show all" opens it in full. A missing value (no location, an unknown browser) shows as "Unknown", and a visit without a campaign as "No campaign".

A project without events shows how to install the snippet instead; a period without events offers the last 12 months.

### Custom range

"Custom range…" opens a dialog with the first and last day, starting from the days the page shows. A calendar picks them: a click on the first day, then on the last; once a range is complete, the next click starts a new one. It opens on the month the range ends in, weeks start on Monday, and today is underlined. The days can also be typed, day first as the dashboard writes them (`DD/MM/YYYY`): the fields take digits only and add the slashes themselves, and a typed day moves the calendar to its month. A half-typed day is not an error until it is complete or left. The days are checked as the API checks them (real days, the last not before the first, at most 366) before they can be shown.

The calendar is shadcn's `Calendar`, built on react-day-picker, with its parts moved out of its render function (they were made anew on every render). The browser's own date fields came first, but their pop-up calendar ignores the dashboard's look. The slashes come from a small function of ours (`maskDay` in `day-text.ts`) rather than a mask library: the one tried, `@react-input/mask`, refuses a keystroke that arrives before its timer has read the cursor, so digits typed very fast were lost. `maskDay` works within the input event itself, keeps the cursor after the same digits, and is unit-tested; Backspace right after a slash deletes the digit before it, and Delete right before one the digit after it. The dialog's code, the calendar included, loads when "Custom range…" is first chosen: about 23 KB gzipped that every other visit to the dashboard would download for nothing. Chosen days keep the filters, a preset period replaces them, and the project switcher and "Show all" keep them. The comparison with the previous period works for them too: as many days right before.

### Show all

"Show all" opens a list in a dialog, with the page's period and filters: 50 rows at first, then "Load more", and a search by name, sent once typing pauses (a quarter of a second). While a new search loads, the last results stay, dimmed. A row's link filters the page by it and closes the dialog. The search box has the focus when the dialog opens, and Escape closes it.

### Filters

Every row of a list is a link that filters the page to its visits: a source, a country, "Unknown", a page from Top pages, and so on (custom events are not filters yet). Active filters show under the period picker, each with a button to remove it, and "Clear filters" removes them all. They live in the address (`?country=DE&page=/pricing`), so a filtered view can be linked, reloaded, and left with Back. A new period keeps the filters; switching to another project keeps the period but drops them, since a page or campaign belongs to one project. When nothing matches, the page says so and offers to clear them.

The router reads an address value as JSON only when it is written exactly as JSON writes it, so a hand-written value such as `2024.10` or `1e3` stays as typed, and the page turns the numbers it does read (`2024`) back into text. Links the app builds quote such values (`city=%222024%22`), so they read back the same. The page ignores a value it cannot use (an object, a NUL character, over 2,048 characters) rather than sending it.

### Charts without a chart library

The page needs one single-series line and one kind of bar, so both are drawn directly in SVG and HTML (`day-chart.tsx` and `ranked-list.tsx`) instead of adding a chart library. A library becomes worth adding when reports need more kinds of chart, such as funnels or retention tables.

They follow the chart rules in [the design system](design-system.md#charts): one hue (`chart-1`), no legend for a single series (the card title names it), thin gridlines, and numbers in text colors, never in the series color.

### Keyboard and screen readers

- The chart holds a visually hidden range input with one step per day. Tab moves focus to it; the arrow keys, Home, and End move between days; screen readers read each day with all three numbers, as the hover box shows them.
- The ranked lists are tables with column headers. The bars are hidden from screen readers, because the numbers beside them are text.

### Refreshing

The page loads its data again every minute while it is open. When the period changes, the previous numbers stay on screen, dimmed, until the new ones arrive. If a load fails, the last numbers stay, with the error and a Retry button.

### Tests

The browser tests in `apps/web/tests/browser/` render the whole dashboard in headless Chromium (Vitest browser mode with Playwright), at an address such as `/projects/<id>/web-analytics?period=7d`, so each test goes through the same routes, redirects, and layout as a person would. A fake API answers its requests (`tests/browser/fake-api.ts`); the API's own tests run against PostgreSQL, and the page checks the fake answers with the same shape checks as real ones.

`analytics-page.test.tsx` covers the numbers, days, and lists from a response; each number's change from the period before, and the note naming it; changing the period; the dimmed previous numbers while a period loads; an unknown period in the address; the chart's metric tabs, keyboard readout, hover readout, and table; a single day; and a project without events, an empty period, a missing project, and a failed load with Retry.

`navigation.test.tsx` covers the two levels: the workspace menu; a project's menu, with planned modules disabled and labeled; the header's project name; Settings; a new project opening on its snippet; the switcher keeping the page and the period; the way back to all projects; an unknown project; and the home page (first project, last project, no projects, signed out).

`filters.test.tsx` covers adding a filter from a row, a page, and an Unknown row; combining, removing, and clearing filters; a new period keeping them; values the address bar turns into numbers or cannot use; and a filtered view with no matching visits. The filter definitions themselves are tested against ClickHouse in `apps/api/tests/analytics.test.ts`.

`project-settings.test.tsx` covers the snippet and public key as copyable code, "Keep events" (forever by default, the warning before a stricter limit, a limit set through the API), and the danger zone: replacing the key (and Cancel), deleting only after the name is typed, the project list and home page afterwards, and a refused delete. The API's side, including keys that stop working at once and a batch for a project deleted meanwhile, is tested in `apps/api/tests/projects.test.ts`.

`custom-range.test.tsx` covers reading chosen days from the address, choosing them in the dialog (which starts from the page's days and keeps the filters), refusing days the API would refuse, Cancel, a preset period replacing them, unusable days in the address, and "Show all" and the project switcher keeping them.

`show-all.test.tsx` covers when "Show all" is offered, loading a list 50 rows at a time to its end, the search, a row filtering the page and closing the dialog, the page's period and filters, and Escape. The list endpoint's paging, search (including `%`, `_`, and countries by name), filters, and limits are tested against PostgreSQL.

Any test fails when the page logs an error to the console.

Putting back six bugs, in two batches of three, made exactly the tests that guard them fail: an unknown period reaching the API, a chart that ignores the arrow keys, no dimming while a period loads, a switcher that drops the period, a switcher that always opens web analytics, and a home page that forgets the last project. Writing the tests found a fourth: buttons that act as links were announced as buttons by screen readers. They are now real links styled as buttons (`ButtonLink`, see [the design system](design-system.md#components)).

Unit tests in `apps/web/tests/analytics.test.ts` cover the number and date formats and the check of the API's response.

### Not done yet

- Hourly detail for one day.
- Comparison in the chart and the lists; only the summary is compared.

### Goals

Code: `apps/web/src/features/analytics/goals-card.tsx`. A card after Custom events lists the project's saved goals ([product analytics](product-analytics.md#goals)) in the order added: each one's name, what reaches it in plain words ("Viewed /pricing", "signup where plan = team"), the visitors who reached it, its conversion rate (those visitors as a share of the page's visitors, one decimal below 10%, whole from there, with a bar from 0 to 100%), and how many times it happened. The numbers follow the page's period, environment, and filters.

"Add goal" opens a dialog: a name, and one step, an event (the page's custom events suggested) with an optional property filter, or a page path, with the funnel editor's own fields and checks (`features/product/step-fields.tsx`). A refusal of the API, a name taken or the 20 goals reached, shows in the dialog; the dialog says event goals count browser events only. Deleting asks first, and says only the definition goes. Without goals, the card says what they are for; at 20, "Add goal" is disabled, with the reason. `goals.test.tsx` covers the card, adding both kinds, the checks, a refusal, deleting, the empty state, and the limit, against the fake API.

The card shows only when the period has data, as the page's other cards do: on an empty period the page shows its own empty state, so goals are managed from a period with events. A goal cannot be renamed or changed: delete it and add it again, which loses nothing.

## 8.5 Users

Code: `apps/web/src/features/users/`, `apps/api/src/identities/`. The users a site names ([web analytics, Known users](web-analytics.md#known-users)), in one environment, production unless `env=` names another; the picker appears once another environment has known users.

- `/projects/<id>/users`: the known users, most recently seen first, 50 at a time with "Load more": user ID, last seen (relative, the exact time on hover), first seen, and events. A search by ID, case ignored. While the site names no user, the page shows how: `data-user-id` and `identify()`, with an example to copy.
- `/projects/<id>/users/<user ID>`: when the user was first and last seen, their event count, and their pageviews, custom events, and errors, newest first, under a heading for each day in the organization's timezone, 100 at a time. Each event shows its time, its page or name and properties, and browser, OS, place, and release.

```text
GET /api/projects/:id/users[?environment=staging&search=…&offset=0&limit=50]
GET /api/projects/:id/users/:userId[?environment=staging&before=…&beforeId=…&limit=100]
```

Both run `requireProjectAccess`, as every project route ([Organizations](#organizations)); a test checks another organization's members get 404. The list's answer names the organization's timezone and the environments with known users. A user's answer pages back with `before` and `beforeId`, the time and ID of the last event of the page before, so events arriving meanwhile cannot shift the pages. An ID without events in the environment answers 404. Both are worked out from the events in ClickHouse when asked. A bloom filter index on `user_id` lets a user's page skip blocks of a project's events that do not hold the ID; parts written before ClickHouse migration 0004 get the index when they are next merged. The list reads the project's whole history in the environment on every request, and its environments only for the first page.

### Not done yet

- Deleting one user's events, for a person who asks to be forgotten. Today their events go with the project or past its retention.
- Details about a user beyond the ID, such as a name or a plan, sent with `identify()`.
- A user's visits.
- A table of users kept up to date by the worker, for large projects: the list reads every identified event of the environment on each request.
- Paging the list by a cursor: it pages by offset over "most recently seen", so a user seen again between two pages moves up; the page shows them once.

## 8.6 Errors

Code: `apps/web/src/features/errors/`, `apps/api/src/errors/`. The error groups the tracker reports ([errors](errors.md)), in one environment and a range of days, with the same period choices and addresses as the analytics page (`period`, `from` and `to`, `env`).

- `/projects/<id>/errors`: the groups seen in the range, latest first, under three tabs: Unresolved (the default, regressions included), Resolved, and All (`status=` in the address). Each row: the type and message (the full message on hover), occurrences, users, and visitors in the range, last seen (relative, the exact time on hover), first seen, and a Regressed or Resolved badge, with an icon and a label. A row opens its group. Without errors, the page explains automatic capture, `captureError()`, and `data-errors="off"`, with an example to copy. A note says when the list stops at 1,000 groups.
- `/projects/<id>/errors/<fingerprint>`: one group. Its type and full message, its status with Resolve or Reopen (who resolved it and when, or that it regressed after), occurrences, users, and visitors in the range, first and last seen, occurrences per day (the analytics page's line chart, with "Show the numbers"), where it happens (pages, browsers, operating systems, releases), the latest occurrence's stack trace (below), and the latest 20 occurrences: time, user (a link to their page) or Anonymous, page, browser, OS, release, "Caught" for `captureError()`, and its replay (below). A group without occurrences in the range says so, with links to all errors and to the last 12 months.
- On a user's page, an error shows its type and message, linking to its group with the shortest period that includes it.
- A server's exception: a Server card with the latest occurrence's service, trace ID, and span ID, and the occurrences' Service and Trace columns. Each trace ID is a link, named "Open trace <ID>", to the trace's page with `at` (the occurrence's time) and `span` (its span) in the address, so the trace opens on the span the exception happened in ([traces and logs](#89-traces-and-logs)).

### The stack trace

The group's page shows the latest occurrence's stack, mapped with its release's source maps where the API could (`frames` and `sourceMaps` in the answer; [errors](errors.md)). Code: `apps/web/src/features/errors/stack-card.tsx`.

- When at least one frame is mapped, the frames are listed top first. A mapped frame shows its original file, line, and column (not the map's name at that position, which is often not the enclosing function's), the original source around the line when the map holds it (numbered, scrolling sideways instead of wrapping; the frame's line has a ▶ marker, a background, and words for screen readers), and the minified location in small text. Unmapped frames show their minified location; three or more in a row, usually a library's, fold behind "Show N more frames, without a source map". "Show the stack as the browser reported it" opens the raw text.
- When no frame is mapped, the raw stack shows as before.
- One note above says how the stack was mapped, or why not: mapped with release X's maps; the occurrence has no release (set with `data-release` on the tracker's tag); no frame is in a file a map could be for (a script written into the page, the browser's own code); no maps of release X cover the stack's files, or the release's maps for them cover none of the frames and may be another build's (both listing the files, with a link to the project's Source maps settings); source maps are off on this install (no object store, `OBJECT_STORE_URL`); or the maps could not be read just now.
- Without a stack, the card says the browser gave none, and nothing about source maps.

### An occurrence's replay

The latest occurrences have a Replay column (`apps/web/src/features/errors/occurrence-replay.tsx`), from each occurrence's `replay` in the API's answer:

- **Ready:** a "Play replay" button, named with the occurrence's time for screen readers ("Play replay of the error at 16 Nov 2026, 16:00"). It opens a dialog that takes most of the screen, with the error's time, timezone, and page, around a frame of the player page (`/api/projects/:id/replays/:replayId/player?errorAt=<ms>`, titled "Session replay around the error at …", `referrerpolicy="no-referrer"`). The frame has no `sandbox` or `allow` attribute: the player has to run its own script and read the replay as the signed-in user, and the API serves its page with a Content Security Policy of its own ([session replay](session-replay.md#playback)). Closing the dialog returns focus to the button.
- **Pending:** "Arriving…" in muted text; on hover, and for screen readers, "The page sends its replay about 10 seconds after the error."
- **Missing, or none:** a dash, read as "No replay".

The player itself is `packages/replay-player`, plain DOM and TypeScript around rrweb's `Replayer` (`@rrweb/replay`), built into one script (`dist/player.js`) that the API serves at `/replay-player.js`. It fetches the recording, checks its shape (version 1, rrweb events, a viewport size, a full snapshot), and fits the recorded viewport into the frame, keeping its shape. Its controls: Play or Pause (also Space, unless focus is on a control that uses it), a timeline (the arrow keys move 5 seconds; its spoken value reads "0:12 of 1:05") with the error marked on it, the elapsed and total time, "Jump to the error", speeds of 1×, 2×, and 4×, and "Skip inactivity" (on by default). It starts a minute before the error at most. A line says what was masked never reached Ottertrail. A replay that is gone says "This replay is not available: it may have expired."; other failures say to try again. rrweb builds the recorded page in a frame sandboxed with `allow-same-origin` only, never `allow-scripts` (rrweb 2.2.2's `createSandboxedIframe`; `UNSAFE_replayCanvas` is never set). The package's browser test plays a recording with a `<script>` and `onerror`, `onclick`, and `onload` handlers and checks that none of them runs.

`replays.test.tsx` covers the column's three states and the dialog with its frame.

The API is in [errors](errors.md#4-status-and-counts). Resolve and Reopen refresh the list and the group. A group the range does not include answers 404 with `no_occurrences`, distinct from the `not_found` of a project the user cannot reach. `errors.test.tsx` covers the list, tabs, environments, empty states, the group's page, Resolve, and both 404s, against the fake API. `source-maps.test.tsx` covers the stack card: mapped frames with their source and marked line, the folded frames, the raw stack, each note, and no stack.

### Not done yet

- Counts per tab: the Unresolved tab cannot tell "no errors" from "all resolved".
- The status filter applies to the 1,000 most recently seen groups of the range: a shorter range shows older ones.
- The group's page lists environments only through the one in its address.
- The replay player shows no list of the visitor's clicks and pages beside the recording yet, which the design plans ([session replay](session-replay.md#playback)).

## 8.7 Speed

Code: `apps/web/src/features/speed/`, `apps/api/src/speed/`. How fast page loads felt: the [Web Vitals](web-analytics.md#web-vitals) the tracker measures, in one environment and a range of days, with the analytics page's period choices, and a device choice (All devices, Desktop, Mobile, Tablet; `device=` in the address).

- Three cards for the Core Web Vitals, LCP, INP, and CLS: the 75th percentile (p75) with its rating, Good, Needs improvement, or Poor (a badge with an icon and a label, never color alone), a one-line explanation, a bar of the shares of good, so-so, and poor page loads with each share written out, and how many page loads were measured (INP only counts loads with an interaction). A note says what p75 means, for which days and timezone, and that the thresholds are Google's.
- FCP and TTFB, which lead up to LCP, the same way but smaller.
- LCP's p75 per day (the analytics page's line chart, with gaps for days without loads, and "Show the numbers" for a table of every day).
- By device, and the 20 pages with the most measured loads: loads and the p75 of LCP, INP, and CLS, each with a rating icon.
- Without page loads, the page explains `v.js`, when values are sent, what single-page apps and `integrity` pins miss, and `data-vitals="off"`.

Values show as "180 ms" below a second, "1.2 s" from one, and CLS with two decimals; ratings are of the value as shown, so "2.5 s" is never rated as over 2.5 seconds. Shares are rounded one by one, so a card's three can add up to 99% or 101%.

```text
GET /api/projects/:id/speed?period=7d&environment=production&device=mobile
```

It answers the thresholds with the report, so the page rates values as the API does. p75 is interpolated between the two nearest page loads (NumPy's default, Excel's `PERCENTILE.INC`): four loads of 1, 2, 3, and 4 seconds give 3.25 seconds; ClickHouse's `quantileExact` would give 4. `speed.test.tsx` covers the cards, ratings, shares, formatting, the device choice, the environment picker, both tables, the empty state, and a failed load, against the fake API; `apps/api/tests/speed.test.ts` the numbers.

### Not done yet

- A comparison with the period before, as the analytics page has.
- FCP and TTFB per device and page, and whether the 20 pages were all of them.
- Values of their own for in-app navigations of single-page apps (see [Web Vitals](web-analytics.md#web-vitals)).

## 8.8 Product analytics

Code: `apps/web/src/features/product/`, `apps/api/src/product/`. Three tabs, Events, Funnel, and Retention, each a page of its own that keeps the period and environment in the address; the sidebar opens Events. What each counts is defined in [product analytics](product-analytics.md#definitions), and each page says it in plain words under its report.

- **Events** (`/projects/<id>/product/events`): the product events, most frequent first, with events, visitors, and users. Without any, the page shows how to send them, `track()` in the browser or from the site's server, with an example to copy.
- **One event** (`/product/events/<name>`): its counts, events per day (the analytics page's chart, with "Show the numbers"), and each property's most frequent values as ranked lists. Choosing a value filters by it: in the address as `p.<property>=<value>`, so the view can be linked and survives a reload; active filters show as chips to remove, five at most. When nothing matches, it says so.
- **Funnel** (`/product/funnel`): a step editor, two to five steps, each an event (a name, typed or picked from the project's events, with an optional property filter) or a page (a path), added, removed, and moved up or down; fields are checked before any request. "Show funnel" puts the steps in the address, as the API's JSON. Count by visitors or users, and the window, apply at once; windows over a day are disabled for visitors, with the reason. The result: each step's count, its share of step 1 and of the step before, as bars with the numbers written out, and the overall conversion. Until two steps are set, the page offers an example from the project's own events.
- **Saved funnels** (on the Funnel page, above the steps; `saved-funnels-card.tsx`, `save-funnel-actions.tsx`, `lib/funnels-api.ts`): a table of the project's saved funnels by name, each with its steps on one line ("/pricing → signup") and who it counts for how long ("Visitors, within 1 day"), and "n of 50 saved". A name is a link that shows the funnel in the page's period and environment: its steps, count, and window go in the address with `funnel=<id>` (kept only when it is a UUID), so a link still shows exactly what was viewed. The open one is marked with `aria-current`. Each row has Rename (a dialog; the definition stays) and Delete (a confirmation saying only the definition goes, the events stay); deleting the open one drops `funnel` from the address and keeps the steps shown. Saving acts on the funnel shown, not on an editor draft not yet shown, from the Steps card's header: with no saved funnel open, "Save funnel" asks for a name, saves, and opens it; with one open and unchanged, the header says "Saved as “name”."; with one open and changed (steps, count, or window), it says so, with "Save changes" (no dialog; a failure shows in an alert) and "Save as new funnel". A change names the version it was made from: when the funnel was changed elsewhere since, such as in another tab, the API refuses it, and the page says so and loads the saved version again, so neither change is lost without a word. The name dialog lists what is saved and says the period and environment are not. A name taken or the limit reached shows in the dialog; at 50, the save buttons are disabled, with the reason. Without saved funnels, the card says how to save one. Once a funnel is saved, focus goes to the Steps heading, as the button that saved it is gone; once one is deleted, to the "Saved funnels" heading. After a rename, or on Cancel, it goes back to the button that opened the dialog.
- **Retention** (`/product/retention`): a row per cohort, its week and users, then weeks 0, 1, 2 … as percentages of the cohort, shaded on the sequential scale ([design system](design-system.md)) with the number always written, and "x of y users" on hover. The current week, not over yet, is in italics with a footnote. Without signed-in users, the page explains `data-user-id` and `identify()`.

Loading, failure with Retry, an unknown project, and the dimmed previous report while a new one loads work as on the other pages. `product.test.tsx` covers the lists, filters in the address and the request, the funnel editor and the steps it sends, the results and their percentages, the retention table, the empty states, and a failed load, against the fake API; `funnels.test.tsx` the saved funnels: the list, opening one, saving the funnel shown, saving changes and saving as new, renaming, deleting (the open one too), the API's refusals, a change refused because the funnel changed in another tab, the limit, the empty state, and focus; `apps/api/tests/product-events.test.ts` and `product-reports.test.ts` the numbers.

### Not done yet

- Suggesting property names in the funnel editor: the API lists the 100 most frequent event names, not property names.
- Retention's period only picks which cohorts show; each cohort's weeks run to today. The page's notes say so.

## 8.9 Traces and logs

Code: `apps/web/src/features/telemetry/`, `apps/web/src/lib/traces-api.ts` and `logs-api.ts`, `apps/api/src/telemetry/dashboard-routes.ts`. What a project's servers send over OpenTelemetry ([telemetry](telemetry.md)), in the project's menu after Errors, with the analytics page's period choices and addresses (`period`, `from` and `to`, `env`). Times are in the organization's timezone, to the millisecond ("16 Nov 2026, 16:00:00.000"); durations in µs, ms, or s as their size needs ("850 µs", "12.4 ms", "1.25 s").

- **Traces** (`/projects/<id>/traces`): one row per root span, newest first: its name (a link to the trace), service, start, duration, the trace's span count, and Error or No errors (a badge with an icon and a label), whether any of its spans failed. Filters below the period: service (the environment's services in the range), "Name contains…" (applied on Enter, on leaving the field, or at once when emptied), a minimum duration (10 ms to 5 s), and "With errors only"; each in the address (`service`, `name`, `min`, `errors`). "Load older traces" adds the next hundred. A filter that matches nothing says so.
- **A trace** (`/projects/<id>/traces/<traceId>`, with `at` and `span` in the address when known): the root's name and the trace ID, then its start, duration, span count, and failed spans. The waterfall is a table: each span a row in tree order (under its parent, by start), indented a step a level, with its name (a button), service, an Error badge when it failed, its start from the trace's ("+5 ms"), its duration, and a bar placed by its start and sized by its duration on the trace's whole time. The bar repeats the numbers beside it and is hidden from screen readers; each name's button says its level ("Level 2: charge card") and when its parent was not received ("Top level, parent not received"), and says it is chosen with `aria-pressed`. Spans whose parent never arrived stand at the top level, after the roots that started before them. A chosen span (the root at first) shows below: service, kind, status and its message, start, duration, span ID, its parent (by name, or "not received"), release, environment, and scope; its attributes, events (each with its time from the span's start and its attributes), links (a link to each linked trace), and resource attributes, each as a table of keys and values, with counts of what was dropped. The span is read when chosen. Then the trace's log records, oldest first. Past 2,000 spans, a note says how many the page leaves out. A trace with nothing kept says so: traces are kept the retention's days, errors longer, so an error can name a trace that is gone; with `at`, it says which time it looked around. An address that is not a trace ID says so without asking the API.
- **Logs** (`/projects/<id>/logs`): log records, newest first, each a row with its time, severity (the sender's text, else its range's name; Warning, Error, and Fatal with the warning and critical badges), service, and the start of its body: the list's summary holds the first 1,000 characters, two lines of which show, with "…" when the body is longer. A row is a button that opens the record, read then from the API (a skeleton while it loads; a failure says so, with Retry): its whole body, time and observed time, service, release, environment, event name, scope, its trace (a link to the trace's page, on its span) and span, its attributes, and its resource attributes. On a trace's page a record's span is a button instead, "Show its span: <name>", which chooses the span and moves focus to its detail. Filters: words in the message (applied as the name filter is; a line says each word must be in the message, in any case, whole or in part), service, a minimum severity ("Info and above" …), and a trace ID (32 hexadecimal digits, checked before it is sent); in the address as `q`, `service`, `severity`, and `trace`. "Load older logs" adds the next fifty.
- **No telemetry yet:** while a project has sent no spans (or no log records) at all, the page shows how to send them instead of filters: the `OTEL_EXPORTER_OTLP_*` settings with this instance's address as the endpoint, to copy, the Authorization header with `sk_…` in place of the key, and a link to the project's settings, where the secret key is ("Your server"). The page never prints the key. Spans that do not match a period or environment say "No traces in this period", with the retention.

Loading, failure with Retry, an unknown project, and the dimmed previous list while a new one loads work as on the other pages, but for one thing: the telemetry pages (these, Metrics, Services, and Hosts) do not retry a request the API answered, a 503 included, which says ClickHouse or the organization's queries are busy; they say it failed and offer Retry. The API's routes and how they read ClickHouse are in [telemetry](telemetry.md#how-the-pages-read). `telemetry.test.tsx` covers the sidebar links, the lists, filters in the address and the request, paging, the waterfall's order and labels, a span's detail, a log record's detail read when opened (and its failure), a long body cut in its row, a record's span, a trace that is not kept, a bad trace ID, the empty states without the key, and the error page's trace link, against the fake API; `apps/api/tests/telemetry-dashboard.test.ts` the routes.

### Not done yet

- A trace's span count in the list counts its spans in the period, an hour either side; a longer trace's page shows them all.
- Zooming the waterfall into part of a trace, and collapsing a span's children.
- Searching logs for a phrase: each word is matched on its own (see [telemetry](telemetry.md#how-the-pages-read)).
- Filtering by an attribute.

## 8.10 Metrics and services

Code: `apps/web/src/features/telemetry/` (`metrics-page.tsx`, `metric-page.tsx`, `time-chart.tsx`, `services-page.tsx`), `apps/web/src/lib/metrics-api.ts` and `services-api.ts`. In the project's menu after Logs, with the same period, environment, and addresses. How the API works the numbers out is in [telemetry](telemetry.md#how-metrics-are-charted).

- **Metrics** (`/projects/<id>/metrics`): the metrics with points in the period, by name: name (a link to its chart), kind (Gauge, Counter, Up-down counter, Histogram), unit (an annotation such as `{request}` shown as "request"), up to 10 services and how many more, and when it was last seen. Past 1,000 metrics, a line says the list holds the first by name.
- **A metric** (`/projects/<id>/metrics/<name>?kind=counter`, with `split` and `stat` when chosen): its name, kind, and unit, then its charts over the period, in the buckets the API chose (5 minutes for a day, an hour for 7 days), each card saying what it draws: a gauge's average, minimum, and maximum ("Value"); an up-down counter's total, each series' last value added up ("Total"); a counter's rate ("Per second"); a histogram's median, 95th, and 99th percentile ("Percentiles") and its observations per second, as two charts, since they have different units. Values read in the metric's unit: durations as the other telemetry pages show them, bytes in KiB, MiB, and GiB, rates with "/s". "Split by" offers the metric's attribute keys: one line per value, and with it a "Measure" choice for a gauge (average, minimum, maximum) or a histogram (median, 95th or 99th percentile, the 95th first). A histogram whose points carry no bucket counts says so in place of its percentiles, and still charts its observations per second. Under the charts, how many series were read, and, when it applies, that values past eight were added up as "Other values", that the 1,000-series cap was reached, or that histogram series were left out of the percentiles (other bounds, or no bucket counts). An address without a kind says so without asking the API.
- **Services** (`/projects/<id>/services`): a card per service, busiest first, with its requests, the share that failed, its median and 95th-percentile duration, and a table of its routes, busiest first, with the same numbers. A route is a link to the Traces page filtered by the service and the route as part of the name. Past 100 routes, a line says how many there are.
- **No data yet:** a project that has sent no metric sees how to send them, and one that has sent no span sees how to send traces on the Services page, with the Traces page's settings to copy ([8.9](#89-traces-and-logs)). A period without any says so, with the retention.

The charts are drawn in SVG, as the analytics page's are ([charts](#charts-without-a-chart-library)), by one component for lines over time buckets (`time-chart.tsx`), following the [design system's chart rules](design-system.md#charts): one y-axis; lines 2px in the chart colors in slot order; a legend from two lines; a crosshair with every line's value at the bucket under the pointer, values first; gaps where no point arrived. A split's value takes the first free color when it first shows and keeps it while the page is open (`split-colors.ts`), so a value keeps its color when the ranking or the set of values changes with the period or measure; a new value takes a color no value has had, while one is left. Colors are found by each line's key, its value, never its label, so a value that reads like the page's own labels ("(not set)", "Other values") has a color of its own. "Other values" is the de-emphasis gray (`ink-tertiary`), so there are at most eight lines and no color is reused. Reloading the page starts the colors over. No palette was added. Each chart holds a hidden range input, as the analytics chart does, that moves between buckets and reads each with every line's value, and "Show the numbers" opens a table of every bucket with a value.

`metrics-services.test.tsx` covers the sidebar links and their order, the list, opening a metric with the period kept, a gauge's three lines, legend, and keyboard readout, a histogram's two charts and table, the split control and measure in the address and the request, the colors of split lines and "other", a value keeping its color when the values change, values named like the page's labels, a histogram without bucket counts, an up-down counter's total, the empty states without the key, an address without a kind, a failed load with Retry, the services' tables, and a route's link to its traces; `apps/api/tests/telemetry-metrics.test.ts` the routes and numbers.

### Not done yet

- Splitting by a resource attribute or by service, filtering a chart by an attribute, and charts of several metrics on one page.
- A chart's period from a selection on the chart (zoom).

## 8.11 Hosts

Code: `apps/web/src/features/telemetry/` (`hosts-page.tsx`, `host-page.tsx`, `send-host-metrics.tsx`, `chart-card.tsx`), `apps/web/src/lib/hosts-api.ts`. The servers an OpenTelemetry Collector reports on with its host metrics receiver, in the project's menu after Services, with the same period, environment, and addresses. What the API reads and how it works the values out is in [telemetry](telemetry.md#hosts).

- **Hosts** (`/projects/<id>/hosts`): a table of the hosts that sent host metrics in the period, by name: the host (a link to its page), when it was last seen (to the millisecond, in the organization's timezone) with a badge, Reporting or Stale (an icon and a word; a line under the table says stale means nothing arrived in the last 5 minutes), and its latest CPU busy, memory used, fullest filesystem with its mount point ("90% (/data)"; read-only filesystems, such as snap packages' images, which are always full, are left out), and 1-minute load average. For a period that ended before now, there is no badge: staleness says something only about now. A value the host sent nothing to work out from is a dash named "Not sent". Past 500 hosts, a line says the table holds the first by name.
- **A host** (`/projects/<id>/hosts/<host.name>`): the host's name, when it was last seen and whether it is stale (in words), then eight charts in cards, two to a row on wide screens: CPU busy (%), CPU time by state (%), memory used (%) and (bytes), filesystem used by mount point (%), network and disk I/O (bytes per second, by direction: Received and Sent, Read and Written), and the load averages (1, 5, and 15 minutes, as the host sends them). Each card says which metric it was worked out from, so a reader knows whether the utilization metrics or the default ones were used, and, when a metric had more series than a chart reads, that it read the 1,000 with the most points. A chart the host sent nothing for says which metric it needs. A host with nothing in the period says so, with the retention. Moving to another host shows a skeleton until its charts arrive, never the previous host's charts.
- **No hosts yet:** while a project has sent no host metrics from a named host, the page shows a Collector configuration to copy instead of the table: the host metrics receiver with its CPU, memory, filesystem, network, disk, and load scrapers, the utilization metrics on (so the shares are exact), and snap packages' images, loopback and container interfaces, and disk partitions and virtual devices left out (so nothing is full by design or counted twice); the resource detection processor for `host.name`, a batch processor, and the OTLP/HTTP exporter pointed at this instance with `Authorization: Bearer sk_…`, with a link to the project's settings, where the secret key is ([telemetry](telemetry.md#the-collector)). The page never prints the key. It names the components' older names too.

The charts are those of the Metrics page (`time-chart.tsx`, in a card from `chart-card.tsx` that both pages use), with the same rules ([8.10](#810-metrics-and-services)): one y-axis per chart, so bytes and percentages are separate charts; units in the titles; a legend from two lines; a crosshair, a keyboard readout, and "Show the numbers". Percentages always run from 0 to 100 on the axis, so a host at 5% does not look full. A state's, mount point's, or direction's color is kept while the page is open (`split-colors.ts`), per chart; past eight mount points the rest are "Other mount points" in gray.

`hosts.test.tsx` covers the sidebar link, the table and its values, stale and reporting in words, a value not sent, the Collector's configuration without the key, a period without hosts, a host's page opened with the period kept, its charts' titles, the 0 to 100 axis, legends, a chart with nothing sent, the keyboard readout, the table view, a stale host, no badge for a period that ended before now, another host's charts never shown while a host loads, a host with nothing in the period, and a failed load with Retry and no automatic retry of a 503, against the fake API; `navigation.test.tsx` the menu's order; `apps/api/tests/telemetry-hosts.test.ts` the routes and numbers.

### Not done yet

- Swap, paging, disk operations, per-CPU and per-interface charts, and processes: each can be charted on the Metrics page.
- Sorting the table by a value, and filtering hosts by name.

## Organizations

Code: `apps/api/src/organizations/` and `apps/web/src/features/organizations/`.

Each customer has an instance of their own ([CLAUDE.md](../CLAUDE.md)), which holds one organization; the code keeps organizations apart as if several shared an instance. An organization is one customer: it owns projects, and users belong to it through memberships, as its **owner** or a **member**. The owner of the whole install (`dashboard_users.role`, the account the setup link created) is a separate thing from an organization's owner (`memberships.role`).

### The one check

`requireProjectAccess` (`organizations/access.ts`) runs on every route under `/api/projects/:id`: settings, the key, deleting, the analytics page, and its lists. The signed-in user must be a member of the project's organization. Otherwise the answer is 404, word for word the answer for a project that does not exist, so the ID of another organization's project reveals nothing. The project list shows only the projects of the user's organizations, and a new project goes into the user's organization: a user in several must name one (`organizationId`), and a user in none cannot create one.

`apps/api/tests/organizations.test.ts` calls every one of those routes on another organization's project and checks each answer is the not-found one and the project is untouched. Removing the check from any route, or the membership from the project list, makes the tests fail; that was tried for each.

### Settings

`/settings` shows the organization's name and timezone. Only its owner can change them; members see them read-only. The timezone field suggests IANA names as you type. The API stores the name Node.js resolves it to (`US/Pacific` becomes `America/Los_Angeles`, and a few newer names come back as older ones: `Europe/Kyiv` as `Europe/Kiev`). It refuses fixed offsets such as `+08:00`, and names PostgreSQL does not know: Node.js and PostgreSQL carry separate timezone databases, and reports and retention use PostgreSQL's to work out where days start. (ClickHouse, which puts events on their days, knows every name Node.js does.) For the same reason the API refuses to start with a `TIMEZONE` PostgreSQL does not know, and retention skips an organization whose stored timezone PostgreSQL no longer knows instead of failing for every organization.

Reports count days in the organization's timezone, and visitor IDs change at its midnight ([web analytics](web-analytics.md#one-salt-per-timezone-and-day)). Changing it therefore moves where days start in every report, past days included, and counts visitors afresh from the change until midnight; the page says so before saving. New events use it at once in the API process that saved it, which forgets the organization's cached project keys, and in any other API process within a minute, the lifetime of its cache.

### Where organizations come from

- The setup link creates the install's owner and their organization together, in one transaction, in the deployment's `TIMEZONE`.
- Migration 0010 moved data from before organizations into one organization, named after the owner ("Ada's organization"), in the `TIMEZONE` the deployment had, so no day boundary or visitor ID moved. On an install that had projects but never ran setup, that organization has no members; the setup link's owner then takes it over, renamed as the form says.

### Not done yet

- Signing up for the hosted service, which creates the customer's instance and its owner (a control plane outside the app; not built).
- Invitations and roles per module.
- Switching between several organizations in the dashboard. A user belongs to one until invitations exist; the API already handles several.
- Deleting an organization and all of its data.
