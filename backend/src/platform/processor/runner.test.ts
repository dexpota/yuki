import { describe, expect, it } from 'vitest';

import { probeRequest } from './contract.js';
import {
  buildDockerArguments,
  type ProcessorRunnerConfiguration,
  type ProcessResult,
  type RunningProcess,
  runProcessor,
} from './runner.js';

const configuration: ProcessorRunnerConfiguration = {
  image: `yuki-processor@sha256:${'a'.repeat(64)}`,
  timeoutMs: 10,
  terminationGraceMs: 10,
  memory: '512m',
  cpus: 1,
  pidsLimit: 64,
  workspaceSize: '256m',
};

describe('restricted processor runner', () => {
  it('applies the required container restrictions', () => {
    const arguments_ = buildDockerArguments(configuration, [
      {
        hostPath: '/var/lib/yuki/staging/request-1/source.stl',
        containerPath: '/input/source.stl',
        writable: false,
      },
      {
        hostPath: '/var/lib/yuki/staging/request-1/output',
        containerPath: '/output/result',
        writable: true,
      },
    ]);
    expect(arguments_).toEqual(
      expect.arrayContaining([
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65532:65532',
        '--pids-limit',
        '--memory',
        '--cpus',
        '--tmpfs',
        'type=bind,source=/var/lib/yuki/staging/request-1/source.stl,target=/input/source.stl,readonly',
        'type=bind,source=/var/lib/yuki/staging/request-1/output,target=/output/result',
      ]),
    );
  });

  it('rejects writable input mounts and traversal targets', () => {
    expect(() =>
      buildDockerArguments(configuration, [
        { hostPath: '/tmp/source', containerPath: '/input/../escape', writable: true },
      ]),
    ).toThrow('Processor file mount is invalid.');
  });

  it('terminates and then kills a processor that exceeds its deadline', async () => {
    const process = hangingProcess();
    const response = await runProcessor(probeRequest('timeout-1'), configuration, {
      startProcess: () => process.handle,
    });

    expect(response).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not expose stderr or process details in a termination failure', async () => {
    const response = await runProcessor(probeRequest('failure-1'), configuration, {
      startProcess: () =>
        completedProcess(
          { code: 1, signal: null },
          '',
          '/private/input/customer-file.stl: converter secret stack trace',
        ),
    });

    expect(response).toEqual({
      protocolVersion: 1,
      requestId: 'failure-1',
      ok: false,
      error: {
        code: 'TERMINATED',
        message: 'File processing terminated before completion.',
        retryable: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain('customer-file');
  });

  it('sanitizes a failure to start the container runtime', async () => {
    const response = await runProcessor(probeRequest('unavailable-1'), configuration, {
      startProcess: () => {
        throw new Error('spawn docker ENOENT at /private/runtime');
      },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'PROCESSOR_FAILURE', message: 'File processor is unavailable.' },
    });
    expect(JSON.stringify(response)).not.toContain('/private/runtime');
  });

  it('rejects an unsupported response protocol version', async () => {
    const response = await runProcessor(probeRequest('version-1'), configuration, {
      startProcess: () =>
        completedProcess(
          { code: 0, signal: null },
          '{"protocolVersion":2,"requestId":"version-1","ok":true,"result":{}}',
        ),
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'PROCESSOR_FAILURE' } });
  });
});

function completedProcess(result: ProcessResult, stdout: string, stderr = ''): RunningProcess {
  return {
    stdout: chunks(stdout),
    stderr: chunks(stderr),
    completion: Promise.resolve(result),
    writeStdin: () => {},
    closeStdin: () => {},
    terminate: () => {},
  };
}

function hangingProcess(): { readonly handle: RunningProcess; readonly signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  let resolveCompletion: (result: ProcessResult) => void = () => {};
  const completion = new Promise<ProcessResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const handle: RunningProcess = {
    stdout: chunks(''),
    stderr: chunks(''),
    completion,
    writeStdin: () => {},
    closeStdin: () => {},
    terminate: (signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') resolveCompletion({ code: null, signal });
    },
  };
  return { handle, signals };
}

async function* chunks(value: string): AsyncGenerator<string> {
  if (value) yield value;
}
