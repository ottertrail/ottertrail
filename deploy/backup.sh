#!/bin/sh
# Backs up both databases of a running instance into ./backups/, as
# ottertrail-<time>.zip (ClickHouse: events, traces, logs, metrics) and
# ottertrail-<time>.dump (PostgreSQL: accounts, projects, settings).
# Run it in this folder, next to compose.yaml. Copy both files off the
# server: a backup on the same disk is lost with it. docs/deployment.md
# has the details; restore.sh puts a backup back.
#
#   ./backup.sh
#   COMPOSE="podman compose" ./backup.sh
set -eu

# The files hold every customer's data: readable by this user only.
umask 077

compose=${COMPOSE:-docker compose}
name=ottertrail-$(date -u +%Y-%m-%dT%H%M%SZ)
mkdir -p backups

# A failed run leaves no file that looks like a backup: each is written
# under a .partial name and renamed once complete.
cleanup() {
  rm -f "backups/$name.zip.partial" "backups/$name.dump.partial"
  $compose exec -T clickhouse rm -f "/var/lib/clickhouse/backups/$name.zip" > /dev/null 2>&1 || true
}
trap cleanup EXIT
# Some shells (dash, Debian's sh) skip the EXIT trap when a signal such as
# Ctrl-C ends the script: exit instead, which runs it.
trap 'exit 1' INT TERM HUP

# PostgreSQL first, so every project in its dump has its events in
# ClickHouse's backup, taken after. Events of a project created in between
# belong to no restored project; the worker's orphan sweep deletes them
# (docs/clickhouse.md).
$compose exec -T postgres pg_dump -U ottertrail -Fc ottertrail > "backups/$name.dump.partial"

# clickhouse-client takes the password from the container's
# CLICKHOUSE_PASSWORD, so it is not on any command line.
$compose exec -T clickhouse clickhouse-client --user ottertrail --receive_timeout 86400 \
  --query "BACKUP DATABASE ottertrail TO File('$name.zip')" > /dev/null
# ClickHouse writes it into its own volume (deploy/clickhouse/config.d):
# move it out to this folder.
$compose exec -T clickhouse cat "/var/lib/clickhouse/backups/$name.zip" > "backups/$name.zip.partial"

mv "backups/$name.zip.partial" "backups/$name.zip"
mv "backups/$name.dump.partial" "backups/$name.dump"
echo "Backed up to backups/$name.zip and backups/$name.dump. Copy both off the server."
