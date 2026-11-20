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
# Or from a scheduled backup the worker uploaded to S3-compatible storage:
#
#   ./restore.sh --from-s3 --key ottertrail-backup-key.txt            (the newest)
#   ./restore.sh --from-s3 --key ottertrail-backup-key.txt 2026-11-17T030000Z
#
# It lists the backups in the destination's folder, downloads one into
# backups/, decrypts it with the key file the Backups tab downloads, and
# checks every part against the backup's manifest (dist/restore-backup.mjs),
# then restores it as below and deletes the downloaded files. The
# destination comes from BACKUP_S3_ENDPOINT, BACKUP_S3_REGION,
# BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (the folder), BACKUP_S3_ACCESS_KEY_ID,
# and BACKUP_S3_SECRET_ACCESS_KEY, or it asks for each one missing; the key
# file from --key or BACKUP_KEY_FILE. Nothing secret goes on a command line.
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
from_s3=
key_file=${BACKUP_KEY_FILE:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --without-objects) without_objects=1; shift ;;
    --from-s3) from_s3=1; shift ;;
    --key)
      key_file=${2:?--key needs the backup key file}
      shift 2
      ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
# Paths count from where the script was called. Then Compose runs in the
# script's own folder, where it finds compose.yaml and .env.
absolute() {
  case "$1" in
    /*) echo "$1" ;;
    *) echo "$PWD/$1" ;;
  esac
}
downloaded=
if [ -n "$from_s3" ]; then
  wanted=${1:-latest}
  case "$wanted" in
    latest | [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) echo "Not a backup's name: $wanted (such as 2026-11-17T030000Z, or latest)" >&2; exit 1 ;;
  esac
  # Asks for each setting the environment lacks; a secret without echo.
  ask() {
    eval "value=\${$1:-}"
    if [ -z "$value" ]; then
      if [ ! -t 0 ]; then
        echo "Set $1, or run this in a terminal to be asked for it." >&2
        exit 1
      fi
      printf '%s: ' "$2" >&2
      if [ "${3:-}" = secret ]; then
        stty -echo
        read -r value
        stty echo
        echo >&2
      else
        read -r value
      fi
      eval "$1=\$value"
    fi
    # The variable that $1 names, for the one-off container's -e.
    # shellcheck disable=SC2163
    export "$1"
  }
  ask BACKUP_S3_ENDPOINT "S3 endpoint, such as https://<account>.r2.cloudflarestorage.com"
  ask BACKUP_S3_REGION "Region (auto for Cloudflare R2)"
  ask BACKUP_S3_BUCKET "Bucket"
  ask BACKUP_S3_PREFIX "Folder in the bucket (Folder on the Backups tab)"
  ask BACKUP_S3_ACCESS_KEY_ID "Access key ID"
  ask BACKUP_S3_SECRET_ACCESS_KEY "Secret access key" secret
  if [ -z "$key_file" ]; then
    BACKUP_KEY_FILE=
    ask BACKUP_KEY_FILE "Backup key file (the one the Backups tab downloads)"
    key_file=$BACKUP_KEY_FILE
  fi
  key_file=$(absolute "$key_file")
  [ -f "$key_file" ] || { echo "The key file $key_file is missing." >&2; exit 1; }
else
  backup=$(absolute "${1:?Give the backup without its ending, such as backups/ottertrail-2026-11-17T120000Z}")
fi
cd "$(dirname "$0")"

if [ -n "$from_s3" ]; then
  # A one-off container of the app's image, with the destination's
  # settings passed by name from this shell's environment.
  s3() {
    $compose run --rm --no-deps -T -u "$(id -u):$(id -g)" \
      -e BACKUP_S3_ENDPOINT -e BACKUP_S3_REGION -e BACKUP_S3_BUCKET -e BACKUP_S3_PREFIX \
      -e BACKUP_S3_ACCESS_KEY_ID -e BACKUP_S3_SECRET_ACCESS_KEY "$@"
  }
  echo "Backups in $BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX, newest first:"
  s3 api node dist/restore-backup.mjs list
  mkdir -p backups
  echo "Downloading and checking $wanted …"
  # The decrypted files hold every customer's data: readable by this user only (umask above).
  backup=$(s3 -v "$PWD/backups:/backup:z" -v "$key_file:/backup-key.txt:ro,z" \
    api node dist/restore-backup.mjs download "$wanted" /backup-key.txt /backup) ||
    { echo "Nothing was changed: the databases were not touched." >&2; exit 1; }
  backup=$PWD/backups/$(basename "$backup")
  downloaded=1
fi
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
    if [ -n "$downloaded" ]; then
      echo "The downloaded, decrypted files are in backups/: delete them once you no longer need them." >&2
    fi
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
if [ -n "$downloaded" ]; then
  # The backup stays in the bucket; the plain copy here goes.
  rm -f "$backup.dump" "$backup.zip" "$backup-objects.tar"
  echo "Restored $name from $BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX, and deleted the downloaded files."
else
  echo "Restored $name."
fi
