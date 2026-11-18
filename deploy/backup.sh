#!/bin/sh
# Backs up a running instance into ./backups/, as
# ottertrail-<time>.zip (ClickHouse: events, traces, logs, metrics),
# ottertrail-<time>.dump (PostgreSQL: accounts, projects, settings), and
# ottertrail-<time>-objects.tar (the object store: source maps and session
# replays; without a store, a manifest that says there is none). Keep it
# next to compose.yaml and .env, as a release's files are; it runs Compose
# in its own folder, wherever it is called from. Copy all three files off
# the server: a backup on the same disk is lost with it. docs/deployment.md
# has the details; restore.sh puts a backup back.
#
#   ./backup.sh
#   COMPOSE="podman compose" ./backup.sh
set -eu

# The files hold every customer's data: readable by this user only.
umask 077

compose=${COMPOSE:-docker compose}
# Compose finds compose.yaml and .env in the folder it runs in.
cd "$(dirname "$0")"
name=ottertrail-$(date -u +%Y-%m-%dT%H%M%SZ)
objects=backups/$name-objects
mkdir -p backups

# A one-off container of the app's image, without starting anything else.
# It runs as this user, so the files it writes into backups/ are this
# user's, and as private as the others. Its bind mounts carry :z, which
# SELinux hosts need and others ignore.
app() {
  $compose run --rm --no-deps -T -u "$(id -u):$(id -g)" "$@"
}

# A failed run leaves no file that looks like a backup: each is written
# under a .partial name and renamed once all three are complete.
step=
cleanup() {
  status=$?
  rm -f "backups/$name.zip.partial" "backups/$name.dump.partial" "$objects.tar.partial"
  rm -rf "$objects.partial"
  $compose exec -T clickhouse rm -f "/var/lib/clickhouse/backups/$name.zip" > /dev/null 2>&1 || true
  # The .dump is renamed last: without it, the others are not a backup.
  [ -f "backups/$name.dump" ] || rm -f "$objects.tar" "backups/$name.zip"
  if [ "$status" -ne 0 ] && [ -n "$step" ]; then
    echo "The backup failed while $step. No backup file was kept." >&2
  fi
}
trap cleanup EXIT
# Some shells (dash, Debian's sh) skip the EXIT trap when a signal such as
# Ctrl-C ends the script: exit instead, which runs it.
trap 'exit 1' INT TERM HUP

# PostgreSQL first, so every project in its dump has its events in
# ClickHouse's backup, taken after. Events of a project created in between
# belong to no restored project; the worker's orphan sweep deletes them
# (docs/clickhouse.md).
step="dumping PostgreSQL"
$compose exec -T postgres pg_dump -U ottertrail -Fc ottertrail > "backups/$name.dump.partial"

# clickhouse-client takes the password from the container's
# CLICKHOUSE_PASSWORD, so it is not on any command line.
step="backing up ClickHouse"
$compose exec -T clickhouse clickhouse-client --user ottertrail --receive_timeout 86400 \
  --query "BACKUP DATABASE ottertrail TO File('$name.zip')" > /dev/null
# ClickHouse writes it into its own volume (the backups setting in
# compose.yaml's clickhouse-config): move it out to this folder.
step="copying ClickHouse's backup out of its volume"
$compose exec -T clickhouse cat "/var/lib/clickhouse/backups/$name.zip" > "backups/$name.zip.partial"

# The object store last, with the same settings the API reads; without a
# store, the command writes a manifest that says so. Each object is
# streamed into its own file, then packed into one tar here. The instance
# keeps running: an object written after PostgreSQL's dump is in the
# backup but nothing refers to it, and one deleted in between (an expired
# replay) is left out, as if it had expired (docs/deployment.md).
step="backing up the object store (source maps and session replays)"
mkdir "$objects.partial"
app -v "$PWD/$objects.partial:/backup:z" api node dist/backup-objects.mjs /backup
step="packing the object store's files into a tar"
tar -cf "$objects.tar.partial" -C "$objects.partial" .
rm -rf "$objects.partial"

# The tar first: a .zip and a .dump are never left without it.
step="renaming the finished files"
mv "$objects.tar.partial" "$objects.tar"
mv "backups/$name.zip.partial" "backups/$name.zip"
mv "backups/$name.dump.partial" "backups/$name.dump"
step=
echo "Backed up to $PWD/backups/: $name.zip, $name.dump, and $name-objects.tar. Copy all three off the server."
