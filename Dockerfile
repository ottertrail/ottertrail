# deploy/compose.yaml starts each process from this image. See docs/deployment.md.

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
# Backups need a PostgreSQL 18 client; Debian trixie ships 17, which cannot
# dump newer servers. Use the PostgreSQL repository, then remove its source list.
# It keeps only the latest minor: if this pin disappears, use the version from
# `apt-cache policy postgresql-client-18`. Adds about 70 MB. The script reads
# HOST as the repository's host, and HOST is the API's listen address here.
# See docs/deployment.md, "Backups" and "Images and releases".
ARG POSTGRESQL_CLIENT_VERSION=18.7-1.pgdg13+5
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && HOST=apt.postgresql.org /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends "postgresql-client-18=${POSTGRESQL_CLIENT_VERSION}" \
 && apt-get purge -y --auto-remove postgresql-common \
 && rm -f /etc/apt/sources.list.d/pgdg.list /etc/apt/sources.list.d/pgdg.sources \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version
# Bundled dependencies need only Node.js. Build outputs include THIRD_PARTY_LICENSES.txt.
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./dashboard
# Include every script built by packages/tracker/vite.config.ts (deploy-files.test.ts).
COPY --from=build /src/packages/tracker/dist/tracker.js /src/packages/tracker/dist/v.js /src/packages/tracker/dist/r.js /src/packages/tracker/dist/h.js /src/packages/tracker/dist/o.js /src/packages/tracker/dist/s.js ./tracker/
COPY --from=build /src/packages/replay-player/dist/player.js /src/packages/replay-player/dist/THIRD_PARTY_LICENSES.txt ./replay-player/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# The worker updates location data in this mounted volume.
RUN mkdir -p data/geo && chown node:node data/geo
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
