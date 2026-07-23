import { createConnection, createServer } from 'node:net';

const listenPort = integer('YUKI_PROCESSOR_BRIDGE_PORT');
const targetPort = integer('YUKI_PROCESSOR_TARGET_PORT');
const targetHost = process.env.YUKI_PROCESSOR_TARGET_HOST ?? 'host.docker.internal';

await waitForTarget();

const server = createServer((downstream) => {
  downstream.pause();
  const upstream = createConnection({ host: targetHost, port: targetPort });
  const close = () => {
    downstream.destroy();
    upstream.destroy();
  };
  downstream.on('error', close);
  upstream.on('error', close);
  upstream.once('connect', () => {
    downstream.resume();
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(listenPort, '0.0.0.0', resolve);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

async function waitForTarget() {
  for (;;) {
    try {
      await connectOnce();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: targetHost, port: targetPort });
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

function integer(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${name} must be a valid TCP port`);
  return value;
}
