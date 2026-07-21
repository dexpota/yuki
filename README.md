# Yuki

Yuki is a self-hosted catalogue and print organizer for 3D-printable models.

## Development prerequisites

- NVM
- Node.js and pnpm versions declared by `.nvmrc` and `package.json`

```sh
nvm install
corepack enable pnpm
pnpm install --frozen-lockfile
```

## Workspace checks

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

Product scope, architecture, and task dependencies are defined in
`MVP-REQUIREMENTS.md`, `ARCHITECTURE.md`, and `IMPLEMENTATION-PLAN.md`.
