FROM node:24.18.0-bookworm-slim

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
RUN pnpm --filter @yuki/backend build
RUN chmod -R a=rX /workspace \
  && mkdir -p /data/yuki \
  && chown node:node /data/yuki

WORKDIR /workspace/backend
USER node
CMD ["node", "dist/api-main.js"]
