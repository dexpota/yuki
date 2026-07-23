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
processor_transport=${YUKI_PROCESSOR_TRANSPORT:-tcp}
if [ "$processor_transport" = "tcp" ]; then
  unset YUKI_PROCESSOR_SOCKET
  export YUKI_PROCESSOR_HOST=127.0.0.1
  export YUKI_PROCESSOR_PORT="${YUKI_PROCESSOR_PORT:-3210}"
elif [ "$processor_transport" = "socket" ]; then
  unset YUKI_PROCESSOR_HOST YUKI_PROCESSOR_PORT
  export YUKI_PROCESSOR_SOCKET="$repository_root/deploy/run/processor.sock"
  export YUKI_PROCESSOR_SOCKET_MODE=438
else
  echo "YUKI_PROCESSOR_TRANSPORT must be tcp or socket" >&2
  exit 1
fi
export YUKI_PROCESSOR_WORKSPACE_ROOT="${YUKI_PROCESSOR_WORKSPACE_ROOT:-/tmp/yuki-processor-supervisor}"

exec node "$repository_root/backend/dist/processor-supervisor-main.js"
