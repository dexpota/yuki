import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [supervisorImage, backendImage, processorImage] = process.argv.slice(2);
if (!supervisorImage || !backendImage || !processorImage) {
  process.stderr.write(
    'Usage: node deploy/smoke-compose-supervisor.mjs SUPERVISOR BACKEND PROCESSOR\n',
  );
  process.exit(2);
}

const suffix = randomUUID().slice(0, 12);
const socketVolume = `yuki_smoke_socket_${suffix}`;
const workspaceVolume = `yuki_smoke_jobs_${suffix}`;
const supervisorName = `yuki-smoke-supervisor-${suffix}`;
const token = `yuki-smoke-token-${randomUUID()}`;
const socketPath = '/run/yuki/processor.sock';
const docker = async (...args) => (await execute('docker', args)).stdout.trim();

try {
  const processorId = await docker('image', 'inspect', '--format', '{{.Id}}', processorImage);
  await docker('volume', 'create', socketVolume);
  await docker('volume', 'create', workspaceVolume);
  await docker(
    'run',
    '--detach',
    '--name',
    supervisorName,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'DAC_OVERRIDE',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '0:0',
    '--mount',
    'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount',
    `type=volume,source=${socketVolume},target=/run/yuki`,
    '--mount',
    `type=volume,source=${workspaceVolume},target=/processor-workspace`,
    '--env',
    `YUKI_PROCESSOR_TOKEN=${token}`,
    '--env',
    `YUKI_PROCESSOR_SOCKET=${socketPath}`,
    '--env',
    'YUKI_PROCESSOR_SOCKET_MODE=438',
    '--env',
    `YUKI_PROCESSOR_IMAGE=${processorId}`,
    '--env',
    'YUKI_PROCESSOR_WORKSPACE_ROOT=/processor-workspace',
    '--env',
    `YUKI_PROCESSOR_WORKSPACE_VOLUME=${workspaceVolume}`,
    supervisorImage,
  );

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await docker(
        'exec',
        supervisorName,
        'node',
        '-e',
        "const s=require('node:net').createConnection('/run/yuki/processor.sock');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
      );
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error('Supervisor did not create its authenticated socket.');

  const clientProgram = `
    import { Readable } from 'node:stream';
    import { ProcessorSupervisorClient } from './dist/platform/processor/supervisor/client.js';
    const input = 'G1 X1\\n';
    const client = new ProcessorSupervisorClient({
      socketPath: '${socketPath}', authenticationToken: process.env.YUKI_PROCESSOR_TOKEN,
      responseWorkspaceRoot: '/tmp/responses', maximumResponseBytes: 1048576,
      maximumOutputFiles: 10, timeoutMs: 30000,
    });
    const request = (id) => client.execute({
      requestId: id, operation: 'parse-gcode-facts', inputBytes: Buffer.byteLength(input),
      input: Readable.from([input]),
      limits: { maximumInputBytes: 1024, maximumLines: 100, maximumLineBytes: 100,
        maximumSegments: 100, maximumMetadataEntries: 10 },
    });
    const results = await Promise.all([request('job-one'), request('job-two')]);
    for (const result of results) {
      if (!result.processorResult?.facts) throw new Error('Missing processor facts');
      await result.cleanup();
    }
    const geometry = 'solid triangle\\nfacet normal 0 0 1\\nouter loop\\nvertex 0 0 0\\nvertex 1 0 0\\nvertex 0 1 0\\nendloop\\nendfacet\\nendsolid triangle\\n';
    let preview;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        preview = await client.execute({
          requestId: 'preview-job-' + attempt, operation: 'generate-preview', format: 'stl',
          inputBytes: Buffer.byteLength(geometry), input: Readable.from([geometry]),
          limits: { maximumInputBytes: 1048576, maximumOutputBytes: 16777216,
            maximumTriangles: 10000, maximumLayers: 1000, maximumSegments: 100000 },
        });
        break;
      } catch (error) {
        if (error.code !== 'BUSY' || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    if (!preview || preview.outputs.length < 1) throw new Error('Missing generated preview');
    await preview.cleanup();
    process.stdout.write('Two isolated processor jobs and one generated preview completed.\\n');
  `;
  const result = await docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:size=32m,mode=1777',
    '--mount',
    `type=volume,source=${socketVolume},target=/run/yuki,readonly`,
    '--env',
    `YUKI_PROCESSOR_TOKEN=${token}`,
    '--entrypoint',
    'node',
    backendImage,
    '--input-type=module',
    '--eval',
    clientProgram,
  );
  if (!result.includes('Two isolated processor jobs and one generated preview completed.'))
    throw new Error('Processor jobs did not complete.');
  await docker(
    'exec',
    supervisorName,
    'node',
    '-e',
    "import('node:fs/promises').then(async fs=>{if((await fs.readdir('/processor-workspace')).length)process.exit(1)})",
  );
  process.stdout.write(`${result}\n`);
} finally {
  await docker('rm', '--force', supervisorName).catch(() => undefined);
  await docker('volume', 'rm', socketVolume).catch(() => undefined);
  await docker('volume', 'rm', workspaceVolume).catch(() => undefined);
}
