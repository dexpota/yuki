# Browser acceptance tests

The acceptance package runs Playwright against a disposable, clean Docker
Compose installation. It creates the first owner through the browser, verifies
sign-out and sign-in, saves an authenticated browser state, and exposes the
`authenticatedPage` fixture for feature scenarios.

Install Playwright's Chromium once after installing workspace dependencies:

```sh
pnpm --filter @yuki/acceptance exec playwright install chromium
```

Run the clean-install suite from the repository root:

```sh
pnpm test:acceptance
```

The runner builds and starts a digest-resolved restricted processor supervisor
plus a uniquely named Compose project, waits for API readiness, and runs
Playwright against two stateful virtual OctoPrint contracts on an
internet-isolated outbound network. It then restarts API/worker, replays
migrations, recreates the candidate services, and runs the persistence checks
before removing its containers and disposable volumes. It never uses
`deploy/.env`.
Override `YUKI_ACCEPTANCE_HTTP_PORT` or `YUKI_ACCEPTANCE_PROCESSOR_PORT` if a
default port is occupied. Set `YUKI_ACCEPTANCE_KEEP=1` only when intentionally
retaining a failed disposable project for inspection.

For an already running installation, set `YUKI_ACCEPTANCE_BASE_URL` and run
`pnpm --filter @yuki/acceptance acceptance`. This mode expects a clean database
for the owner-setup project.

## Production release gate

The production release workflow runs `run-production-release.sh` on native
`linux/amd64` and `linux/arm64` runners. It takes the candidate
`release-images.json` and the latest supported release's manifest. The runner
uses digest-pinned production images for Yuki services, creates a clean
candidate installation, exercises the full browser workflow, restarts services
and replays migrations, verifies a full backup by restoring it into clean
volumes, then upgrades a prior supported installation with the one-shot update
workflow. Compose logs and Playwright failure artifacts are retained for each
platform. The candidate manifest is attached to its prerelease only after both
platform jobs pass.
