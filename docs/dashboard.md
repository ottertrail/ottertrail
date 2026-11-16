# Dashboard

How the dashboard works, and the decisions behind it. It is built in parts, as step 8 of [web analytics](web-analytics.md):

| Part                 | Status      |
| -------------------- | ----------- |
| 8.1 Signing in       | Done        |
| 8.2 Projects         | Done        |
| 8.3 Report endpoints | Done        |
| 8.4 Analytics page   | Not started |

## 8.1 Signing in

Code: `apps/api/src/auth/` and `apps/web/src/features/auth/`.

### Who can sign in

An instance belongs to one customer. Its first account is the **owner**; teammates will join by invitation, with roles (not built yet). Nobody can sign up: an instance with open sign-up would let anyone create an account and read its data.

### Creating the owner

There is no default password. Whoever runs the instance creates the owner:

```sh
vp run setup
```

The command prints a link such as `https://analytics.example.com/setup#token=…`. Opening it shows a form for the owner's name, email, and password. The link:

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

A project is one website or app. The Projects page lists them with their allowed sites and when their last event happened; a project's page shows its install snippet, whether events are arriving, and its settings.

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

### Not done yet

- Deleting a project, and replacing its public key. Deleting removes all of a project's events, so it needs a confirmation step.
- Permissions: any signed-in user can manage projects, which is only the owner until invitations exist.

## 8.3 Report endpoints

Code: `apps/api/src/reports/analytics.ts` and `apps/api/src/reports/routes.ts`.

```text
GET /api/projects/:id/analytics?from=2026-11-01&to=2026-11-16[&limit=10]
GET /api/projects/:id/analytics?period=7d[&limit=10]
```

A `period` (`today`, `7d`, `30d`, `90d`, or `12m`) ends today, and the API works out "today" in the instance's timezone: the browser showing the dashboard may be in another one. `7d` is today and the six days before it; `12m` starts the day after the same date last year.

One request returns every report of the analytics page, for whole days in the instance's `TIMEZONE`, `from` and `to` included: the summary, visitors per day, top pages, ten breakdowns (sources, campaigns, entry and exit pages, countries, regions, cities, devices, browsers, operating systems), and custom events. It needs a signed-in user. A range covers at most 366 days, and lists hold at most `limit` rows (default 10, at most 100).

### Visits worked out once

Most reports count visits, and working out visits is the expensive part: it sorts every event in the range (section 7 of [web analytics](web-analytics.md)). Run separately, each report did that again. The endpoint works the visits out once, into a temporary table that disappears when the request's transaction ends, and every report reads that table. On fake data (`vp run bench:reports`, Apple M4 Max), the whole page:

| Visits per day | Range   | Each report separately | Visits once |
| -------------- | ------- | ---------------------- | ----------- |
| 1,000          | 1 day   | 168 ms                 | 54 ms       |
| 1,000          | 30 days | 2,393 ms               | 1,039 ms    |
| about 7,000    | 1 day   | 1,151 ms               | 295 ms      |
| about 7,000    | 30 days | 16,710 ms              | 5,254 ms    |

The transaction also uses PostgreSQL's REPEATABLE READ isolation: every report sees the same snapshot of the data, so the numbers on the page agree with each other even while new events arrive. Run as separate requests, a pageview stored between two of them could appear in one card and not the next.

The individual report functions (`summary`, `breakdown`, …) still work on their own, as `vp run report` uses them; a test checks that both ways give the same numbers.

### Not done yet

- Comparison with the previous period, and filters (only visits from Google, only one page).
- Caching. Each request works the reports out again; at the volumes measured above, that takes about a second for a month at 1,000 visits a day.
