FROM node:24.18.0-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json frontend/tsconfig.json frontend/tsconfig.build.json frontend/vite.config.ts frontend/index.html ./frontend/
COPY processor/package.json ./processor/
RUN pnpm install --filter yuki --filter @yuki/frontend --frozen-lockfile

COPY frontend/src ./frontend/src
RUN chmod -R a=rX /workspace \
  && mkdir -p /workspace/frontend/node_modules/.vite \
  && chown -R node:node /workspace/frontend/node_modules/.vite
WORKDIR /workspace/frontend
USER node
CMD ["node", "node_modules/vite/bin/vite.js", "--configLoader", "runner", "--host", "0.0.0.0", "--port", "5173"]
