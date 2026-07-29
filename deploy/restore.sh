#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 BACKUP.yuki-backup" >&2
  exit 2
fi

case "$1" in
  /*) backup=$1 ;;
  *) backup=$PWD/$1 ;;
esac
if [ ! -f "$backup" ]; then
  echo "Backup file does not exist: $backup" >&2
  exit 2
fi

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dump=$(mktemp "${TMPDIR:-/tmp}/yuki-restore.XXXXXX")
drain_seconds=${YUKI_MAINTENANCE_DRAIN_SECONDS:-120}

compose() {
  if [ -n "${YUKI_COMPOSE_ENV_FILE:-}" ]; then
    docker compose --env-file "$YUKI_COMPOSE_ENV_FILE" \
      --project-directory "$deploy_dir" --file "$deploy_dir/compose.yaml" "$@"
  else
    docker compose --project-directory "$deploy_dir" --file "$deploy_dir/compose.yaml" "$@"
  fi
}

cleanup() {
  status=$?
  rm -f -- "$dump"
  if [ "$status" -ne 0 ]; then
    echo "Restore did not complete; inspect runtime state before retrying." >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

echo "Entering maintenance window..." >&2
compose stop --timeout "$drain_seconds" proxy
compose stop --timeout "$drain_seconds" api worker
compose up --detach postgres >/dev/null

compose run --rm --no-deps -T maintenance verify <"$backup"
compose run --rm --no-deps -T maintenance extract-database <"$backup" >"$dump"
chmod 0600 "$dump"

relations=$(
  compose exec -T postgres sh -c \
    'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '\''public'\'' and c.relkind in ('\''r'\'','\''p'\'','\''v'\'','\''m'\'','\''S'\'','\''f'\'')"' \
    | tr -d '[:space:]'
)
if [ "$relations" != "0" ]; then
  echo "Restore requires a clean database; found $relations public relations." >&2
  exit 1
fi

compose run --rm --no-deps -T maintenance restore-storage <"$backup"
compose exec -T postgres sh -c \
  'exec pg_restore --exit-on-error --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  <"$dump"
compose run --rm -T migrate
compose run --rm --no-deps -T maintenance integrity

echo "Restore verified; enabling writes..." >&2
compose up --detach api worker proxy >/dev/null
trap - EXIT HUP INT TERM
rm -f -- "$dump"
echo "Restore completed."
