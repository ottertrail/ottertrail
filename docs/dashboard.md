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

A project is one website or app. The Projects page lists them with their allowed sites and when their last event happened. A project's Settings page (`/projects/<id>/settings`) shows its install snippet and public key to copy, whether events are arriving, and a form for its name and allowed sites; a new project opens there.

### The workspace and a project

The dashboard has two levels, the way hosting dashboards treat each site:

- **The organization** (the sidebar's first group, under its name): the project list (`/projects`), the design-system reference, and the organization's settings (`/settings`). Members will go there too.
- **Inside a project** (`/projects/<id>/…`): the sidebar becomes the project's own menu, with a switcher to the other projects and a link back to all of them. It lists the project's modules (web analytics; product analytics, users, and errors marked as planned), then the project's settings. The header shows the project's name before the page title.

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

- `src`: the instance serves the built tracker at `/t.js`. A short, neutral name, because ad-block lists often match file names such as `tracker.js` or `analytics.js`. Browsers may cache it for an hour, then check it again with its ETag, so a new tracker reaches sites within an hour. The API reads the file on each request, so a new build needs no restart; until the tracker is built (`vp run -r build`), `/t.js` answers 503.
- `data-key`: the project's public key. It only lets pages on the allowed sites send events; it cannot read anything.
- `data-host`: where events go (`/api/events` on the same instance).

The page shows "Waiting for the first event" and checks every 10 seconds, so after installing, opening the site in a browser turns it into "Receiving events".

### Allowed sites

Events are accepted only from pages whose hostname is listed, compared exactly (step 2 of [web analytics](web-analytics.md)). So the list holds bare hostnames: `example.com` and `www.example.com` are separate entries, and there are no wildcards. The API stores each one the way browsers send it in the `Origin` header: lowercase, with internationalized names in their ASCII form (`bücher.example` becomes `xn--bcher-kva.example`). The form accepts a pasted address and keeps only its hostname; the API refuses anything else and names the entry. A change reaches the collection endpoint within a minute, the lifetime of its project cache.

### Requests from the dashboard only

The session cookie is `SameSite=Lax`, which keeps it off other sites' form posts and background requests. Sites on a sibling subdomain of the same domain still count as the same site, though, so the API also checks the `Origin` header on every request that changes something: it must be the instance's own address (`PUBLIC_URL`; in development, any `localhost` port). Better Auth makes the same check for its own sign-in endpoints.

### Keeping events

The Settings form's "Keep events" sets how long the project keeps its events: forever (the default), 6 months, 1 year, 2 years, or 5 years ([web analytics](web-analytics.md#how-long-events-are-kept), section 1). Choosing a stricter limit than the current one says, before saving, that older events will be deleted for good within a few hours. The worker deletes them.

### Replacing the key, deleting the project

The Settings page ends with a "Danger zone" of two changes that cannot be undone, each behind a confirmation:

- **Replace the public key** (`POST /api/projects/:id/public-key`), for a key that ended up where it should not. The project gets a new key and keeps its data; pages with the old snippet can no longer send events, so the new snippet has to go on the site right after. The Install card shows it at once.
- **Delete the project** (`DELETE /api/projects/:id`), with every event it has received: the database deletes the events with the project. The request repeats the project's name (`{ "confirmName": "Main site" }`), and the dashboard asks for it to be typed, so a mistaken ID or a stray request cannot delete a project. Afterwards the dashboard opens the project list, and the home page stops opening the deleted project.

The collection endpoint keeps keys in a cache for a minute (a key is checked on every event). The project routes tell it to forget a replaced or deleted key, so the key stops working at once in that API process. A batch already on its way when its project is deleted, or a key cached in another API process, fails to store because the project is gone; the endpoint answers that as an unknown key (403), which the tracker does not retry, instead of as an outage (503), which it would.

### Not done yet

- Deleting a project with many events runs as one database statement while the request waits. A large project should be deleted by a background job, once the worker exists.
- Deleted events can stay in backups until those expire; there is no backup policy yet.
- Permissions: any signed-in user can manage projects, which is only the owner until invitations exist.

## 8.3 Report endpoints

Code: `apps/api/src/reports/analytics.ts` and `apps/api/src/reports/routes.ts`.

```text
GET /api/projects/:id/analytics?from=2026-11-01&to=2026-11-16[&limit=10]
GET /api/projects/:id/analytics?period=7d[&limit=10][&country=DE&page=/pricing …]
```

A `period` (`today`, `7d`, `30d`, `90d`, or `12m`) ends today, and the API works out "today" in the timezone of the project's organization: the browser showing the dashboard may be in another one. `7d` is today and the six days before it; `12m` starts the day after the same date last year.

One request returns every report of the analytics page, for whole days in the timezone of the project's organization, `from` and `to` included: the summary, visitors per day, top pages, ten breakdowns (sources, campaigns, entry and exit pages, countries, regions, cities, devices, browsers, operating systems), and custom events. It needs a signed-in user. A range covers at most 366 days, and lists hold at most `limit` rows (default 10, at most 100).

The response also holds `previous`: the summary of the period before (`firstDay`, `lastDay`, and `until`, the cut-off when the period is still running, on `lastDay`), with the same filters (section 7 of [web analytics](web-analytics.md#comparison-with-the-previous-period)). It costs one more summary over the earlier days: on the benchmark, the whole page went from 56 to 89 ms for 1 day and from 225 to 313 ms for 7 days at 1,000 visits a day.

Filters narrow every report to the matching visits (defined in section 7 of [web analytics](web-analytics.md#filters)): one parameter per filter, named after the breakdown (`source`, `country`, `deviceType` …) or `page`, at most 2,048 characters. An empty value means unknown. Several filters must all match. An unknown parameter is refused with 400: Fastify's validator would otherwise drop it silently, so a mistyped filter (`contry=DE`) would return unfiltered numbers.

### One list in full

```text
GET /api/projects/:id/analytics/list?report=country&period=7d[&search=germ&offset=0&limit=50][&filters …]
```

Behind "Show all": one list of the page (`pages`, `customEvents`, or one of the ten breakdowns), with the same days and filters, 50 rows at a time at most. The answer holds the rows and `hasMore`, which comes from reading one row more than asked for, so no separate count query is needed. The rows are the same as the page's, from the same report functions.

`search` keeps rows whose name contains the text, ignoring case, in the database, so a site with thousands of pages stays quick. `%` and `_` match themselves. Countries are stored as codes and shown as names, so for them the search finds codes whose English name contains the text (`germ` finds `DE`), from the same country names the dashboard shows.

### Visits worked out once

Most reports count visits, and working out visits is the expensive part: it sorts every event in the range (section 7 of [web analytics](web-analytics.md)). Run separately, each report did that again. The endpoint works the visits out once, into a temporary table that disappears when the request's transaction ends, and every report reads that table. On fake data (`vp run bench:reports`, Apple M4 Max), the whole page:

| Visits per day | Range   | Each report separately | Visits once |
| -------------- | ------- | ---------------------- | ----------- |
| 1,000          | 1 day   | 168 ms                 | 54 ms       |
| 1,000          | 30 days | 2,393 ms               | 1,039 ms    |
| about 7,000    | 1 day   | 1,151 ms               | 295 ms      |
| about 7,000    | 30 days | 16,710 ms              | 5,254 ms    |

With filters, the temporary table holds only the matching visits, so the reports after it have less to read. At 1,000 visits a day over 30 days, the whole page took 864 ms unfiltered, 539 ms filtered by a country, and 745 ms filtered by a page (which looks up the page's pageviews for each visit).

The transaction also uses PostgreSQL's REPEATABLE READ isolation: every report sees the same snapshot of the data, so the numbers on the page agree with each other even while new events arrive. Run as separate requests, a pageview stored between two of them could appear in one card and not the next.

The individual report functions (`summary`, `breakdown`, …) still work on their own, as `vp run report` uses them; a test checks that both ways give the same numbers.

### Not done yet

- Caching. Each request works the reports out again; at the volumes measured above, that takes about a second for a month at 1,000 visits a day.

## 8.4 Analytics page

Code: `apps/web/src/features/analytics/`.

`/projects/<id>/web-analytics?period=30d` shows one project for one period: `today`, `7d` (the default), `30d`, `90d`, or `12m`, as in 8.3. `?from=2026-10-01&to=2026-10-31` shows chosen days instead (a custom range). An unknown period, or days the API would refuse, fall back to the default.

From top to bottom, the page shows:

1. A picker for the period, with "Custom range…" for chosen days, then the days covered and the organization's timezone. The days come from the API, so they are the organization's days, not the browser's.
2. Seven numbers: visitors, visits, pageviews, views per visit, bounce rate, visit duration, and time engaged (defined in section 7 of [web analytics](web-analytics.md#the-numbers)). Under each, its change from the period before: an arrow and a size ("12%", or "6 pts" for the bounce rate), read out as a sentence ("Up 12% from 683"). The arrows stay in text colors: status colors are reserved for state, and up is not always better (a bounce rate). A note names the days compared and, for a running period, the time of day the comparison stops; it also says that a visitor is recognized for one day only, so the same person on two days counts twice.
3. Visitors, visits, or pageviews per day, as a line. Hovering over the chart shows all three numbers for the nearest day. "Show the numbers" opens the same data as a table. A one-day period draws no line, since one point shows no trend.
4. Ranked lists, most visitors first, each with a bar for its visitors: pages (top, entry, and exit), sources and campaigns, countries, regions, and cities, devices, browsers, and operating systems, and custom events. Each list shows its first 10 rows; when it shows all 10, "Show all" opens it in full. A missing value (no location, an unknown browser) shows as "Unknown", and a visit without a campaign as "No campaign".

A project without events shows how to install the snippet instead; a period without events offers the last 12 months.

### Custom range

"Custom range…" opens a dialog with the first and last day, starting from the days the page shows. They are the browser's own date fields, which work from the keyboard and on phones, so no date-picker library is needed. The days are checked as the API checks them (real days, the last not before the first, at most 366) before they can be shown. Chosen days keep the filters, a preset period replaces them, and the project switcher and "Show all" keep them. The comparison with the previous period works for them too: as many days right before.

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

`filters.test.tsx` covers adding a filter from a row, a page, and an Unknown row; combining, removing, and clearing filters; a new period keeping them; values the address bar turns into numbers or cannot use; and a filtered view with no matching visits. The filter definitions themselves are tested against PostgreSQL in `apps/api/tests/analytics.test.ts`.

`project-settings.test.tsx` covers the snippet and public key as copyable code, "Keep events" (forever by default, the warning before a stricter limit, a limit set through the API), and the danger zone: replacing the key (and Cancel), deleting only after the name is typed, the project list and home page afterwards, and a refused delete. The API's side, including keys that stop working at once and a batch for a project deleted meanwhile, is tested in `apps/api/tests/projects.test.ts`.

`custom-range.test.tsx` covers reading chosen days from the address, choosing them in the dialog (which starts from the page's days and keeps the filters), refusing days the API would refuse, Cancel, a preset period replacing them, unusable days in the address, and "Show all" and the project switcher keeping them.

`show-all.test.tsx` covers when "Show all" is offered, loading a list 50 rows at a time to its end, the search, a row filtering the page and closing the dialog, the page's period and filters, and Escape. The list endpoint's paging, search (including `%`, `_`, and countries by name), filters, and limits are tested against PostgreSQL.

Any test fails when the page logs an error to the console.

Putting back six bugs, in two batches of three, made exactly the tests that guard them fail: an unknown period reaching the API, a chart that ignores the arrow keys, no dimming while a period loads, a switcher that drops the period, a switcher that always opens web analytics, and a home page that forgets the last project. Writing the tests found a fourth: buttons that act as links were announced as buttons by screen readers. They are now real links styled as buttons (`ButtonLink`, see [the design system](design-system.md#components)).

Unit tests in `apps/web/tests/analytics.test.ts` cover the number and date formats and the check of the API's response.

### Not done yet

- Hourly detail for one day.
- Comparison in the chart and the lists; only the summary is compared.

## Organizations

Code: `apps/api/src/organizations/` and `apps/web/src/features/organizations/`.

One deployment serves many customers ([CLAUDE.md](../CLAUDE.md)). An organization is one customer: it owns projects, and users belong to it through memberships, as its **owner** or a **member**. The owner of the whole install (`dashboard_users.role`, the account the setup link created) is a separate thing from an organization's owner (`memberships.role`).

### The one check

`requireProjectAccess` (`organizations/access.ts`) runs on every route under `/api/projects/:id`: settings, the key, deleting, the analytics page, and its lists. The signed-in user must be a member of the project's organization. Otherwise the answer is 404, word for word the answer for a project that does not exist, so the ID of another organization's project reveals nothing. The project list shows only the projects of the user's organizations, and a new project goes into the user's organization: a user in several must name one (`organizationId`), and a user in none cannot create one.

`apps/api/tests/organizations.test.ts` calls every one of those routes on another organization's project and checks each answer is the not-found one and the project is untouched. Removing the check from any route, or the membership from the project list, makes the tests fail; that was tried for each.

### Settings

`/settings` shows the organization's name and timezone. Only its owner can change them; members see them read-only. The timezone field suggests IANA names as you type. The API stores the name Node.js resolves it to (`US/Pacific` becomes `America/Los_Angeles`, and a few newer names come back as older ones: `Europe/Kyiv` as `Europe/Kiev`). It refuses fixed offsets such as `+08:00`, and names PostgreSQL does not know: Node.js and PostgreSQL carry separate timezone databases, and reports and retention use PostgreSQL's. For the same reason the API refuses to start with a `TIMEZONE` PostgreSQL does not know, and retention skips an organization whose stored timezone PostgreSQL no longer knows instead of failing for every organization.

Reports count days in the organization's timezone, and visitor IDs change at its midnight ([web analytics](web-analytics.md#one-salt-per-timezone-and-day)). Changing it therefore moves where days start in every report, past days included, and counts visitors afresh from the change until midnight; the page says so before saving. New events use it at once in the API process that saved it, which forgets the organization's cached project keys, and in any other API process within a minute, the lifetime of its cache.

### Where organizations come from

- The setup link creates the install's owner and their organization together, in one transaction, in the deployment's `TIMEZONE`.
- Migration 0010 moved data from before organizations into one organization, named after the owner ("Ada's organization"), in the `TIMEZONE` the deployment had, so no day boundary or visitor ID moved. On an install that had projects but never ran setup, that organization has no members; the setup link's owner then takes it over, renamed as the form says.

### Not done yet

- Open sign-up for the hosted service. It needs account email (verification, password resets).
- Invitations and roles per module.
- Switching between several organizations in the dashboard. A user belongs to one until invitations exist; the API already handles several.
- Deleting an organization and all of its data.
