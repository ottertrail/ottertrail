# Dashboard

How the dashboard works, and the decisions behind it. It is built in parts, as step 8 of [web analytics](web-analytics.md):

| Part                 | Status      |
| -------------------- | ----------- |
| 8.1 Signing in       | Done        |
| 8.2 Projects         | Not started |
| 8.3 Report endpoints | Not started |
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
