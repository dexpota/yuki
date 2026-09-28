FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY processor/package.json processor/tsconfig.json processor/tsconfig.build.json ./processor/
COPY processor/src ./processor/src
RUN pnpm install --filter yuki --filter @yuki/processor --frozen-lockfile \
  && pnpm --filter @yuki/processor build \
  && pnpm --filter @yuki/processor deploy --legacy --prod /runtime

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS production

ARG VERSION=0.0.0-development
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="Yuki restricted processor" \
  org.opencontainers.image.description="Isolated processor for untrusted 3D model, archive, image, and G-code files" \
  org.opencontainers.image.source="https://github.com/dexpota/yuki" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production \
  YUKI_VERSION=${VERSION} \
  YUKI_SOURCE_REVISION=${REVISION}
WORKDIR /app
COPY --from=build /runtime ./
COPY --from=build \
  /runtime/node_modules/occt-import-js/dist/license.occt-import-js.txt \
  /runtime/node_modules/occt-import-js/dist/license.occt.txt \
  /licenses/
COPY docs/ADR-0005-step-preview-conversion.md /licenses/SOURCE.md
RUN chmod -R a=rX /app /licenses
USER 65532:65532
ENTRYPOINT ["node", "/app/dist/main.js"]
