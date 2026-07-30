# MVP release acceptance

O05 is the release gate for the first Yuki MVP. A release candidate passes only
when the repository checks, the clean-Compose browser workflow, the restart and
migration-replay phase, and the operational rehearsals below all pass from the
same commit.

## Automated clean-Compose workflow

Run:

```sh
pnpm test:acceptance
```

The runner creates disposable PostgreSQL and storage volumes, a restricted
processor supervisor, the production-shaped API/worker/web/proxy topology, and
two independent virtual OctoPrint contracts. Its `outbound` Docker network is
internal during acceptance, which prevents internet access while preserving
printer traffic.

After the browser workflow, the runner restarts API and worker, replays all
migrations, recreates both candidate services, waits for readiness, and uses
the saved owner session to verify that models, versions, queues, print notes,
and print photos survived. Failure artifacts are retained under
`acceptance/test-results/`; the Compose volumes are removed unless
`YUKI_ACCEPTANCE_KEEP=1` is intentionally set.

## Criterion matrix

| # | MVP criterion | Release evidence |
| --- | --- | --- |
| 1 | Sign in and configure local storage | Owner setup/sign-out/sign-in browser project; installation settings API/UI tests; default local BlobStore in the clean Compose topology |
| 2 | Import multipart files or ZIP | Browser uploads a generated ZIP containing STL and G-code through the real worker and restricted archive/detection processor |
| 3 | Catalogue, tags, search, 3D preview | Browser tags and searches the imported model, then renders the generated interactive GLB |
| 4 | Immutable second version and original retrieval | Browser publishes v2, restores v1, and verifies the retained v1 ZIP byte-for-byte through its authenticated download |
| 5 | Export and re-import relationships | Browser downloads the durable export, re-imports it, and checks two versions, tags, and original assets |
| 6 | Two OctoPrint printers | Browser verifies and saves two separately stateful virtual OctoPrint endpoints through real gateway traffic |
| 7 | G-code preview or unsupported state | Browser renders the generated read-only G-code layer preview; focused processor/UI tests cover explicit unsupported states |
| 8 | Known incompatibility blocks sending | The same G-code is compatible with printer A and hard-incompatible with printer B's smaller build volume; B has no start action |
| 9 | Independent queues | The browser adds the asset separately to both printer queues and verifies their distinct results |
| 10 | Confirmed remote start | Printer A requires the expiring physical-action confirmation before the worker uploads and starts the job |
| 11 | Monitor state, progress, temperatures, webcam | Browser observes virtual OctoPrint state/temperature/progress and a same-origin proxied snapshot |
| 12 | Confirmed pause, resume, cancel | Browser accepts a fresh confirmation for each action and observes each resulting state |
| 13 | Completion/failure notification | Virtual OctoPrint reports a completed remote job and the browser verifies its transactional in-app completion notification |
| 14 | Outcome, notes, photo history | Browser records notes, corrects the result outcome, uploads a PNG, and verifies the rendered history |
| 15 | Restart persistence | Post-restart/migration phase re-verifies catalogue versions, queues, notes, and photo |
| 16 | No mandatory cloud dependency | The full core workflow passes with the acceptance `outbound` network set to `internal: true`; external webhook and S3 remain optional |

## Additional release checks

Run the complete repository verification:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
git diff --check
```

Run the backup/restore rehearsal documented in `deploy/README.md`. The O03
rehearsal must restore the candidate's database and blob inventory into
isolated volumes, apply migrations, pass integrity verification, and reach API
readiness. For the first release there is no earlier supported release image;
the acceptance migration replay is the upgrade baseline. Subsequent releases
must additionally restore the latest supported release backup and upgrade it
with the candidate images.

Any unresolved critical defect, undecided MVP item, failed database integration
suite, failed processor isolation probe, or failed criterion above blocks the
release.
