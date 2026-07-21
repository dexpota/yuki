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
WORKDIR /workspace/frontend
CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "5173"]
