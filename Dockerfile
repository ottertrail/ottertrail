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
# The API bundles its dependencies, so dist/ needs only Node.js. Each build
# output carries THIRD_PARTY_LICENSES.txt for the code it bundles.
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./dashboard
# The tracker, and beside it what it loads: v.js to measure Web Vitals, and
# r.js to record session replays around errors.
COPY --from=build /src/packages/tracker/dist/tracker.js /src/packages/tracker/dist/v.js /src/packages/tracker/dist/r.js ./tracker/
# The session replay player, which the dashboard's player page loads.
COPY --from=build /src/packages/replay-player/dist/player.js /src/packages/replay-player/dist/THIRD_PARTY_LICENSES.txt ./replay-player/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# The geolocation database lives in a volume mounted here, written by `node dist/update-geo.mjs`.
RUN mkdir -p data/geo && chown node:node data/geo
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
