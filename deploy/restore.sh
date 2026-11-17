#!/bin/sh
# Restores a backup made by backup.sh into an instance with empty
# databases: a new server, or after `docker compose down -v`. Run it in
# this folder, next to compose.yaml, with the backup's path without its
# ending; both files must be there.
#
#   ./restore.sh backups/ottertrail-2026-11-17T120000Z
#   COMPOSE="podman compose" ./restore.sh backups/ottertrail-2026-11-17T120000Z
#
# It starts only the databases, restores them, then starts the rest. The
# databases must not have been migrated yet: ClickHouse refuses to restore
# into tables that hold data, and the migrations record themselves in one.
set -eu

compose=${COMPOSE:-docker compose}
backup=${1:?Give the backup without its ending, such as backups/ottertrail-2026-11-17T120000Z}
name=$(basename "$backup")
# The name goes into commands inside the containers: only names backup.sh makes.
case "$name" in
  ottertrail-*[!0-9A-Za-z-]*) echo "Not a backup name: $name" >&2; exit 1 ;;
  ottertrail-*) ;;
  *) echo "Not a backup name: $name" >&2; exit 1 ;;
esac
for file in "$backup.dump" "$backup.zip"; do
  [ -f "$file" ] || { echo "$file is missing." >&2; exit 1; }
done

$compose up -d postgres clickhouse
echo "Waiting for the databases …"
# On their first start, both images run a temporary server to create the
# database and user, stop it, then start the real one. PostgreSQL's
# temporary server has no TCP port, so pg_isready asks over TCP.
# ClickHouse's answers queries, so wait until its real server is the
# container's main process (PID 1), which the image's entrypoint was.
# clickhouse-client takes the password from the container's
# CLICKHOUSE_PASSWORD, so it is not on any command line.
tries=0
until $compose exec -T postgres pg_isready -h 127.0.0.1 -U ottertrail -d ottertrail > /dev/null 2>&1 &&
  [ "$($compose exec -T clickhouse cat /proc/1/comm 2> /dev/null)" = "clickhouse-serv" ] &&
  $compose exec -T clickhouse clickhouse-client --user ottertrail --query "SELECT 1" > /dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo "The databases did not start." >&2; exit 1; }
  sleep 2
done

$compose exec -T postgres pg_restore -h 127.0.0.1 -U ottertrail -d ottertrail \
  --no-owner --single-transaction --exit-on-error < "$backup.dump"

# Into ClickHouse's backup folder, as ClickHouse's own user, so its later
# backups can still write there.
$compose exec -T -u clickhouse clickhouse sh -c \
  "mkdir -p /var/lib/clickhouse/backups && cat > '/var/lib/clickhouse/backups/$name.zip'" < "$backup.zip"
$compose exec -T clickhouse clickhouse-client --user ottertrail --receive_timeout 86400 \
  --query "RESTORE DATABASE ottertrail FROM File('$name.zip')" > /dev/null
$compose exec -T -u clickhouse clickhouse rm "/var/lib/clickhouse/backups/$name.zip"

# Events copied after ClickHouse's backup was made are marked copied in
# PostgreSQL's: send all of PostgreSQL's events again. ClickHouse keeps one
# row per event (docs/clickhouse.md), so the repeats count once.
$compose exec -T postgres psql -q -U ottertrail -d ottertrail \
  -c "update events set copied_at = null" > /dev/null

$compose up -d
echo "Restored $name. The worker sends the last two days' events to ClickHouse again within seconds."
