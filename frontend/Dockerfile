FROM node:24.18.0-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json frontend/tsconfig.json frontend/tsconfig.build.json frontend/vite.config.ts frontend/index.html ./frontend/
COPY processor/package.json ./processor/
RUN pnpm install --filter yuki --filter @yuki/frontend --frozen-lockfile

COPY frontend/src ./frontend/src
RUN pnpm --filter @yuki/frontend build

FROM build AS development

RUN chmod -R a=rX /workspace \
  && mkdir -p /workspace/frontend/node_modules/.vite \
  && chown -R node:node /workspace/frontend/node_modules/.vite
WORKDIR /workspace/frontend
USER node
CMD ["node", "node_modules/vite/bin/vite.js", "--configLoader", "runner", "--host", "0.0.0.0", "--port", "5173"]

FROM caddy:2.10.0-alpine AS production

ARG VERSION=0.0.0-development
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="Yuki web" \
  org.opencontainers.image.description="Compiled Yuki browser application" \
  org.opencontainers.image.source="https://github.com/dexpota/yuki" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.created="${CREATED}"

ENV YUKI_VERSION=${VERSION} \
  YUKI_SOURCE_REVISION=${REVISION} \
  XDG_CONFIG_HOME=/tmp/caddy/config \
  XDG_DATA_HOME=/tmp/caddy/data

COPY frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/frontend/dist /srv
RUN setcap -r /usr/bin/caddy \
  && chmod -R a=rX /etc/caddy/Caddyfile /srv

USER 65532:65532
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
