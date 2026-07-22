import { ProcessorSupervisor } from './platform/processor/supervisor/index.js';

const supervisor = new ProcessorSupervisor({
  socketPath: required('YUKI_PROCESSOR_SOCKET'),
  socketMode: integer('YUKI_PROCESSOR_SOCKET_MODE', 0o660),
  authenticationToken: required('YUKI_PROCESSOR_TOKEN'),
  workspaceRoot: required('YUKI_PROCESSOR_WORKSPACE_ROOT'),
  maximumInputBytes: integer('YUKI_PROCESSOR_MAXIMUM_INPUT_BYTES', 2 * 1024 * 1024 * 1024),
  maximumOutputBytes: integer('YUKI_PROCESSOR_MAXIMUM_OUTPUT_BYTES', 4 * 1024 * 1024 * 1024),
  maximumOutputFiles: integer('YUKI_PROCESSOR_MAXIMUM_OUTPUT_FILES', 10_000),
  maximumConcurrency: integer('YUKI_PROCESSOR_MAXIMUM_CONCURRENCY', 2),
  requestTimeoutMs: integer('YUKI_PROCESSOR_REQUEST_TIMEOUT_MS', 10 * 60 * 1000),
  runner: {
    image: required('YUKI_PROCESSOR_IMAGE'),
    timeoutMs: integer('YUKI_PROCESSOR_RUN_TIMEOUT_MS', 5 * 60 * 1000),
    terminationGraceMs: integer('YUKI_PROCESSOR_TERMINATION_GRACE_MS', 5_000),
    memory: process.env.YUKI_PROCESSOR_MEMORY ?? '512m',
    cpus: number('YUKI_PROCESSOR_CPUS', 1),
    pidsLimit: integer('YUKI_PROCESSOR_PIDS_LIMIT', 64),
    workspaceSize: process.env.YUKI_PROCESSOR_TMPFS_SIZE ?? '256m',
  },
});

await supervisor.listen();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void supervisor.close().finally(() => process.exit(0));
  });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
