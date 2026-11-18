# Uptime checks and alerts

**Status: stage 4 of the [roadmap](roadmap.md). Step 1, uptime checks, is built ([what was built](#step-1-uptime-checks-as-built)), and so is step 2, the channels alerts go to and their delivery ([what was built](#step-2-channels-and-delivery-as-built)); alert rules are designed and not built.**

Ottertrail checks that a customer's sites and APIs answer, from outside the servers they run on, and tells the team when something breaks: a check that fails, an error never seen before or come back after being resolved, a sudden rise in errors. Alerts go out by email and by a signed webhook. The choices below were made on 18 November 2026.

## Uptime checks

A check is an HTTP(S) request a dashboard user sets up for a project: a URL, `GET` or `HEAD`, how often (every 1, 2, 5, 10, 15, 30, or 60 minutes), a timeout (10 seconds by default, at most 30), the status codes that count as up (200 to 399 by default), and optionally a word the body must hold, or must not. Redirects are followed, at most 5.

- **Where checks run:** in the worker of the customer's own instance, from one location. That is outside the servers the customer's app runs on, unless they host it on the same machine. If the instance itself is down, its checks are too: the instance needs a monitor of its own outside it, a hosting task.
- **Down and up:** a check is down after it fails twice in a row (1 to 5, set per check), so one lost packet does not page anyone, and up again after one success. Each time down is an incident, with when it started and ended and the first failure's cause (timeout, refused connection, DNS, TLS, status code, missing word).
- **TLS:** each HTTPS check records when its certificate expires; an alert can warn a set number of days before (14 by default).
- **Scheduling:** checks live in PostgreSQL with the time each is next due. The worker takes due checks every few seconds (`FOR UPDATE SKIP LOCKED`, so two workers never run one check twice), spreads their start times so checks set up together do not all fire at once, and runs at most 20 at a time.
- **Results** go to ClickHouse (`check_results`: check, time, up or not, status code, response time, the cause of a failure), ordered by project, then check, then time, as metrics are ordered by name, since every query reads one check's results. They are kept 90 days. Incidents stay in PostgreSQL, with the check.
- **Uptime** over a period is the share of the period not inside an incident, so a check every 10 minutes and one every minute mean the same thing.

### Requests a check must not make

A check is a request the instance makes to an address a dashboard user types in, so it must not reach what is behind the instance: its own databases, the cloud's metadata service, or the private network. The URL must be `http` or `https`; its host is resolved first, and a check whose addresses include loopback, private, link-local, unique-local, shared (CGNAT), multicast, or unspecified ones is refused, at setup and on every run. The request then connects to the address that was checked, never resolving again (so DNS cannot answer differently in between), and every redirect is checked the same way. The body is read up to 1 MB for the word. A self-hosted install that must check its own private network can allow it with a setting; the hosted service does not. Webhook URLs follow the same rules.

## Alerts

A project's alert rules say what to watch and where to send it:

| Rule                 | Fires when                                                                                    | Resolves when                          |
| -------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| Check down           | A check (one, or any of the project's) goes down                                              | It is up again                         |
| Certificate expiring | A check's certificate expires within the set number of days                                   | It is renewed                          |
| New error            | An error group is seen for the first time, in the chosen environment                          | (once per group)                       |
| Regressed error      | An error group resolved in the dashboard occurs again                                         | (once each time)                       |
| Error spike          | Errors (all, or one group) in the last N minutes reach a threshold, in the chosen environment | They stay below it for the same window |

- **Evaluation:** check rules fire from the checker, as soon as a check changes state. Error rules are evaluated by the worker every minute, from the error list's own data in ClickHouse ([errors](errors.md)), for browser and server errors alike.
- **State:** each rule keeps, per check or error group, whether it is firing and since when, in PostgreSQL, so a restart sends nothing twice and misses nothing.
- **Noise:** a notification goes out when an alert fires and when it resolves. A rule sends at most 20 an hour; past that, one message says how many more were held back.

### Alerts on telemetry (step 4)

Added on 18 November 2026: the numbers a team watches on its servers, not only whether they answer.

| Rule           | Fires when                                                                                                                                                                                                           | Resolves when                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Route latency  | A service's route (or the whole service) has its p95 or p99 duration above a value over the last N minutes, with at least a set number of requests                                                                   | It stays below for the same window               |
| Route failures | A service's route (or the whole service) has its failed share above a value over the last N minutes, with at least a set number of requests                                                                          | It stays below for the same window               |
| Metric         | A metric, read as its chart reads it (a gauge's average, minimum, or maximum; a counter's rate; a histogram's percentile), for one host or attribute value or all, is above or below a value over the last N minutes | It is back on the right side for the same window |

- **Below too:** a value under a threshold can be what matters: response times that drop suddenly (an empty page answers fast), a queue that stops moving, requests that stop coming.
- **Evaluation:** by the worker every minute, from the same data and computations as the Services and Metrics pages, over windows of 5 to 60 minutes; each rule's query is bounded like the dashboard's, and the worker evaluates a few at a time, so rules cannot crowd out ingestion or the dashboard.
- **Not yet:** alerts on matching log lines, and on data that stops arriving.

## Where alerts go

Channels belong to the instance (its settings), so every project can use them; each rule picks one or more.

- **Email:** a list of addresses. Sent through the SMTP server the instance is set up with (`SMTP_URL`, `EMAIL_FROM`); without one, the dashboard says email is not set up on this instance. Plain, short messages: what happened, when, and a link to the check or error in the dashboard. Ottertrail sends no other email from alerts.
- **Webhook:** a JSON `POST` to a URL, for a team's own scripts or another service. Each request carries the time and a signature, an HMAC-SHA256 of the time and body with the channel's secret, so the receiver can check it came from Ottertrail and is not a replay. The body names the event (`check.down`, `check.up`, `certificate.expiring`, `error.new`, `error.regressed`, `error.spike`, `error.spike_resolved`), the project, what it is about, and the dashboard link. The format is documented and versioned.
- **Delivery:** every notification is recorded in PostgreSQL before it is sent, and sent by the worker: a webhook gets 10 seconds to answer 2xx, then is retried with growing waits, for up to an hour; email is retried likewise. The dashboard lists each channel's deliveries of the last 30 days, with their outcome, and can send a test.

## The dashboard

- **Uptime** (project nav): the project's checks, each with its state, uptime over the last 24 hours, 7 days, and 30 days, and its response time; add, edit, pause, and delete. A check's page: its response time over the period, its uptime, its incidents, and its latest failures with their causes.
- **Alerts** (project nav): the project's rules, with what each watches, its channels, whether it is firing now, and its recent alerts; add, edit, turn off.
- **Notification channels** (instance settings): email lists and webhooks, with a test send and their recent deliveries; a webhook's secret is shown to the instance's dashboard users.
- An error's page links to the rules that watch it.

## Limits

At most 50 checks per project. Requests: 30-second timeout at most, 5 redirects, 1 MB of body read. Rules: at most 50 per project, 20 notifications an hour each. A webhook's answer is read only for its status. Channels: at most 20 per instance, 60 deliveries an hour each, 5 test sends a minute each; deliveries are kept 30 days.

## Not in the first version

- Slack and Discord messages in their own formats (a webhook can reach a small relay meanwhile), SMS, and phone calls.
- Alerts on matching log lines, and on data that stops arriving.
- Checks from several locations, and checks other than HTTP (TCP, ping, DNS); heartbeat checks that a job reports to.
- Status pages, on-call schedules, escalation, and maintenance windows (a check can be paused).

## How it is built

| Step                                                                                                                              | Status  |
| --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. Uptime checks: storage, scheduling, the request and its address rules, incidents, the Uptime pages                             | Done    |
| 2. Channels and delivery: email over SMTP, signed webhooks, retries, delivery history and test sends                              | Done    |
| 3. Alert rules: check down and certificates from the checker, new, regressed, and spiking errors from the worker, the Alerts page | Planned |
| 4. Alerts on telemetry: route latency and failures, and metrics above or below a value                                            | Planned |

## Step 1, uptime checks, as built

Built on 18 November 2026, from the design above. Code: `apps/api/src/uptime/`, the worker (`apps/api/src/worker.ts`), and `apps/web/src/features/uptime/`; the pages are described in [the dashboard](dashboard.md#812-uptime).

- **Storage.** PostgreSQL holds `uptime_checks` (what each check asks and expects, whether it is paused, its state, its failures in a row and when and why that run of failures started, when it is next due, its latest answer, its certificate's expiry, and when its URL last changed) and `uptime_incidents` (check, start, end, first cause and what it said; at most one open per check). Deleting a project or a check deletes both. ClickHouse holds `check_results`, ordered by project, check, and time, partitioned by day, kept 90 days; project deletion and the search for forgotten projects cover it ([ClickHouse](clickhouse.md#retention-and-deleting-a-project)).
- **The request** (`request.ts`, `addresses.ts`). The URL's host is resolved with a DNS resolver of the worker's own (Node.js's `dns.Resolver`, c-ares), which asks the name servers the system is set up with for A and AAAA records. It does not use the system's `getaddrinfo`, which runs on libuv's four threads: a few checks on a host whose name server never answers held them for seconds, past their own timeouts, and every other check, and the worker's own connections to PostgreSQL and ClickHouse, waited behind them. The resolver's queries end when the check's timeout does. It does not read `/etc/hosts`, so a name only `/etc/hosts` knows, `localhost` among them, does not resolve; an IP address in the URL is used as it is, without DNS. Every address the host resolves to is checked; one refused address refuses the check. Refused: IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, and `240.0.0.0/4`; IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001::/23`, `2001:db8::/32`, `3fff::/20`, `64:ff9b:1::/48`, and anything else outside `2000::/3`. Cloud metadata services, which hand out an instance's credentials, are refused whatever the settings say: `169.254.169.254` (AWS, Google Cloud, Azure, Oracle Cloud, DigitalOcean, Hetzner), `100.100.100.200` (Alibaba Cloud), `168.63.129.16` (Azure's host endpoint), `fd00:ec2::254` (AWS over IPv6), `fd20:ce::254` (Google Cloud on IPv6-only instances), and `fd00:c1::a9fe:a9fe` (Oracle Cloud over IPv6, as cloud-init reads it; Oracle's own documentation names only the IPv4 address). So are the addresses and ranges an operator lists in `UPTIME_DENY_ADDRESSES`. An IPv4-mapped (`::ffff:a.b.c.d`), NAT64 (`64:ff9b::/96`), or 6to4 (`2002::/16`) address is judged by the IPv4 address inside it too. The request connects to the first checked address through a lookup that answers only with it, so the host is never resolved again, while the Host header, TLS's server name, and the certificate check keep the host's name. Each redirect (301, 302, 303, 307, 308) is resolved and checked the same way, at most 5. One timeout covers resolving, connecting, redirects, and the body. The body is read only when a word is looked for, up to 1 MB, and the word is matched as typed. The certificate's expiry is read from the first HTTPS answer's connection.
- **Causes.** Timeout, refused connection, DNS, TLS, status code, word, address not allowed, and two more than the design named: connection, for a connection reset or a network that cannot be reached, and redirects, for more than 5 or one to an address that is not http or https.
- **Saving a check** resolves its host, with the same resolver, and refuses an address the rules refuse with a 400. For a host name, the answer says only that the host resolves to an address checks may not reach, and a failed run's detail and its incident say the same: naming the address and its kind would let a dashboard user learn the instance's internal names and addresses (its containers' among them) one try at a time, without even saving a check. The address and its kind go to the API's or the worker's log. Only an IP address the user typed is named, with its kind. A host that does not resolve is saved, and its runs fail with a DNS cause until it does. The URL must be http or https, without a user name or password (they would be stored as plain text); a word needs `GET`.
- **`UPTIME_ALLOW_PRIVATE_ADDRESSES`** (off by default) lets loopback, private, unique-local, and shared addresses through, for a self-hosted install that checks its own network. Link-local addresses and the metadata services above stay refused even then. With it on, any dashboard user can point a check at any service on that network, and the word check reads its answers: one yes or no per run (is this word in the body?), enough to read data out of a service that answers without a password, a word at a time. Set it only where every dashboard user may read those services ([deployment](deployment.md#uptime-checks)).
- **`UPTIME_DENY_ADDRESSES`**: addresses and CIDR ranges checks may never reach, checked when the API and the worker start. Its reason is the server's own public address: a check to it on another port reaches services a cloud firewall closes only to the outside, such as a database published on the host.
- **Scheduling** (`scheduler.ts`, `checks.ts`). Every 2 seconds the worker takes the due checks there is room for, at most 20 requests at once and 10 of one project, with `FOR UPDATE SKIP LOCKED`, and moves each one's next due time on by whole intervals past now in the same statement, before any request: a crash during a run skips that run, and the check is due again one interval later. Now is PostgreSQL's clock, not the worker's, and a next due time more than one interval ahead, as a clock that jumped leaves, is brought back to one interval from now. A check keeps its place in its interval after the worker was away. Requests run without holding the tick back: a slow check holds only its own place. When slow checks fill every place, the rest wait and run late; the worker logs once when checks are taken 30 seconds or more after they were due, and once when they are on time again. One project's checks fill at most half the places, so they cannot hold back every other project's.
- **State.** Each outcome is recorded on the check in one transaction (`recordOutcome`, the one place a check's state changes): down after its failures in a row, with an incident from the first failure of that run; up again after one success, which ends the incident. It returns the change, which the worker logs; alert rules (step 3) will act on it there. An outcome is not recorded when its run started before the latest recorded one, or before the check's URL changed, so two overlapping runs never record out of order. A changed URL is a new check: it ends an open incident, starts again as pending with no failures, and forgets the old URL's certificate. The result then goes to ClickHouse with an asynchronous insert that waits for the write, as events do; while ClickHouse fails, the worker logs it once and carries on, and the state in PostgreSQL stays right.
- **Uptime** is worked out in PostgreSQL from incidents: the share of the window not inside one, an open incident lasting until now, counted from the check's creation when that is later. The list shows the last 24 hours, 7 days, and 30 days; a check's page also shows its uptime over the chosen days. Incidents are kept with the check, so uptime reaches past the results' 90 days.
- **Routes**, each behind the one access check of every project route, with Fastify schemas and limits: list, add, read, change (any field, or `paused`), and delete checks, at most 50 per project; a check's results over whole days in the instance's timezone (its response times in buckets, runs and failures, the latest 20 failures, and its uptime) and its incidents (the latest 100). The ClickHouse reads filter by project and check, take parameters, and run with the telemetry pages' settings and their limit on queries at once, which both now share (`telemetry/dashboard-limit.ts`, `dashboardReader`).

Decided differently from the design, or settled where it said nothing:

- **First runs** come at a random moment within the check's interval, but at most 5 minutes off, so checks set up together are spread out and an hourly check still answers within minutes.
- **Pausing** ends an open incident and forgets the state: nothing is known of a check while it does not run, and it starts again as pending. Paused time counts as up in uptime.
- **Deleting a check** deletes it and its incidents; its results in ClickHouse are no longer reachable and leave with the 90 days, rather than costing a ClickHouse deletion each time.
- **Response time** is the time to the last answer's headers, redirects included; the chart averages the runs that got an answer.
- **Refusals** do not name the address a host name resolved to (above), where the design's setup check would have.
- **Metadata services and `UPTIME_DENY_ADDRESSES`** are refused whatever the private-address setting says; the design named only the ranges.

### Not done in step 1

- Alerts on a check going down or its certificate expiring (step 3). Their channels are built ([step 2](#step-2-channels-and-delivery-as-built)).
- A check of a host that resolves to several addresses uses the first (IPv4 first); it does not try the others when that one fails.
- Names from `/etc/hosts` do not resolve (above).
- Request headers, a body, or authentication for a check; checks from several locations.

## Step 2, channels and delivery, as built

Built on 18 November 2026, from the design above. Code: `apps/api/src/notifications/`, the request machinery uptime checks and webhooks share (`apps/api/src/outbound/`), the worker (`apps/api/src/worker.ts`), and `apps/web/src/features/settings/`; the dashboard's part is in [the dashboard](dashboard.md#notification-channels), and the webhook format in [webhooks](webhooks.md).

- **Channels** (`channels.ts`, PostgreSQL's `notification_channels`) belong to the instance, at most 20, each with a name (1 to 100 characters; the first address or the URL's host when left empty) and a kind that never changes. An email channel holds 1 to 20 addresses, each one sign-in would accept (zod's `z.email()`, as `canSignInWith` checks it), trimmed, and each kept once whatever its case. A webhook holds its URL, which follows the uptime checks' rules exactly (`outbound/url.ts`: `http` or `https`, a host, no user name or password, at most 2048 characters), and a secret the server makes: 32 random bytes as base64url, which any signed-in user can read from its own route and replace on demand. The list's and a channel's answers say only whether a webhook has one (`hasSecret`), so the secret reaches the browser only when asked for; replacing it answers the new one once. Both answers are `Cache-Control: no-store`. A webhook's host is resolved when it is saved, with the checks' resolver, deny list, and private-address setting (`outbound/addresses.ts`, moved from `uptime/` so both use it), and a refused address answers 400 with the checks' wording, "webhooks" in place of "checks"; a host that does not resolve yet is saved. Every signed-in user may manage channels; changes need the dashboard's origin.
- **Notifications** (`deliveries.ts`, `notify`) are what step 3 calls: `notify(db, { channelIds, type, project, subject, message, url, time? })` writes one row per channel that exists in `notification_deliveries`, in one transaction, before anything is sent, and returns the notification's ID and each delivery's ID and status. The row holds the channel, the event type, the payload (the webhook body, version 1, as `json`, so its keys keep their order), the attempts, the next attempt, the status (pending, sent, or failed), the last error (one line, at most 300 characters, which never names an address the rules refused for a host name), and when it was sent. Unknown channels are skipped. Input no caller should send (an unknown type, an empty message, a relative URL, a subject that is not flat) throws.
- **The channel's cap.** The transaction locks the channels' rows, then counts each channel's deliveries of the last hour, test sends left out (they have their own limit of 5 a minute, and a capped channel still takes one): at 60, the notification is refused ("Not sent: this channel had 60 deliveries in the last hour, its limit."). A channel's first refusal in an hour is a failed row; later ones in that hour only count on it (`refused`, and its error ends "N notifications refused so far."), so a flood does not fill the table. Refusals do not count towards the cap, so a flood that goes on does not keep a channel closed. A rule's own cap of 20 an hour is step 3's.
- **The worker** (`sender.ts`) takes due deliveries every 2 seconds, as many as there is room for, at most 10 sending at once, with `FOR UPDATE SKIP LOCKED`, counting the attempt and moving its next attempt on to the retry's time in the same statement, before anything is sent, as uptime checks are taken. That statement, and the one before it that fails deliveries whose last attempt never finished, run in one transaction with one `now()`, and the take passes over any delivery already at its last attempt, so a lease that ends between the two can never push a delivery past it. Two workers never take one delivery at once, and a worker that stops mid-send leaves the delivery to be tried again after its wait. A late outcome never overwrites a newer one: only the attempt that took the delivery records it.
- **Retries** wait 30 seconds, then 1, 2, 5, 10, 20, and 20 minutes: eight attempts over about an hour, then the delivery fails for good with its last error. The last attempt holds its delivery for 60 seconds; if no outcome is recorded by then, the delivery is recorded as failed ("The last attempt did not finish"), so one that stops the worker each time is not tried for ever.
- **Email** (`email.ts`) goes through Nodemailer to the host, port, TLS mode, and login `SMTP_URL` names (handed over one by one, never as the URL), from `EMAIL_FROM` ([deployment](deployment.md#alert-email)), as one plain-text message to the channel's addresses: the message, when it happened in the instance's timezone, the project, and the dashboard link; the subject is the instance's name, a colon, and the message, on one line, at most 200 characters. Over `smtp://` with a password, STARTTLS is required. A message has 20 seconds. SMTP errors are put in words that never hold the URL or the password, with the server's code and answer where it gave one. Without `SMTP_URL`, an email delivery fails at its first attempt: "Email is not set up on this instance: its operator sets SMTP_URL and EMAIL_FROM."
- **Webhooks** (`webhook.ts`) are a JSON `POST` with the headers and signature [webhooks](webhooks.md) describes. The host is resolved and checked again on every delivery and the request pinned to the checked address (`outbound/request.ts`, shared with uptime checks), so a DNS change after saving cannot reach an address the rules refuse; the refused address and its kind go to the worker's log only. One 10-second timeout covers resolving, connecting, and the answer's headers; any 2xx is delivered, a redirect is not followed, and the answer's body is not read.
- **Pruning:** the worker deletes deliveries older than 30 days every hour; deleting a channel deletes its deliveries.
- **Routes** (`routes.ts`), for any signed-in user, changes with the dashboard's origin, with Fastify schemas and bodies of at most 32 KB: `GET` and `POST /api/channels` (the list says whether email is set up), `GET`, `PATCH`, and `DELETE /api/channels/:id`, `GET /api/channels/:id/secret` (a webhook's secret), `POST /api/channels/:id/secret` (a new one, answered once), `POST /api/channels/:id/test` (a `test` notification, at most 5 a minute per channel, else 429), and `GET /api/channels/:id/deliveries?before=<delivery ID>&limit=<1 to 100, 20 by default>`, the last 30 days newest first, with the ID to ask for the next page.

Decided differently from the design, or settled where it said nothing:

- **Who manages channels:** every signed-in user, and every one can read a webhook's secret, as the design said, until roles exist; it comes only from its own route.
- **Test sends** do not count towards a channel's hourly cap.
- **`SMTP_URL` takes no query string:** Nodemailer would read options from it over Ottertrail's own (TLS, timeouts, logging), so the mailer gets its host, port, TLS, and login one by one.
- **One message per email channel,** to all its addresses at once, so its recipients see each other's addresses: a channel is one team's list.
- **`SMTP_URL` without a password** is accepted, for a relay that needs none.
- **Two IDs:** the body's `id` is the notification, shared by its channels; `Ottertrail-Delivery` is the delivery, one per channel. Both stay the same on every retry.
- **4xx answers are retried** like 5xx: a receiver that is being deployed or misconfigured for a moment often answers 404 or 401.
- **Address refusals at send time are retried** like any failure, since DNS may change back; they fail for good after the last attempt.

### Not done in step 2

- Alert rules, which call `notify` (step 3).
- An overlap when a secret is replaced, during which both secrets sign; a receiver must take the new one at once.
- A cap on deliveries waiting across all channels, beyond each channel's 60 an hour.
