import { createServer } from 'node:http';

const port = Number(process.env.VIRTUAL_OCTOPRINT_PORT ?? '5000');
const apiKey = process.env.VIRTUAL_OCTOPRINT_API_KEY ?? 'acceptance-api-key';
const printerName = process.env.VIRTUAL_OCTOPRINT_NAME ?? 'Virtual OctoPrint';
const snapshot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const state = {
  operationalState: 'Operational',
  path: null,
  progress: null,
  elapsed: null,
  remaining: null,
};
let starts = 0;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.headers['x-api-key'] !== apiKey)
    return json(response, 401, { error: 'unauthorized' });

  if (request.method === 'GET' && url.pathname === '/api/connection')
    return json(response, 200, {
      current: { state: state.operationalState, version: '1.10.3-acceptance' },
    });
  if (request.method === 'GET' && url.pathname === '/api/job')
    return json(response, 200, {
      state: state.operationalState,
      job: {
        file: {
          name: state.path?.split('/').at(-1) ?? null,
          path: state.path,
          origin: state.path ? 'local' : null,
        },
      },
      progress: {
        completion: state.progress,
        printTime: state.elapsed,
        printTimeLeft: state.remaining,
      },
    });
  if (request.method === 'GET' && url.pathname === '/api/printer')
    return json(response, 200, {
      state: { text: state.operationalState },
      temperature: {
        tool0: { actual: 205.2, target: state.path ? 210 : 0 },
        bed: { actual: 59.8, target: state.path ? 60 : 0 },
      },
    });
  if (request.method === 'POST' && url.pathname === '/api/job') {
    const command = await jsonBody(request);
    if (command.command === 'pause' && command.action === 'pause')
      state.operationalState = 'Paused';
    if (command.command === 'pause' && command.action === 'resume')
      state.operationalState = 'Printing';
    if (command.command === 'cancel') {
      state.operationalState = 'Operational';
      state.path = null;
      state.progress = null;
      state.elapsed = null;
      state.remaining = null;
    }
    return empty(response);
  }
  if (
    request.method === 'POST' &&
    ['/api/printer/tool', '/api/printer/bed', '/api/printer/printhead'].includes(url.pathname)
  ) {
    await drain(request);
    return empty(response);
  }
  if (request.method === 'GET' && url.pathname === '/api/settings')
    return json(response, 200, { webcam: { snapshotUrl: '/snapshot.png' } });
  if (request.method === 'GET' && url.pathname === '/snapshot.png') {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': snapshot.byteLength });
    return response.end(snapshot);
  }
  if (request.method === 'POST' && url.pathname === '/api/files/local') {
    await drain(request);
    return json(response, 201, { done: true });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/files/local/'))
    return json(response, 200, {});
  if (request.method === 'POST' && url.pathname.startsWith('/api/files/local/')) {
    const command = await jsonBody(request);
    if (command.command === 'select' && command.print === true) {
      starts += 1;
      state.path = decodePath(url.pathname.slice('/api/files/local/'.length));
      state.operationalState = 'Printing';
      state.progress = 12.5;
      state.elapsed = 45;
      state.remaining = 315;
      if (starts >= 2)
        setTimeout(() => {
          state.operationalState = 'Operational';
          state.progress = 100;
          state.elapsed = 360;
          state.remaining = 0;
        }, 20_000);
    }
    return empty(response);
  }
  await drain(request);
  return json(response, 404, { error: 'not_found' });
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`${printerName} listening on ${port}\n`);
});

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function drain(request) {
  for await (const _chunk of request) {
    // Consume bounded acceptance requests so callers can reuse the connection.
  }
}

function decodePath(value) {
  return value
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join('/');
}

function json(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.byteLength,
  });
  response.end(bytes);
}

function empty(response) {
  response.writeHead(204);
  response.end();
}
