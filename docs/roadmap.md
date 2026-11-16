# Roadmap

Status: stage 1 (web analytics) is built and being checked; see the step table in [web-analytics.md](web-analytics.md). Of stage 0, projects, public keys, the browser tracker, and durable ingestion into PostgreSQL exist; environments, releases, identities, and a production deployment do not yet. Later stages are not started.

## How stages are chosen

Ottertrail replaces the separate tools a small software team runs beside its app: web analytics, error tracking, and email, and monitoring as well (traces, metrics, logs, uptime, and alerts).

Each stage either replaces one of those tools or adds a missing capability. A stage is complete when it can replace the tool it targets for a real production app, not when the first version ships.

Not Ottertrail's job: hosting, the app's database, CI, DNS, captchas, backups, the support inbox, AI APIs, and transactional email such as login codes and password resets. Transactional email stays in the customer's app, so an Ottertrail outage never blocks a login.

## Stages

| Stage                       | Builds                                                                                                                                                            | Replaces or adds                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0. Shared core              | Projects, keys, environments, releases, identities, sessions; browser SDK; durable ingestion into PostgreSQL; an instance on its own server                       | Foundation for everything else                        |
| 1. Web analytics            | Pageviews, referrers, UTM campaigns, countries, devices; a cookieless mode; country lookup without storing IP addresses                                           | Replaces a web analytics tool                         |
| 2. Errors and identity      | Browser errors (grouping, affected users, first and last seen); identify and reset; Web Vitals                                                                    | Replaces browser error tracking and page-speed data   |
| 3. Mailing list, broadcasts | Service announcements to all users; subscribe form with double opt-in, topics, preference page, scheduled broadcasts, bounce, complaint, and unsubscribe handling | Adds a mailing list                                   |
| 4. Behavior-triggered email | A limited workflow: event trigger, delay, one eligibility condition, one email, with conversion tracked                                                           | Adds lifecycle email                                  |
| 5. Backend telemetry        | OTLP ingestion for traces, metrics, and logs; exceptions recorded on spans join the same error list; host metrics from an OpenTelemetry Collector                 | Replaces a monitoring service's traces, metrics, logs |
| 6. Uptime and alerts        | HTTP checks that run outside the monitored server; email alerts for downtime and error spikes                                                                     | Replaces uptime checks and alerts                     |
| 7. Session replay           | Recording with input masking and storage limits                                                                                                                   | Replaces a session replay tool                        |

Stages 0 to 4 are the first release (analytics, then errors, then email). Monitoring (traces, metrics, logs, uptime, and alerts) follows.

## Notes

- Stages 3 and 4 do not depend on stages 5 and 6. Swap the pairs if monitoring becomes more urgent than the mailing list.
- To start collecting subscribers sooner, the subscribe form and double opt-in can move up: they only need the shared core and the email provider setup.
- Service announcements (planned maintenance, incidents) need no consent flow, so they are the simplest first email feature. Status page subscriptions, where anyone can sign up for incident and maintenance updates, fit with stage 6.
- Record consent correctly from the first subscriber. Proof of consent cannot be reconstructed later.
- Campaigns need a provider that permits marketing email. Amazon SES is the default. Cloudflare Email Service is documented as transactional only. Send campaigns from a separate subdomain, as Cloudflare's deliverability guide also recommends.
- When replacing a tool, run the old and new side by side and compare their numbers. The OpenTelemetry Collector can export to both at once.
- Traces and logs are the highest-volume data and the first real test of the PostgreSQL-only design. Keep their retention short and measure before considering ClickHouse.
- Something outside Ottertrail must monitor Ottertrail itself: keep at least one independent health check.
- Later, not scheduled: AI usage tracking (tokens, cost, and latency per user and feature) and support email shown on the user timeline.
