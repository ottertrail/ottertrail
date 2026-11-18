# Uptime checks and alerts

**Status: planned, stage 4 of the [roadmap](roadmap.md). This is the design to build from; nothing in it is built.**

Ottertrail checks that a customer's sites and APIs answer, from outside the servers they run on, and tells the team when something breaks: a check that fails, an error never seen before or come back after being resolved, a sudden rise in errors. Alerts go out by email and by a signed webhook. The choices below were made on 18 November 2026.

## Uptime checks

A check is an HTTP(S) request a project's members set up: a URL, `GET` or `HEAD`, how often (every 1, 2, 5, 10, 15, 30, or 60 minutes), a timeout (10 seconds by default, at most 30), the status codes that count as up (200 to 399 by default), and optionally a word the body must hold, or must not. Redirects are followed, at most 5.

- **Where checks run:** in the worker of the customer's own instance, from one location. That is outside the servers the customer's app runs on, unless they host it on the same machine. If the instance itself is down, its checks are too: the instance needs a monitor of its own outside it, a hosting task.
- **Down and up:** a check is down after it fails twice in a row (1 to 5, set per check), so one lost packet does not page anyone, and up again after one success. Each time down is an incident, with when it started and ended and the first failure's cause (timeout, refused connection, DNS, TLS, status code, missing word).
- **TLS:** each HTTPS check records when its certificate expires; an alert can warn a set number of days before (14 by default).
- **Scheduling:** checks live in PostgreSQL with the time each is next due. The worker takes due checks every few seconds (`FOR UPDATE SKIP LOCKED`, so two workers never run one check twice), spreads their start times so checks set up together do not all fire at once, and runs at most 20 at a time.
- **Results** go to ClickHouse (`check_results`: check, time, up or not, status code, response time, the cause of a failure), ordered by project, then check, then time, as metrics are ordered by name, since every query reads one check's results. They are kept 90 days. Incidents stay in PostgreSQL, with the check.
- **Uptime** over a period is the share of the period not inside an incident, so a check every 10 minutes and one every minute mean the same thing.

### Requests a check must not make

A check is a request the instance makes to an address a member types in, so it must not reach what is behind the instance: its own databases, the cloud's metadata service, or the private network. The URL must be `http` or `https`; its host is resolved first, and a check whose addresses include loopback, private, link-local, unique-local, shared (CGNAT), multicast, or unspecified ones is refused, at setup and on every run. The request then connects to the address that was checked, never resolving again (so DNS cannot answer differently in between), and every redirect is checked the same way. The body is read up to 1 MB for the word. A self-hosted install that must check its own private network can allow it with a setting; the hosted service does not. Webhook URLs follow the same rules.

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

## Where alerts go

Channels belong to the organization (its settings), so every project can use them; each rule picks one or more.

- **Email:** a list of addresses. Sent through the SMTP server the instance is set up with (`SMTP_URL`, `EMAIL_FROM`); without one, the dashboard says email is not set up on this instance. Plain, short messages: what happened, when, and a link to the check or error in the dashboard. Ottertrail sends no other email from alerts.
- **Webhook:** a JSON `POST` to a URL, for a team's own scripts or another service. Each request carries the time and a signature, an HMAC-SHA256 of the time and body with the channel's secret, so the receiver can check it came from Ottertrail and is not a replay. The body names the event (`check.down`, `check.up`, `certificate.expiring`, `error.new`, `error.regressed`, `error.spike`, `error.spike_resolved`), the project, what it is about, and the dashboard link. The format is documented and versioned.
- **Delivery:** every notification is recorded in PostgreSQL before it is sent, and sent by the worker: a webhook gets 10 seconds to answer 2xx, then is retried with growing waits, for up to an hour; email is retried likewise. The dashboard lists each channel's deliveries of the last 30 days, with their outcome, and can send a test.

## The dashboard

- **Uptime** (project nav): the project's checks, each with its state, uptime over the last 24 hours, 7 days, and 30 days, and its response time; add, edit, pause, and delete. A check's page: its response time over the period, its uptime, its incidents, and its latest failures with their causes.
- **Alerts** (project nav): the project's rules, with what each watches, its channels, whether it is firing now, and its recent alerts; add, edit, turn off.
- **Notification channels** (organization settings): email lists and webhooks, with a test send and their recent deliveries; a webhook's secret is shown to the organization's members.
- An error's page links to the rules that watch it.

## Limits

At most 50 checks per project. Requests: 30-second timeout at most, 5 redirects, 1 MB of body read. Rules: at most 50 per project, 20 notifications an hour each. A webhook's answer is read only for its status.

## Not in the first version

- Slack and Discord messages in their own formats (a webhook can reach a small relay meanwhile), SMS, and phone calls.
- Alerts on telemetry: a metric past a value, a service's failure rate or latency, matching log lines.
- Checks from several locations, and checks other than HTTP (TCP, ping, DNS); heartbeat checks that a job reports to.
- Status pages, on-call schedules, escalation, and maintenance windows (a check can be paused).

## How it is built

| Step                                                                                                                              | Status  |
| --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. Uptime checks: storage, scheduling, the request and its address rules, incidents, the Uptime pages                             | Planned |
| 2. Channels and delivery: email over SMTP, signed webhooks, retries, delivery history and test sends                              | Planned |
| 3. Alert rules: check down and certificates from the checker, new, regressed, and spiking errors from the worker, the Alerts page | Planned |
