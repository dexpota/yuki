#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 RELEASE-MANIFEST.json VERSION BACKUP.yuki-backup" >&2
  exit 2
fi

manifest_input=$1
requested_version=$2
backup_input=$3
case "$requested_version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Release version must be an explicit semantic version." >&2; exit 2 ;;
esac

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
compose_file=${YUKI_COMPOSE_FILE:-$deploy_dir/production/compose.yaml}
compose_overlay=${YUKI_COMPOSE_OVERLAY_FILE:-}
project_dir=$(dirname -- "$compose_file")
production_env=${YUKI_COMPOSE_ENV_FILE:-$deploy_dir/.env.production}
release_env=${YUKI_COMPOSE_RELEASE_ENV_FILE:-$deploy_dir/.env.release}
project_name=${YUKI_COMPOSE_PROJECT_NAME:-}
node_image=${YUKI_UPDATE_NODE_IMAGE:-node:24.18.0-bookworm-slim}
minimum_free_kb=${YUKI_UPDATE_MIN_FREE_KB:-1048576}

case "$manifest_input" in
  /*) manifest=$manifest_input ;;
  *) manifest=$PWD/$manifest_input ;;
esac
case "$backup_input" in
  /*) backup=$backup_input ;;
  *) backup=$PWD/$backup_input ;;
esac
if [ ! -f "$manifest" ] || [ ! -f "$production_env" ] || [ ! -f "$release_env" ]; then
  echo "Manifest and both production/release environment files must exist." >&2
  exit 2
fi
if [ -e "$backup" ]; then
  echo "Backup destination already exists: $backup" >&2
  exit 2
fi
case "$minimum_free_kb" in
  ''|*[!0-9]*) echo "YUKI_UPDATE_MIN_FREE_KB must be an integer." >&2; exit 2 ;;
esac

release_dir=$(CDPATH= cd -- "$(dirname -- "$release_env")" && pwd -P)
release_name=$(basename -- "$release_env")
release_env=$release_dir/$release_name
lock_dir=$release_env.update-lock
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another release update holds $lock_dir." >&2
  exit 1
fi
candidate_dir=
candidate_env=
previous_env=$release_env.previous
previous_temp=
backup_script=$deploy_dir/backup.sh
maintenance=0
stage=preflight

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

compose() {
  compose_release=$1
  shift
  set -- --env-file "$compose_release" "$@"
  set -- --env-file "$production_env" "$@"
  if [ -n "$project_name" ]; then
    set -- --project-name "$project_name" "$@"
  fi
  if [ -n "$compose_overlay" ]; then
    set -- --file "$compose_overlay" "$@"
  fi
  set -- --file "$compose_file" "$@"
  set -- --project-directory "$project_dir" "$@"
  docker compose "$@"
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    log "Update failed at stage=$stage."
  fi
  if [ "$status" -ne 0 ] && [ "$maintenance" -eq 1 ]; then
    log "Update failed at stage=$stage; stopping application services and leaving maintenance active."
    compose "$release_env" stop --timeout 30 web api worker supervisor >/dev/null 2>&1 || true
    log "Verified pre-update backup remains at $backup"
    log "Previous release selection remains at $previous_env"
  fi
  if [ -n "$candidate_dir" ]; then rm -rf -- "$candidate_dir"; fi
  if [ -n "$previous_temp" ]; then rm -f -- "$previous_temp"; fi
  rm -rf -- "$lock_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

candidate_dir=$(mktemp -d "$release_dir/.yuki-update.XXXXXX")
candidate_env=$candidate_dir/candidate.env

log "Preflight: checking Docker, Compose configuration, platform, and free space."
docker info >/dev/null
docker compose version >/dev/null
platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
docker_root=$(docker info --format '{{.DockerRootDir}}')
case "$platform" in
  linux/x86_64|linux/amd64|linux/aarch64|linux/arm64) ;;
  *) echo "Unsupported Docker platform: $platform" >&2; exit 1 ;;
esac
backup_parent=$(dirname -- "$backup")
if [ ! -d "$backup_parent" ]; then
  echo "Backup destination directory does not exist: $backup_parent" >&2
  exit 1
fi
backup_parent=$(CDPATH= cd -- "$backup_parent" && pwd -P)
backup=$backup_parent/$(basename -- "$backup")
case "$backup" in
  "$deploy_dir"/*)
    echo "Backup destination must be outside the deployment directory." >&2
    exit 1
    ;;
esac
for path in "$backup_parent" "$project_dir" "$docker_root"; do
  available_kb=$(df -Pk "$path" | awk 'NR == 2 { print $4 }')
  if [ -z "$available_kb" ] || [ "$available_kb" -lt "$minimum_free_kb" ]; then
    echo "Insufficient free space at $path; need at least ${minimum_free_kb} KiB." >&2
    exit 1
  fi
done
compose "$release_env" exec -T api node -e \
  "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
compose "$release_env" exec -T web wget -qO- http://127.0.0.1:8080/healthz >/dev/null

stage=release-selection
log "Preflight: preparing and validating candidate release $requested_version."
docker pull "$node_image" >/dev/null
uid=$(id -u)
gid=$(id -g)
manifest_dir=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd -P)
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --user "$uid:$gid" \
  --mount "type=bind,source=$manifest_dir,target=/manifest,readonly" \
  --mount "type=bind,source=$deploy_dir,target=/deploy,readonly" \
  --mount "type=bind,source=$candidate_dir,target=/candidate" \
  "$node_image" node /deploy/select-release.mjs "/manifest/$(basename -- "$manifest")" /candidate/candidate.env
candidate_version=$(sed -n 's/^YUKI_RELEASE_VERSION=//p' "$candidate_env")
candidate_revision=$(sed -n 's/^YUKI_RELEASE_REVISION=//p' "$candidate_env")
if [ "$candidate_version" != "$requested_version" ]; then
  echo "Manifest release $candidate_version does not match requested $requested_version." >&2
  exit 1
fi
if [ "$candidate_version" = "$(sed -n 's/^YUKI_RELEASE_VERSION=//p' "$release_env")" ]; then
  echo "Requested release $candidate_version is already selected." >&2
  exit 1
fi

stage=image-pull-and-verification
for role in BACKEND WEB PROCESSOR SUPERVISOR; do
  image=$(sed -n "s/^YUKI_${role}_IMAGE=//p" "$candidate_env")
  log "Pulling $role image $image"
  docker pull "$image" >/dev/null
  actual_version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")
  actual_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  actual_source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")
  if [ "$actual_version" != "$candidate_version" ] ||
    [ "$actual_revision" != "$candidate_revision" ] ||
    [ "$actual_source" != "https://github.com/dexpota/yuki" ]; then
    echo "$role image metadata does not match the selected release." >&2
    exit 1
  fi
done

stage=configuration-validation
log "Validating candidate Compose configuration and production secrets."
compose "$candidate_env" config --quiet
compose "$candidate_env" run --rm --no-deps preflight >/dev/null

stage=candidate-processor-smoke
log "Running restricted processor operation against the candidate images."
backend=$(sed -n 's/^YUKI_BACKEND_IMAGE=//p' "$candidate_env")
processor=$(sed -n 's/^YUKI_PROCESSOR_IMAGE=//p' "$candidate_env")
supervisor=$(sed -n 's/^YUKI_SUPERVISOR_IMAGE=//p' "$candidate_env")
docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true --user 0:0 \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount "type=bind,source=$deploy_dir,target=/deploy,readonly" \
  --entrypoint node "$supervisor" /deploy/smoke-compose-supervisor.mjs \
  "$supervisor" "$backend" "$processor"

stage=backup
log "Creating verified pre-update backup at $backup"
YUKI_COMPOSE_FILE=$compose_file \
YUKI_COMPOSE_OVERLAY_FILE=$compose_overlay \
YUKI_COMPOSE_ENV_FILE=$production_env \
YUKI_COMPOSE_RELEASE_ENV_FILE=$release_env \
YUKI_COMPOSE_PROJECT_NAME=$project_name \
  "$backup_script" "$backup"

stage=release-selection-commit
log "Recording previous release selection and atomically selecting $candidate_version."
previous_version=$(sed -n 's/^YUKI_RELEASE_VERSION=//p' "$release_env")
log "Current release=$previous_version; previous image selections:"
for role in BACKEND WEB PROCESSOR SUPERVISOR; do
  log "Current $role image $(sed -n "s/^YUKI_${role}_IMAGE=//p" "$release_env")"
done
previous_temp=$release_dir/.$release_name.previous.$$
cp -p -- "$release_env" "$previous_temp"
mv -f -- "$previous_temp" "$previous_env"
previous_temp=
maintenance=1
mv -f -- "$candidate_env" "$release_env"

log "Stopping edge and writers before applying migrations."
stage=service-stop
compose "$release_env" stop --timeout 120 web api worker supervisor
log "Applying migrations for $candidate_version."
stage=migrations
compose "$release_env" run --rm --no-deps migrate
log "Migrations completed for $candidate_version."

log "Starting candidate services and waiting for readiness."
stage=readiness
compose "$release_env" up --detach --wait --no-deps supervisor
compose "$release_env" up --detach --wait --no-deps api worker
compose "$release_env" up --detach --wait --no-deps web
compose "$release_env" run --rm --no-deps preflight >/dev/null
compose "$release_env" exec -T api node -e \
  "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
compose "$release_env" exec -T supervisor node -e \
  "const s=require('node:net').createConnection('/run/yuki/processor.sock');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"
processor_probe='
import { Readable } from "node:stream";
import { ProcessorSupervisorClient } from "./dist/platform/processor/supervisor/client.js";
const input = "G1 X1\n";
const client = new ProcessorSupervisorClient({
  socketPath: process.env.YUKI_PROCESSOR_SOCKET,
  authenticationToken: process.env.YUKI_PROCESSOR_TOKEN,
  responseWorkspaceRoot: process.env.YUKI_PROCESSOR_RESPONSE_ROOT,
  maximumResponseBytes: 1048576,
  maximumOutputFiles: 10,
  timeoutMs: 30000,
});
const result = await client.execute({
  requestId: "release-update-smoke",
  operation: "parse-gcode-facts",
  inputBytes: Buffer.byteLength(input),
  input: Readable.from([input]),
  limits: { maximumInputBytes: 1024, maximumLines: 100, maximumLineBytes: 100,
    maximumSegments: 100, maximumMetadataEntries: 10 },
});
if (!result.processorResult?.facts) throw new Error("Missing processor facts");
await result.cleanup();
process.stdout.write("Compose supervisor processor operation completed.\n");
'
compose "$release_env" exec -T worker node --input-type=module --eval "$processor_probe"
log "Readiness and Compose-managed processor operation passed."

maintenance=0
log "Update complete: release=$candidate_version revision=$candidate_revision backup=$backup"
for role in BACKEND WEB PROCESSOR SUPERVISOR; do
  log "Selected $role image $(sed -n "s/^YUKI_${role}_IMAGE=//p" "$release_env")"
done
log "Previous release selection is retained at $previous_env"
