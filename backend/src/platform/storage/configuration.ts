import { ConfigurationError } from '../configuration.js';

export interface LocalStorageConfiguration {
  readonly backend: 'local';
  readonly root: string;
}

export interface S3StorageConfiguration {
  readonly backend: 's3';
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly multipartThresholdBytes: number;
  readonly signedDownloadTtlSeconds: number;
}

export type StorageConfiguration = LocalStorageConfiguration | S3StorageConfiguration;

export function readStorageConfiguration(environment: NodeJS.ProcessEnv): StorageConfiguration {
  const backend = environment.YUKI_STORAGE_BACKEND?.trim() || 'local';
  const issues: string[] = [];
  if (backend === 'local') {
    const root = required(environment.YUKI_STORAGE_ROOT, 'YUKI_STORAGE_ROOT', issues);
    valid(issues);
    return { backend, root };
  }
  if (backend !== 's3') {
    throw new ConfigurationError(['YUKI_STORAGE_BACKEND must be local or s3']);
  }

  const endpointValue = required(environment.YUKI_S3_ENDPOINT, 'YUKI_S3_ENDPOINT', issues);
  const region = required(environment.YUKI_S3_REGION, 'YUKI_S3_REGION', issues);
  const bucket = required(environment.YUKI_S3_BUCKET, 'YUKI_S3_BUCKET', issues);
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    issues.push('YUKI_S3_BUCKET must be a 3-63 character lowercase DNS-style name');
  }
  const accessKeyId = required(environment.YUKI_S3_ACCESS_KEY_ID, 'YUKI_S3_ACCESS_KEY_ID', issues);
  const secretAccessKey = required(
    environment.YUKI_S3_SECRET_ACCESS_KEY,
    'YUKI_S3_SECRET_ACCESS_KEY',
    issues,
  );
  const endpoint = parseEndpoint(endpointValue, issues);
  const forcePathStyle = boolean(
    environment.YUKI_S3_FORCE_PATH_STYLE,
    'YUKI_S3_FORCE_PATH_STYLE',
    issues,
    true,
  );
  const multipartThresholdBytes = integer(
    environment.YUKI_S3_MULTIPART_THRESHOLD_BYTES,
    'YUKI_S3_MULTIPART_THRESHOLD_BYTES',
    issues,
    8 * 1024 * 1024,
    5 * 1024 * 1024,
    5 * 1024 * 1024 * 1024,
  );
  const signedDownloadTtlSeconds = integer(
    environment.YUKI_S3_SIGNED_DOWNLOAD_TTL_SECONDS,
    'YUKI_S3_SIGNED_DOWNLOAD_TTL_SECONDS',
    issues,
    300,
    1,
    3600,
  );
  valid(issues);
  return {
    backend,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    multipartThresholdBytes,
    signedDownloadTtlSeconds,
  };
}

function required(value: string | undefined, name: string, issues: string[]): string {
  const normalized = value?.trim();
  if (!normalized) issues.push(`${name} is required`);
  return normalized ?? '';
}

function parseEndpoint(value: string, issues: string[]): URL {
  try {
    const endpoint = new URL(value);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      issues.push('YUKI_S3_ENDPOINT must be an HTTP(S) URL without credentials');
    }
    if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      issues.push('YUKI_S3_ENDPOINT must not contain a path, query, or fragment');
    }
    return endpoint;
  } catch {
    issues.push('YUKI_S3_ENDPOINT must be a valid URL');
    return new URL('http://invalid.invalid');
  }
}

function boolean(
  value: string | undefined,
  name: string,
  issues: string[],
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push(`${name} must be true or false`);
  return fallback;
}

function integer(
  value: string | undefined,
  name: string,
  issues: string[],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}`);
    return fallback;
  }
  return parsed;
}

function valid(issues: string[]): asserts issues is [] {
  if (issues.length > 0) throw new ConfigurationError(issues);
}
