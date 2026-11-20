# One image for an Ottertrail instance. It runs the API (which also serves
# the dashboard and the tracker at /t.js), the worker, the migrations, and the
# setup command; deploy/compose.yaml starts each. See docs/deployment.md.
#
#   docker build -t ottertrail .

ARG NODE_IMAGE=docker.io/library/node:26.11.1-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
# Node.js 25 and later ship without Corepack: install the pnpm that package.json pins.
RUN npm install --global pnpm@12.21.0
# Dependencies before code, so a code change reuses this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/tracker/package.json packages/tracker/
COPY packages/replay-player/package.json packages/replay-player/
# No install scripts: the only one in the workspace installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @ottertrail/tracker --filter @ottertrail/replay-player --filter @ottertrail/web --filter @ottertrail/api run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DASHBOARD_PATH=/app/dashboard \
    TRACKER_SCRIPT_PATH=/app/tracker/tracker.js \
    REPLAY_PLAYER_PATH=/app/replay-player/player.js \
    GEO_DATABASE_PATH=/app/data/geo/dbip-city-lite.mmdb
WORKDIR /app
# pg_dump for the worker's scheduled backups (docs/deployment.md, "Backups"):
# PostgreSQL 18's client, to match the stack's PostgreSQL 18. Debian trixie
# ships 17, which refuses to dump a newer server, so it comes from the
# PostgreSQL project's own Debian repository, which postgresql-common's script
# adds with its signing key; the repository's source list is removed after,
# so an image built on this one runs `apt-get update` against Debian alone.
# Pinned exactly. That repository keeps only the latest minor of each package,
# so when this version is gone the build fails at this step: bump it to the
# one `apt-cache policy postgresql-client-18` lists (docs/deployment.md,
# "Images and releases"). About 70 MB.
ARG POSTGRESQL_CLIENT_VERSION=18.7-1.pgdg13+5
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends "postgresql-client-18=${POSTGRESQL_CLIENT_VERSION}" \
 && apt-get purge -y --auto-remove postgresql-common \
 && rm -f /etc/apt/sources.list.d/pgdg.list /etc/apt/sources.list.d/pgdg.sources \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version
# The API bundles its dependencies, so dist/ needs only Node.js. Each build
# output carries THIRD_PARTY_LICENSES.txt for the code it bundles.
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./dashboard
# The tracker, and beside it what it loads: v.js to measure Web Vitals,
# r.js to record session replays around errors, and h.js for heatmaps.
COPY --from=build /src/packages/tracker/dist/tracker.js /src/packages/tracker/dist/v.js /src/packages/tracker/dist/r.js /src/packages/tracker/dist/h.js ./tracker/
# The session replay player, which the dashboard's player page loads.
COPY --from=build /src/packages/replay-player/dist/player.js /src/packages/replay-player/dist/THIRD_PARTY_LICENSES.txt ./replay-player/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# The location database and data-center ranges live in a volume mounted
# here, which the worker keeps current (and `node dist/update-geo.mjs` updates by hand).
RUN mkdir -p data/geo && chown node:node data/geo
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
