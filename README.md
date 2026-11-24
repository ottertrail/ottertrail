# Ottertrail

Web analytics, product analytics, error tracking, and monitoring for small software teams, in one app you run on your own server.

Features ship in stages ([docs/roadmap.md](docs/roadmap.md)).

## What it does

- Web analytics: pageviews, sources and campaigns, locations, devices, entry and exit pages, goals, and Web Vitals. It sets no cookies: the anonymous visitor ID changes every day. Bots, browsers in data centers, and referrer spam are left out.
- Product analytics: custom events, events from your servers, funnels, retention, and the users your site signs in, with their activity.
- Heatmaps of clicks, scroll depth, rage clicks, and dead clicks, drawn over your live page or over a view of it you saved.
- Errors from browsers and servers, grouped, mapped back to your code with source maps, and assigned to people. A session replay shows the minute before an error, masked in the visitor's browser before it is sent.
- Traces, logs, and metrics over OpenTelemetry, with pages for services, database queries, and hosts, and the tokens, estimated cost, and latency of your app's AI calls.
- Uptime checks, and alert rules that notify by email or signed webhook.
- A team of an owner, admins, and members with access per area and project. People join by invitation; there is no open sign-up.

The browser tracker is about 5 KB gzipped and stores nothing on the visitor's device.

## Run it on your server

Ottertrail runs on one Linux server with Docker Compose 2.23.1 or later and about 8 GB of memory. The documentation at [docs.ottertrail.app](https://docs.ottertrail.app) covers [installing it](https://docs.ottertrail.app/get-started/install/), [its settings](https://docs.ottertrail.app/self-hosting/configuration/), [backups](https://docs.ottertrail.app/self-hosting/backups/), and [updating](https://docs.ottertrail.app/self-hosting/updating/).

## Run it locally

You need Node.js 26, the [Vite+ CLI](https://viteplus.dev/guide/) (`vp`), and Podman or Docker. pnpm is downloaded automatically.

```sh
vp install              # dependencies and git hooks
podman compose up -d    # PostgreSQL, ClickHouse, and Garage (or: docker compose up -d)
vp run migrate          # creates the tables
vp run dev              # the API on port 3000, the worker, and the dashboard on port 5173
```

In a second terminal, `vp run setup` prints a one-time link that creates the owner account. Open it, then add a project. For sample data on every page, `vp run seed` creates a project named Demo shop.

The commands, tests, settings, and commit rules are in [docs/development.md](docs/development.md).

## License

Ottertrail is licensed under the [GNU Affero General Public License, version 3 only](LICENSE). If you modify it and let people use it over a network, you must offer those users the modified source code. The browser tracker (`packages/tracker`) and the source map upload command (`packages/sourcemaps`) are licensed under the [MIT License](packages/tracker/LICENSE), so any site can include the tracker and any build can run the command.

Third-party code, data, and fonts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Third-party data

IP geolocation by [DB-IP](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The worker or `vp run geo:update` downloads the database; it is not part of this repository.

Referrer spam domains come from Matomo's community [referrer spam list](https://github.com/matomo-org/referrer-spam-list), in the public domain (CC0-1.0), shipped in `apps/api/src/enrichment/referrer-spam/` ([how it's updated](docs/development.md#the-referrer-spam-list)).
