#!/bin/sh

set -eu

role=${1:-}
image=${2:-}

if [ -z "$role" ] || [ -z "$image" ]; then
  echo "usage: $0 <backend|web|processor> <image>" >&2
  exit 64
fi

assert_metadata() {
  expected_user=$1
  actual_user=$(docker image inspect --format '{{.Config.User}}' "$image")
  if [ "$actual_user" != "$expected_user" ]; then
    echo "$role image user is '$actual_user', expected '$expected_user'." >&2
    exit 1
  fi

  version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")

  test -n "$version"
  test -n "$revision"
  test "$source" = "https://github.com/dexpota/yuki"
  if [ -n "${YUKI_EXPECTED_VERSION:-}" ]; then test "$version" = "$YUKI_EXPECTED_VERSION"; fi
  if [ -n "${YUKI_EXPECTED_REVISION:-}" ]; then test "$revision" = "$YUKI_EXPECTED_REVISION"; fi
}

smoke_backend() {
  assert_metadata node
  docker run --rm \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m,mode=1777 \
    --entrypoint node \
    "$image" \
    --input-type=module \
    --eval "
      import { access } from 'node:fs/promises';
      import { hash, verify } from 'argon2';
      const encoded = await hash('release-image-smoke-password');
      if (!(await verify(encoded, 'release-image-smoke-password'))) process.exit(1);
      await Promise.all([
        access('dist/api-main.js'),
        access('dist/worker-main.js'),
        access('dist/platform/database/migrate-main.js'),
        access('dist/platform/maintenance/main.js'),
        access('migrations/0001_durable_jobs.up.sql'),
      ]);
    "
}

smoke_web() {
  assert_metadata 65532:65532
  container=$(docker run --detach \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m,mode=1777 \
    "$image")
  trap 'docker rm --force "$container" >/dev/null 2>&1 || true' EXIT HUP INT TERM

  attempts=0
  until docker exec "$container" wget -qO- http://127.0.0.1:8080/ >/tmp/yuki-web-index.html; do
    if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != "true" ]; then
      docker logs "$container" >&2
      exit 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      docker logs "$container" >&2
      exit 1
    fi
    sleep 1
  done

  docker exec "$container" wget -qO- http://127.0.0.1:8080/models/release-smoke \
    >/tmp/yuki-web-route.html
  cmp /tmp/yuki-web-index.html /tmp/yuki-web-route.html
  route_headers=$(docker exec "$container" wget --server-response --spider \
    http://127.0.0.1:8080/models/release-smoke 2>&1)
  printf '%s\n' "$route_headers" | grep -i 'cache-control: no-cache' >/dev/null

  asset=$(sed -n 's|.*src="\(/assets/[^"]*\.js\)".*|\1|p' /tmp/yuki-web-index.html | head -1)
  test -n "$asset"
  headers=$(docker exec "$container" wget --server-response --spider "http://127.0.0.1:8080$asset" 2>&1)
  printf '%s\n' "$headers" | grep -i 'cache-control: public, max-age=31536000, immutable' >/dev/null

  docker rm --force "$container" >/dev/null
  trap - EXIT HUP INT TERM
}

smoke_processor() {
  assert_metadata 65532:65532

  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --tmpfs /work:size=16m,uid=65532,gid=65532,mode=0700 \
    --entrypoint /bin/sh \
    "$image" \
    -eu -c 'test -r /licenses/license.occt-import-js.txt; test -r /licenses/license.occt.txt; test -r /licenses/SOURCE.md'

  response=$(docker run --rm -i \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --tmpfs /work:size=16m,mode=0700 \
    "$image" <<'EOF'
{"protocolVersion":1,"requestId":"release-smoke","operation":"probe"}
EOF
  )
  printf '%s\n' "$response" | grep '"ok":true' >/dev/null
  printf '%s\n' "$response" | grep '"generate-preview"' >/dev/null
  if [ -n "${YUKI_EXPECTED_VERSION:-}" ]; then
    printf '%s\n' "$response" | grep "\"processorVersion\":\"$YUKI_EXPECTED_VERSION\"" >/dev/null
  fi

  response=$(docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 512m \
    --cpus 1 \
    --tmpfs /work:size=16m,uid=65532,gid=65532,mode=0700 \
    --tmpfs /input:size=1m,uid=65532,gid=65532,mode=0700 \
    --tmpfs /output:size=16m,uid=65532,gid=65532,mode=0700 \
    --entrypoint /bin/sh \
    "$image" \
    -eu -c '
      cp /app/node_modules/occt-import-js/test/testfiles/cube-fcstd/cube.step /input/source
      printf "%s\n" '\''{"protocolVersion":1,"requestId":"step-release-smoke","operation":"generate-preview","payload":{"version":1,"inputPath":"/input/source","outputDirectory":"/output/preview","format":"step","limits":{"maximumInputBytes":1048576,"maximumOutputBytes":16777216,"maximumTriangles":10000,"maximumLayers":1000,"maximumSegments":100000}}}'\'' | node /app/dist/main.js
    ')
  printf '%s\n' "$response" | grep '"ok":true' >/dev/null
  printf '%s\n' "$response" | grep '"status":"ready"' >/dev/null
  printf '%s\n' "$response" | grep '"kind":"geometry"' >/dev/null
}

case "$role" in
  backend) smoke_backend ;;
  web) smoke_web ;;
  processor) smoke_processor ;;
  *)
    echo "Unknown image role '$role'." >&2
    exit 64
    ;;
esac
