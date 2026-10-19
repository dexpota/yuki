#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 CANDIDATE-MANIFEST.json PREVIOUS-STABLE-MANIFEST.json|-" >&2
  exit 2
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
candidate_manifest=$1
previous_manifest=$2
case "$candidate_manifest" in
  /*) ;;
  *) candidate_manifest=$PWD/$candidate_manifest ;;
esac
work=$(mktemp -d "${TMPDIR:-/tmp}/yuki-production-acceptance.XXXXXX")
artifacts=${YUKI_PRODUCTION_ACCEPTANCE_ARTIFACTS:-$repository_root/acceptance/production-test-results}
fixture_root=$repository_root/acceptance/fixtures
production_compose=$repository_root/deploy/production/compose.yaml
acceptance_overlay=$repository_root/acceptance/production-compose.yaml
suffix=$(printf '%s' "${GITHUB_RUN_ID:-$$}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
clean_project="yuki-clean-$suffix"
restore_project="yuki-restore-$suffix"
upgrade_project="yuki-upgrade-$suffix"
clean_env=$work/clean.env
restore_env=$work/restore.env
upgrade_env=$work/upgrade.env
clean_release=$work/clean.release
restore_release=$work/restore.release
upgrade_release=$work/upgrade.release
clean_url="http://127.0.0.1:${YUKI_PRODUCTION_ACCEPTANCE_CLEAN_PORT:-18380}"
restore_url="http://127.0.0.1:${YUKI_PRODUCTION_ACCEPTANCE_RESTORE_PORT:-18381}"
upgrade_url="http://127.0.0.1:${YUKI_PRODUCTION_ACCEPTANCE_UPGRADE_PORT:-18382}"

case "$candidate_manifest:$previous_manifest" in
  *[!a-zA-Z0-9_./:-]*) echo "Manifest paths contain unsupported characters." >&2; exit 2 ;;
esac
if [ ! -f "$candidate_manifest" ]; then
  echo "Candidate release manifest must exist." >&2
  exit 2
fi
previous_supported=1
if [ "$previous_manifest" = - ]; then
  previous_supported=0
else
  case "$previous_manifest" in
    /*) ;;
    *) previous_manifest=$PWD/$previous_manifest ;;
  esac
  if [ ! -f "$previous_manifest" ]; then
    echo "Previous supported release manifest must exist." >&2
    exit 2
  fi
fi
mkdir -p -- "$artifacts"
chmod 0700 "$artifacts"
umask 077
export YUKI_ACCEPTANCE_FIXTURE_ROOT=$fixture_root
export YUKI_ACCEPTANCE_USERNAME='Production Acceptance Owner'
export YUKI_ACCEPTANCE_PASSWORD='production-acceptance-only-password'

compose() {
  project=$1
  environment=$2
  release=$3
  shift 3
  docker compose \
    --project-name "$project" \
    --project-directory "$repository_root" \
    --env-file "$environment" \
    --env-file "$release" \
    --file "$production_compose" \
    --file "$acceptance_overlay" "$@"
}

capture_logs() {
  project=$1
  environment=$2
  release=$3
  label=$4
  if [ -f "$environment" ] && [ -f "$release" ]; then
    compose "$project" "$environment" "$release" ps \
      >"$artifacts/$label-compose-ps.txt" 2>&1 || true
    compose "$project" "$environment" "$release" logs --no-color --tail 300 \
      >"$artifacts/$label-compose-logs.txt" 2>&1 || true
  fi
}

stop_stack() {
  project=$1
  environment=$2
  release=$3
  if [ -f "$environment" ] && [ -f "$release" ]; then
    compose "$project" "$environment" "$release" down --volumes --remove-orphans \
      >/dev/null 2>&1 || true
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    capture_logs "$clean_project" "$clean_env" "$clean_release" clean
    capture_logs "$restore_project" "$restore_env" "$restore_release" restore
    capture_logs "$upgrade_project" "$upgrade_env" "$upgrade_release" upgrade
    if [ -d "$repository_root/acceptance/test-results" ]; then
      cp -R "$repository_root/acceptance/test-results" "$artifacts/playwright-test-results" \
        2>/dev/null || true
    fi
  fi
  if [ "${YUKI_ACCEPTANCE_KEEP:-0}" != 1 ]; then
    stop_stack "$clean_project" "$clean_env" "$clean_release"
    stop_stack "$restore_project" "$restore_env" "$restore_release"
    stop_stack "$upgrade_project" "$upgrade_env" "$upgrade_release"
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

cd "$repository_root"

platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
case "$platform" in
  linux/x86_64|linux/amd64) platform=linux/amd64 ;;
  linux/aarch64|linux/arm64) platform=linux/arm64 ;;
  *) echo "Unsupported production acceptance platform: $platform" >&2; exit 1 ;;
esac
if [ -n "${YUKI_EXPECTED_PRODUCTION_PLATFORM:-}" ] &&
  [ "$platform" != "$YUKI_EXPECTED_PRODUCTION_PLATFORM" ]; then
  echo "Expected $YUKI_EXPECTED_PRODUCTION_PLATFORM, received $platform." >&2
  exit 1
fi

openssl rand -base64 32 >"$work/csrf.key"
csrf_key=$(tr -d '\r\n' <"$work/csrf.key")
openssl rand -base64 32 >"$work/master.key"
master_key=$(tr -d '\r\n' <"$work/master.key")
openssl rand -base64 32 >"$work/processor.token"
processor_token=$(tr -d '\r\n' <"$work/processor.token")
postgres_password=$(openssl rand -hex 32)
if [ "$csrf_key" = "$master_key" ]; then
  echo "Generated installation keys unexpectedly collided." >&2
  exit 1
fi

write_environment() {
  output=$1
  project=$2
  port=$3
  cat >"$output" <<EOF
YUKI_HTTP_BIND_ADDRESS=127.0.0.1
YUKI_HTTP_PORT=$port
YUKI_POSTGRES_DB=yuki
YUKI_POSTGRES_USER=yuki
YUKI_POSTGRES_PASSWORD=$postgres_password
YUKI_DATABASE_URL=postgresql://yuki:$postgres_password@postgres:5432/yuki
YUKI_CSRF_KEY=$csrf_key
YUKI_MASTER_KEY=$master_key
YUKI_PROCESSOR_TOKEN=$processor_token
YUKI_ALLOWED_ORIGINS=http://127.0.0.1:$port,http://localhost:$port
YUKI_STORAGE_BACKEND=local
YUKI_PROCESSOR_WORKSPACE_VOLUME=${project}_processor_jobs
YUKI_POSTGRES_VOLUME_NAME=${project}_postgres_data
YUKI_STORAGE_VOLUME_NAME=${project}_storage_data
EOF
  chmod 0600 "$output"
}

select_release() {
  manifest=$1
  release=$2
  node "$repository_root/deploy/select-release.mjs" "$manifest" "$release"
}

wait_for_readiness() {
  url=$1
  project=$2
  environment=$3
  release=$4
  attempt=0
  until curl --fail --silent "$url/health/ready" >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 180 ]; then
      compose "$project" "$environment" "$release" ps >&2 || true
      echo "Production API did not become ready at $url." >&2
      return 1
    fi
    sleep 1
  done
}

run_browser_acceptance() {
  url=$1
  YUKI_ACCEPTANCE_BASE_URL=$url \
    corepack pnpm --filter @yuki/acceptance acceptance
}

run_persistence_check() {
  url=$1
  YUKI_ACCEPTANCE_BASE_URL=$url \
  YUKI_ACCEPTANCE_POST_RESTART=1 \
    corepack pnpm --filter @yuki/acceptance exec playwright test \
      --project chromium --no-deps --grep @post-restart
}

report() {
  printf '%s\n' "$*" | tee -a "$artifacts/production-acceptance.txt"
}

candidate_version=
candidate_version=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).release.version)' "$candidate_manifest")
report "Platform: $platform"
report "Candidate release: $candidate_version"
if [ "$previous_supported" -eq 1 ]; then
  previous_version=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).release.version)' "$previous_manifest")
  report "Previous supported release: $previous_version"
else
  previous_version=none
  report "No previous supported release; using the first-release migration replay baseline."
fi

write_environment "$clean_env" "$clean_project" "${YUKI_PRODUCTION_ACCEPTANCE_CLEAN_PORT:-18380}"
select_release "$candidate_manifest" "$clean_release" >/dev/null
compose "$clean_project" "$clean_env" "$clean_release" pull >/dev/null
compose "$clean_project" "$clean_env" "$clean_release" up --detach --wait web worker octoprint-a octoprint-b
wait_for_readiness "$clean_url" "$clean_project" "$clean_env" "$clean_release"
report "Candidate clean installation is ready."
run_browser_acceptance "$clean_url"
compose "$clean_project" "$clean_env" "$clean_release" restart api worker supervisor
compose "$clean_project" "$clean_env" "$clean_release" run --rm migrate
compose "$clean_project" "$clean_env" "$clean_release" up --detach --force-recreate --no-deps api worker
wait_for_readiness "$clean_url" "$clean_project" "$clean_env" "$clean_release"
run_persistence_check "$clean_url"
report "Candidate service restart and migration replay passed."

clean_backup=$work/candidate-clean-install.yuki-backup
YUKI_COMPOSE_FILE=$production_compose \
YUKI_COMPOSE_OVERLAY_FILE=$acceptance_overlay \
YUKI_COMPOSE_ENV_FILE=$clean_env \
YUKI_COMPOSE_RELEASE_ENV_FILE=$clean_release \
YUKI_COMPOSE_PROJECT_NAME=$clean_project \
YUKI_COMPOSE_EDGE_SERVICE=web \
  "$repository_root/deploy/backup.sh" "$clean_backup"

write_environment "$restore_env" "$restore_project" "${YUKI_PRODUCTION_ACCEPTANCE_RESTORE_PORT:-18381}"
select_release "$candidate_manifest" "$restore_release" >/dev/null
YUKI_COMPOSE_FILE=$production_compose \
YUKI_COMPOSE_OVERLAY_FILE=$acceptance_overlay \
YUKI_COMPOSE_ENV_FILE=$restore_env \
YUKI_COMPOSE_RELEASE_ENV_FILE=$restore_release \
YUKI_COMPOSE_PROJECT_NAME=$restore_project \
YUKI_COMPOSE_EDGE_SERVICE=web \
  "$repository_root/deploy/restore.sh" "$clean_backup"
compose "$restore_project" "$restore_env" "$restore_release" up --detach --wait octoprint-a octoprint-b
wait_for_readiness "$restore_url" "$restore_project" "$restore_env" "$restore_release"
run_persistence_check "$restore_url"
report "Candidate backup and clean-install restore passed."

if [ "$previous_supported" -eq 1 ]; then
  write_environment "$upgrade_env" "$upgrade_project" "${YUKI_PRODUCTION_ACCEPTANCE_UPGRADE_PORT:-18382}"
  select_release "$previous_manifest" "$upgrade_release" >/dev/null
  compose "$upgrade_project" "$upgrade_env" "$upgrade_release" pull >/dev/null
  compose "$upgrade_project" "$upgrade_env" "$upgrade_release" up --detach --wait web worker octoprint-a octoprint-b
  wait_for_readiness "$upgrade_url" "$upgrade_project" "$upgrade_env" "$upgrade_release"
  report "Previous release $previous_version clean installation is ready."
  run_browser_acceptance "$upgrade_url"

  upgrade_backup=$work/previous-release.yuki-backup
  YUKI_COMPOSE_FILE=$production_compose \
  YUKI_COMPOSE_OVERLAY_FILE=$acceptance_overlay \
  YUKI_COMPOSE_ENV_FILE=$upgrade_env \
  YUKI_COMPOSE_RELEASE_ENV_FILE=$upgrade_release \
  YUKI_COMPOSE_PROJECT_NAME=$upgrade_project \
  YUKI_COMPOSE_EDGE_SERVICE=web \
  YUKI_UPDATE_MIN_FREE_KB=1 \
    "$repository_root/deploy/update-release.sh" \
      "$candidate_manifest" "$candidate_version" "$upgrade_backup"
  wait_for_readiness "$upgrade_url" "$upgrade_project" "$upgrade_env" "$upgrade_release"
  run_persistence_check "$upgrade_url"
  report "Upgrade from $previous_version to $candidate_version passed."
else
  report "Previous-release upgrade skipped because no earlier supported v2 release exists."
fi

printf 'PASS platform=%s candidate=%s previous=%s\n' \
  "$platform" "$candidate_version" "$previous_version" >>"$artifacts/production-acceptance.txt"
