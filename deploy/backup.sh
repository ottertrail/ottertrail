#!/bin/sh
# Backs up a running instance into ./backups/, as
# ottertrail-<time>.zip (ClickHouse: events, traces, logs, metrics),
# ottertrail-<time>.dump (PostgreSQL: accounts, projects, settings), and
# ottertrail-<time>-objects.tar (the object store: source maps, session
# replays, avatars, and saved heatmap views; without a store, a manifest
# that says there is none). Keep it
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
    echo "Backup failed while $step. No backup kept." >&2
  fi
}
trap cleanup EXIT
# Some shells (dash, Debian's sh) skip the EXIT trap when a signal such as
# Ctrl-C ends the script: exit instead, which runs it.
trap 'exit 1' INT TERM HUP

# Free space first. ClickHouse writes its backup into its own volume and
# the script copies it out, and the objects are written twice (files, then
# the tar): the backup needs about twice ClickHouse's data and twice the
# objects, the estimate the Settings page's "next backup would fail"
# warning uses (docs/deployment.md, "Storage"). The objects' size is what
# Ottertrail recorded in PostgreSQL. Below it, the script warns and goes on:
# the disk may have room after all, and a failed run keeps no file.
gib() { awk -v b="$1" 'BEGIN { printf "%.1f GiB", b / 1073741824 }'; }
disk_free=$($compose exec -T clickhouse clickhouse-client --user ottertrail \
  --query "SELECT free_space FROM system.disks WHERE name = 'default'" 2> /dev/null) || disk_free=
data_bytes=$($compose exec -T clickhouse clickhouse-client --user ottertrail \
  --query "SELECT sum(bytes_on_disk) FROM system.parts WHERE database = 'ottertrail' AND active" 2> /dev/null) || data_bytes=
object_bytes=$($compose exec -T postgres psql -U ottertrail -d ottertrail -Atc \
  "select (select coalesce(sum(bytes), 0) from replays) + (select coalesce(sum(octet_length(data)), 0) from replay_chunks) + (select coalesce(sum(bytes), 0) from source_maps)" 2> /dev/null) || object_bytes=
folder_free=$(df -Pk backups 2> /dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }') || folder_free=
# A whole number of bytes, or empty: each figure is checked on its own.
bytes() { case "$1" in '' | *[!0-9]*) ;; *) echo "$1" ;; esac; }
disk_free=$(bytes "$disk_free")
data_bytes=$(bytes "$data_bytes")
object_bytes=$(bytes "$object_bytes")
folder_free=$(bytes "$folder_free")
if [ -z "$disk_free" ] || [ -z "$data_bytes" ] || [ -z "$object_bytes" ]; then
  echo "Couldn't measure free space. Continuing; needs about twice ClickHouse's data and twice the objects." >&2
else
  need=$((2 * data_bytes + 2 * object_bytes))
  echo "Free space: $(gib "$disk_free") on ClickHouse's disk${folder_free:+, $(gib "$folder_free") for backups/}. Needs about $(gib "$need")."
  if [ "$disk_free" -lt "$need" ] || { [ -n "$folder_free" ] && [ "$folder_free" -lt "$need" ]; }; then
    echo "Warning: insufficient free space. Backup may fail and keep no files. Copy old backups off the server, then delete them." >&2
  fi
fi

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
step="copying ClickHouse's backup"
$compose exec -T clickhouse cat "/var/lib/clickhouse/backups/$name.zip" > "backups/$name.zip.partial"

# The object store last, with the same settings the API reads; without a
# store, the command writes a manifest that says so. Each object is
# streamed into its own file, then packed into one tar here. The instance
# keeps running: an object written after PostgreSQL's dump is in the
# backup but nothing refers to it, and one deleted in between (an expired
# replay) is left out, as if it had expired (docs/deployment.md).
step="backing up the object store"
mkdir "$objects.partial"
app -v "$PWD/$objects.partial:/backup:z" api node dist/backup-objects.mjs /backup
step="packing the object backup"
tar -cf "$objects.tar.partial" -C "$objects.partial" .
rm -rf "$objects.partial"

# The tar first: a .zip and a .dump are never left without it.
step="renaming the finished files"
mv "$objects.tar.partial" "$objects.tar"
mv "backups/$name.zip.partial" "backups/$name.zip"
mv "backups/$name.dump.partial" "backups/$name.dump"
step=
echo "Backed up to $PWD/backups/: $name.zip, $name.dump, and $name-objects.tar. Copy all three off the server."
