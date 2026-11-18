#!/bin/sh
# Restores a backup made by backup.sh into an instance with empty
# databases: a new server, or after `docker compose down -v`. Keep it next
# to compose.yaml and .env, as a release's files are; it runs Compose in
# its own folder, wherever it is called from. Give it the backup's path
# without its ending. Its .dump, .zip, and -objects.tar must be there. Without the
# tar, it refuses, unless given --without-objects: then the source maps
# and session replays are not restored.
#
#   ./restore.sh backups/ottertrail-2026-11-17T120000Z
#   ./restore.sh --without-objects backups/ottertrail-2026-11-17T120000Z
#   COMPOSE="podman compose" ./restore.sh backups/ottertrail-2026-11-17T120000Z
#
# It first unpacks and checks the object backup (every file against its
# manifest, and that the bucket answers), so a broken backup or an
# unreachable store stops it before it changes anything. Then it starts
# only the databases and restores them, then the object store, then starts
# the rest. The databases must not have been migrated yet: ClickHouse
# refuses to restore into tables that hold data, and the migrations record
# themselves in one.
set -eu

# The unpacked objects hold customers' data: readable by this user only.
umask 077

compose=${COMPOSE:-docker compose}
without_objects=
if [ "${1:-}" = "--without-objects" ]; then
  without_objects=1
  shift
fi
backup=${1:?Give the backup without its ending, such as backups/ottertrail-2026-11-17T120000Z}
# The path counts from where the script was called. Then Compose runs in
# the script's own folder, where it finds compose.yaml and .env.
case "$backup" in
  /*) ;;
  *) backup=$PWD/$backup ;;
esac
cd "$(dirname "$0")"
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
objects=$backup-objects.tar
if [ -z "$without_objects" ] && [ ! -f "$objects" ]; then
  echo "$objects is missing. It holds the source maps and session replays." >&2
  echo "Put it next to the other two, or run again with --without-objects to restore" >&2
  echo "without them: replays will not play, and source maps must be uploaded again." >&2
  exit 1
fi
unpacked=$(dirname "$backup")/$name-objects.restore

# A one-off container of the app's image, without starting anything else,
# as this user, so it can read the files this user unpacked. Its bind
# mount carries :z, which SELinux hosts need and others ignore.
app() {
  $compose run --rm --no-deps -T -u "$(id -u):$(id -g)" "$@"
}
step=
restored=
cleanup() {
  status=$?
  rm -rf "$unpacked"
  if [ "$status" -ne 0 ] && [ -n "$step" ]; then
    echo "The restore failed while $step." >&2
    if [ -n "$restored" ]; then
      echo "The databases were changed: run \`$compose down -v\` and start again." >&2
    else
      echo "Nothing was changed: the databases were not touched." >&2
    fi
  fi
}
trap cleanup EXIT
# Some shells (dash, Debian's sh) skip the EXIT trap when a signal such as
# Ctrl-C ends the script: exit instead, which runs it.
trap 'exit 1' INT TERM HUP

if [ -n "$without_objects" ]; then
  echo "Restoring without the object store (--without-objects): session replays will" >&2
  echo "not play, and source maps must be uploaded again." >&2
else
  step="unpacking $objects"
  rm -rf "$unpacked"
  mkdir "$unpacked"
  tar -xf "$objects" -C "$unpacked"
  # This stack's own Garage (the object-store profile) must run for the
  # check; restore-objects waits up to a minute for its bucket.
  if $compose config --services | grep -qx garage; then
    step="starting Garage"
    $compose up -d garage
  fi
  step="checking the object backup and the object store"
  app -v "$(cd "$unpacked" && pwd):/backup:z" api node dist/restore-objects.mjs --check /backup
fi

step="starting the databases"
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

step="restoring PostgreSQL"
# From here on, the databases are changed.
restored=1
$compose exec -T postgres pg_restore -h 127.0.0.1 -U ottertrail -d ottertrail \
  --no-owner --single-transaction --exit-on-error < "$backup.dump"

step="restoring ClickHouse"
# Into ClickHouse's backup folder, as ClickHouse's own user, so its later
# backups can still write there.
$compose exec -T -u clickhouse clickhouse sh -c \
  "mkdir -p /var/lib/clickhouse/backups && cat > '/var/lib/clickhouse/backups/$name.zip'" < "$backup.zip"
$compose exec -T clickhouse clickhouse-client --user ottertrail --receive_timeout 86400 \
  --query "RESTORE DATABASE ottertrail FROM File('$name.zip')" > /dev/null
$compose exec -T -u clickhouse clickhouse rm "/var/lib/clickhouse/backups/$name.zip"

# The object store, before the API and the worker start: the worker
# deletes expired replays, and must not run before their files are back.
if [ -z "$without_objects" ]; then
  step="restoring the object store"
  app -v "$(cd "$unpacked" && pwd):/backup:z" api node dist/restore-objects.mjs /backup
  rm -rf "$unpacked"
fi

step="starting the rest"
$compose up -d
step=
echo "Restored $name."
