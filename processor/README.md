# Restricted processor

The processor accepts exactly one JSON request on standard input and writes exactly one JSON response
to standard output. Both use protocol version `1`. The initial `probe` operation verifies deployment;
archive, geometry, image, and G-code operations are added by their owning implementation tasks.

The backend launches a new container for each request. Its generated Docker arguments enforce:

- no network, dropped capabilities, `no-new-privileges`, and a non-root user;
- a read-only root filesystem and a fresh, size-bounded `/work` tmpfs;
- explicit CPU, memory, and process-count limits;
- only operation-specific read-only input mounts and one output mount;
- a host-side deadline followed by `SIGTERM` and then `SIGKILL`.

The image itself cannot enforce host resource limits or networking. It must only be launched through the
backend runner (or with equivalent controls). Build from the repository root:

```sh
docker build -f processor/Dockerfile -t yuki-processor:local .
```

Never place secrets in a request or mount them into the processor. Error responses use fixed messages
and do not include stderr, input content, host paths, stack traces, or converter output.
