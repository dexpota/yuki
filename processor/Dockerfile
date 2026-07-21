FROM node:24.18.0-alpine3.23 AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY processor/package.json processor/tsconfig.json processor/tsconfig.build.json ./processor/
COPY processor/src ./processor/src
RUN pnpm install --filter yuki --filter @yuki/processor --frozen-lockfile \
  && pnpm --filter @yuki/processor build

FROM node:24.18.0-alpine3.23
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=65532:65532 /build/processor/dist ./dist
USER 65532:65532
ENTRYPOINT ["node", "/app/dist/main.js"]
