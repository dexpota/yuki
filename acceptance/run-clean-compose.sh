#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project=${YUKI_ACCEPTANCE_PROJECT:-yuki-acceptance-$$}
http_port=${YUKI_ACCEPTANCE_HTTP_PORT:-18080}
processor_port=${YUKI_ACCEPTANCE_PROCESSOR_PORT:-33210}
processor_token=YWNjZXB0YW5jZS1vbmx5LXByb2Nlc3Nvci10b2tlbi0zMi1ieXRlcw==
processor_image="yuki-processor:${project}"
supervisor_root="${TMPDIR:-/tmp}/${project}-processor"
supervisor_pid=

case "$project" in
  '' | *[!a-zA-Z0-9_-]*)
    echo "YUKI_ACCEPTANCE_PROJECT must contain only letters, digits, _ or -." >&2
    exit 2
    ;;
esac
case "$http_port:$processor_port" in
  *[!0-9:]* | :* | *:)
    echo "Acceptance ports must be positive integers." >&2
    exit 2
    ;;
esac

compose() {
  YUKI_HTTP_PORT="$http_port" \
    YUKI_ACCEPTANCE_FIXTURE_ROOT="$repository_root/acceptance/fixtures" \
    YUKI_ALLOWED_ORIGINS="http://127.0.0.1:${http_port},http://localhost:${http_port}" \
    YUKI_PROCESSOR_PORT="$processor_port" \
    YUKI_PROCESSOR_TOKEN="$processor_token" \
    docker compose \
      --env-file "$repository_root/deploy/.env.example" \
      --project-name "$project" \
      --project-directory "$repository_root/deploy" \
      --file "$repository_root/deploy/compose.yaml" \
      --file "$repository_root/acceptance/compose.yaml" "$@"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$supervisor_pid" ]; then
    kill -TERM "$supervisor_pid" 2>/dev/null || true
    wait "$supervisor_pid" 2>/dev/null || true
  fi
  if [ "${YUKI_ACCEPTANCE_KEEP:-0}" != "1" ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker image rm "$processor_image" >/dev/null 2>&1 || true
    rm -rf -- "$supervisor_root"
  else
    echo "Kept Compose project $project for inspection." >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

wait_for_readiness() {
  attempt=0
  until curl --fail --silent "http://127.0.0.1:${http_port}/health/ready" >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 120 ]; then
      compose ps >&2
      echo "Acceptance deployment did not become ready." >&2
      exit 1
    fi
    sleep 1
  done
}

cd "$repository_root"
docker build --file processor/Dockerfile --tag "$processor_image" .
pnpm --filter @yuki/backend build
processor_id=$(docker image inspect --format '{{.Id}}' "$processor_image")
YUKI_PROCESSOR_IMAGE="$processor_id" \
  YUKI_PROCESSOR_TOKEN="$processor_token" \
  YUKI_PROCESSOR_HOST=127.0.0.1 \
  YUKI_PROCESSOR_PORT="$processor_port" \
  YUKI_PROCESSOR_WORKSPACE_ROOT="$supervisor_root" \
  node backend/dist/processor-supervisor-main.js &
supervisor_pid=$!

compose build api web
compose up --detach proxy worker octoprint-a octoprint-b
wait_for_readiness

YUKI_ACCEPTANCE_BASE_URL="http://127.0.0.1:${http_port}" \
  pnpm --filter @yuki/acceptance acceptance

compose restart api worker
wait_for_readiness
compose run --rm migrate
compose up --detach --force-recreate api worker
wait_for_readiness

YUKI_ACCEPTANCE_BASE_URL="http://127.0.0.1:${http_port}" \
  YUKI_ACCEPTANCE_POST_RESTART=1 \
  pnpm --filter @yuki/acceptance exec playwright test \
    --project chromium \
    --no-deps \
    --grep @post-restart
