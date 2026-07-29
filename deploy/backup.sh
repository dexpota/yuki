#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 OUTPUT.yuki-backup" >&2
  exit 2
fi

case "$1" in
  /*) output=$1 ;;
  *) output=$PWD/$1 ;;
esac
if [ -e "$output" ]; then
  echo "Backup destination already exists: $output" >&2
  exit 2
fi

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p -- "$(dirname -- "$output")"
dump=$(mktemp "${TMPDIR:-/tmp}/yuki-database.XXXXXX")
partial=$(mktemp "${output}.partial.XXXXXX")
drain_seconds=${YUKI_MAINTENANCE_DRAIN_SECONDS:-120}
writers_stopped=0
running_services=

compose() {
  if [ -n "${YUKI_COMPOSE_ENV_FILE:-}" ]; then
    docker compose --env-file "$YUKI_COMPOSE_ENV_FILE" \
      --project-directory "$deploy_dir" --file "$deploy_dir/compose.yaml" "$@"
  else
    docker compose --project-directory "$deploy_dir" --file "$deploy_dir/compose.yaml" "$@"
  fi
}

was_running() {
  case "
$running_services
" in
    *"
$1
"*) return 0 ;;
    *) return 1 ;;
  esac
}

resume_services() {
  for service in api worker proxy; do
    if was_running "$service"; then
      compose start "$service" >/dev/null
    fi
  done
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f -- "$dump"
  if [ "$status" -ne 0 ]; then
    rm -f -- "$partial"
  fi
  if [ "$writers_stopped" -eq 1 ]; then
    resume_services || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

running_services=$(compose ps --status running --services)
echo "Entering maintenance window and draining writers..." >&2
if was_running proxy; then
  compose stop --timeout "$drain_seconds" proxy
fi
for service in api worker; do
  if was_running "$service"; then
    compose stop --timeout "$drain_seconds" "$service"
  fi
done
writers_stopped=1

compose exec -T postgres sh -c \
  'exec pg_dump --format=custom --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  >"$dump"
chmod 0644 "$dump"

compose run --rm --no-deps -T \
  --volume "$dump:/tmp/database.dump:ro" \
  maintenance create /tmp/database.dump >"$partial"
chmod 0600 "$partial"
mv -- "$partial" "$output"

echo "Backup completed; resuming services..." >&2
resume_services
writers_stopped=0
trap - EXIT HUP INT TERM
rm -f -- "$dump"
echo "$output"
