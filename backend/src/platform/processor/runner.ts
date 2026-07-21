import { spawn } from 'node:child_process';
import { isAbsolute, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  MAX_PROCESSOR_MESSAGE_BYTES,
  type ProcessorRequest,
  type ProcessorResponse,
  parseResponse,
  processorFailure,
} from './contract.js';

export interface ProcessorRunnerConfiguration {
  readonly image: string;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly memory: string;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly workspaceSize: string;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly completion: Promise<ProcessResult>;
  writeStdin(message: string): void;
  closeStdin(): void;
  terminate(signal: NodeJS.Signals): void;
}

export interface ProcessorRunnerDependencies {
  readonly startProcess?: (command: string, arguments_: readonly string[]) => RunningProcess;
}

export interface ProcessorFileMount {
  readonly hostPath: string;
  readonly containerPath: `/input/${string}` | `/output/${string}`;
  readonly writable: boolean;
}

export async function runProcessor(
  request: ProcessorRequest,
  configuration: ProcessorRunnerConfiguration,
  dependencies: ProcessorRunnerDependencies = {},
  mounts: readonly ProcessorFileMount[] = [],
): Promise<ProcessorResponse> {
  validateConfiguration(configuration);
  let processHandle: RunningProcess;
  try {
    processHandle = (dependencies.startProcess ?? startNodeProcess)(
      'docker',
      buildDockerArguments(configuration, mounts),
    );
  } catch {
    return unavailableFailure(request.requestId);
  }
  const completion = processHandle.completion.catch(() => ({ code: null, signal: null }));
  const stdout = collectBounded(processHandle.stdout, MAX_PROCESSOR_MESSAGE_BYTES);
  const stderr = collectBounded(processHandle.stderr, 4 * 1024);

  processHandle.writeStdin(`${JSON.stringify(request)}\n`);
  processHandle.closeStdin();

  const timeoutMarker = Symbol('processor-timeout');
  const timeout = deadline(configuration.timeoutMs, timeoutMarker);
  const outcome = await Promise.race([completion, timeout.promise]);
  timeout.cancel();

  if (outcome === timeoutMarker) {
    processHandle.terminate('SIGTERM');
    const graceMarker = Symbol('processor-termination-grace');
    const graceOutcome = await Promise.race([
      completion,
      delay(configuration.terminationGraceMs, graceMarker),
    ]);
    if (graceOutcome === graceMarker) {
      processHandle.terminate('SIGKILL');
      await completion;
    }
    await Promise.all([stdout, stderr]);
    return processorFailure(
      request.requestId,
      'TIMEOUT',
      'File processing exceeded its time limit.',
      true,
    );
  }

  const [capturedStdout] = await Promise.all([stdout, stderr]);
  if (outcome.code !== 0) {
    if (outcome.code === 137 || outcome.signal === 'SIGKILL') {
      return processorFailure(
        request.requestId,
        'RESOURCE_LIMIT',
        'File processing exceeded an assigned resource limit.',
        true,
      );
    }
    return processorFailure(
      request.requestId,
      'TERMINATED',
      'File processing terminated before completion.',
      true,
    );
  }

  if (capturedStdout.exceeded) {
    return processorFailure(
      request.requestId,
      'PROCESSOR_FAILURE',
      'File processor returned an invalid response.',
      false,
    );
  }

  try {
    return parseResponse(JSON.parse(capturedStdout.text.trim()) as unknown, request.requestId);
  } catch {
    return processorFailure(
      request.requestId,
      'PROCESSOR_FAILURE',
      'File processor returned an invalid response.',
      false,
    );
  }
}

function unavailableFailure(requestId: string): ProcessorResponse {
  return processorFailure(requestId, 'PROCESSOR_FAILURE', 'File processor is unavailable.', true);
}

export function buildDockerArguments(
  configuration: ProcessorRunnerConfiguration,
  mounts: readonly ProcessorFileMount[] = [],
): string[] {
  validateConfiguration(configuration);
  validateMounts(mounts);
  const arguments_ = [
    'run',
    '--rm',
    '--interactive',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=65532:65532',
    '--pids-limit',
    String(configuration.pidsLimit),
    '--memory',
    configuration.memory,
    '--memory-swap',
    configuration.memory,
    '--cpus',
    String(configuration.cpus),
    '--tmpfs',
    `/work:rw,noexec,nosuid,nodev,size=${configuration.workspaceSize},uid=65532,gid=65532,mode=0700`,
    '--workdir=/work',
    '--log-driver=none',
  ];
  for (const mount of mounts) {
    arguments_.push(
      '--mount',
      `type=bind,source=${mount.hostPath},target=${mount.containerPath}${mount.writable ? '' : ',readonly'}`,
    );
  }
  arguments_.push(configuration.image);
  return arguments_;
}

function validateConfiguration(configuration: ProcessorRunnerConfiguration): void {
  if (!/@sha256:[a-f0-9]{64}$/.test(configuration.image)) {
    throw new Error('Processor image must be pinned by sha256 digest.');
  }
  if (
    !Number.isSafeInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 1 ||
    !Number.isSafeInteger(configuration.terminationGraceMs) ||
    configuration.terminationGraceMs < 1 ||
    !Number.isSafeInteger(configuration.pidsLimit) ||
    configuration.pidsLimit < 1 ||
    !Number.isFinite(configuration.cpus) ||
    configuration.cpus <= 0 ||
    !/^\d+[kmg]$/i.test(configuration.memory) ||
    !/^\d+[kmg]$/i.test(configuration.workspaceSize)
  ) {
    throw new Error('Processor resource limits are invalid.');
  }
}

function validateMounts(mounts: readonly ProcessorFileMount[]): void {
  const targets = new Set<string>();
  for (const mount of mounts) {
    const normalizedTarget = posix.normalize(mount.containerPath);
    const targetIsAllowed = /^\/(input|output)\/[A-Za-z0-9._/-]+$/.test(mount.containerPath);
    const isInput = mount.containerPath.startsWith('/input/');
    const modeIsAllowed = (isInput && !mount.writable) || (!isInput && mount.writable);
    if (
      !isAbsolute(mount.hostPath) ||
      /[,\r\n]/.test(mount.hostPath) ||
      !targetIsAllowed ||
      normalizedTarget !== mount.containerPath ||
      mount.containerPath.includes('/../') ||
      !modeIsAllowed ||
      targets.has(mount.containerPath)
    ) {
      throw new Error('Processor file mount is invalid.');
    }
    targets.add(mount.containerPath);
  }
}

function startNodeProcess(command: string, arguments_: readonly string[]): RunningProcess {
  const child = spawn(command, arguments_, { stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    writeStdin: (message) => child.stdin.write(message),
    closeStdin: () => child.stdin.end(),
    terminate: (signal) => child.kill(signal),
  };
}

async function collectBounded(
  stream: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
): Promise<{ readonly text: string; readonly exceeded: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes <= maximumBytes) {
      chunks.push(buffer);
    } else {
      exceeded = true;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), exceeded };
}

function deadline<T>(
  milliseconds: number,
  value: T,
): { readonly promise: Promise<T>; cancel(): void } {
  let timeout: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((resolve) => {
    timeout = setTimeout(resolve, milliseconds, value);
  });
  return { promise, cancel: () => clearTimeout(timeout) };
}
