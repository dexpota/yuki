#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -f "$repository_root/deploy/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repository_root/deploy/.env"
  set +a
fi

: "${YUKI_PROCESSOR_TOKEN:?Set YUKI_PROCESSOR_TOKEN to at least 32 bytes}"

processor_image=${YUKI_PROCESSOR_IMAGE:-$(docker image inspect --format '{{.Id}}' yuki-processor:development)}

export YUKI_PROCESSOR_IMAGE="$processor_image"
export YUKI_PROCESSOR_SOCKET="$repository_root/deploy/run/processor.sock"
export YUKI_PROCESSOR_SOCKET_MODE=438
export YUKI_PROCESSOR_WORKSPACE_ROOT="${YUKI_PROCESSOR_WORKSPACE_ROOT:-/tmp/yuki-processor-supervisor}"

exec node "$repository_root/backend/dist/processor-supervisor-main.js"
