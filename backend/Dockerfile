FROM node:24.18.0-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY frontend/package.json ./frontend/
COPY processor/package.json ./processor/
RUN pnpm install --filter yuki --filter @yuki/backend --frozen-lockfile

COPY backend/migrations ./backend/migrations
COPY backend/src ./backend/src
RUN pnpm --filter @yuki/backend build \
  && pnpm --filter @yuki/backend deploy --legacy --prod /runtime

FROM build AS development

RUN chmod -R a=rX /workspace \
  && mkdir -p /data/yuki \
  && chown node:node /data/yuki

WORKDIR /workspace/backend
USER node
CMD ["node", "dist/api-main.js"]

FROM node:24.18.0-bookworm-slim AS production

ARG VERSION=0.0.0-development
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="Yuki backend" \
  org.opencontainers.image.description="Yuki API, worker, migrations, and maintenance runtime" \
  org.opencontainers.image.source="https://github.com/dexpota/yuki" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production \
  YUKI_VERSION=${VERSION} \
  YUKI_SOURCE_REVISION=${REVISION}
WORKDIR /app

COPY --from=build /runtime ./
RUN chmod -R a=rX /app \
  && mkdir -p /data/yuki \
  && chown node:node /data/yuki

USER node
CMD ["node", "dist/api-main.js"]

FROM docker:29.1.3-cli AS docker-cli

FROM production AS supervisor

LABEL org.opencontainers.image.title="Yuki processor supervisor" \
  org.opencontainers.image.description="Restricted broker for short-lived Yuki processor containers"

USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN docker --version
CMD ["node", "dist/processor-supervisor-main.js"]
