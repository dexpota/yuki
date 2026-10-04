const developmentValues = new Set([
  'yuki-development-only',
  'CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=',
  'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhY=',
  'ZGV2ZWxvcG1lbnQtb25seS1wcm9jZXNzb3ItdG9rZW4=',
  'yuki-development-minio-secret',
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (developmentValues.has(value)) throw new Error(`${name} contains a development value`);
  return value;
}

function key(name: string): string {
  const value = required(name);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32)
    throw new Error(`${name} must be a base64-encoded 32-byte secret`);
  return value;
}

try {
  if (process.env.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production');
  const password = required('YUKI_POSTGRES_PASSWORD');
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(required('YUKI_DATABASE_URL'));
  } catch {
    throw new Error('YUKI_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    databaseUrl.hostname !== 'postgres' ||
    (databaseUrl.port && databaseUrl.port !== '5432') ||
    decodeURIComponent(databaseUrl.password) !== password ||
    decodeURIComponent(databaseUrl.username) !== (process.env.YUKI_POSTGRES_USER || 'yuki') ||
    databaseUrl.pathname !== `/${process.env.YUKI_POSTGRES_DB || 'yuki'}` ||
    databaseUrl.search !== '' ||
    databaseUrl.hash !== ''
  )
    throw new Error('YUKI_DATABASE_URL must match the Compose PostgreSQL service and password');
  if (
    required('YUKI_RELEASE_VERSION') !== process.env.YUKI_VERSION ||
    required('YUKI_RELEASE_REVISION') !== process.env.YUKI_SOURCE_REVISION
  )
    throw new Error('Selected release does not match the backend image identity');
  if (key('YUKI_CSRF_KEY') === key('YUKI_MASTER_KEY'))
    throw new Error('YUKI_CSRF_KEY and YUKI_MASTER_KEY must be independent');
  if (Buffer.byteLength(required('YUKI_PROCESSOR_TOKEN')) < 32)
    throw new Error('YUKI_PROCESSOR_TOKEN must contain at least 32 bytes');
  const origins = required('YUKI_ALLOWED_ORIGINS').split(',');
  if (
    origins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          !['http:', 'https:'].includes(url.protocol) ||
          !!url.username ||
          !!url.password ||
          url.pathname !== '/' ||
          !!url.search ||
          !!url.hash
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('YUKI_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  for (const role of ['BACKEND', 'WEB', 'PROCESSOR', 'SUPERVISOR']) {
    const reference = required(`YUKI_${role}_IMAGE`);
    if (
      !new RegExp(`^ghcr\\.io/dexpota/yuki-${role.toLowerCase()}@sha256:[a-f0-9]{64}$`).test(
        reference,
      )
    )
      throw new Error(`YUKI_${role}_IMAGE must be an immutable Yuki image reference`);
  }
  const volume = required('YUKI_PROCESSOR_WORKSPACE_VOLUME');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(volume))
    throw new Error('YUKI_PROCESSOR_WORKSPACE_VOLUME is invalid');
  const storage = process.env.YUKI_STORAGE_BACKEND ?? 'local';
  if (storage === 's3') {
    for (const name of [
      'YUKI_S3_ENDPOINT',
      'YUKI_S3_REGION',
      'YUKI_S3_BUCKET',
      'YUKI_S3_ACCESS_KEY_ID',
      'YUKI_S3_SECRET_ACCESS_KEY',
    ])
      required(name);
  } else if (storage !== 'local') throw new Error('YUKI_STORAGE_BACKEND must be local or s3');
  process.stdout.write('Production configuration accepted.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Invalid configuration'}\n`);
  process.exitCode = 1;
}
