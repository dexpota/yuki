import { describe, expect, it } from 'vitest';

import {
  readStorageConfiguration,
  type S3StorageConfiguration,
} from '../../src/platform/storage/index.js';

describe('storage configuration', () => {
  it('defaults to the local backend and requires its dedicated root', () => {
    expect(readStorageConfiguration({ YUKI_STORAGE_ROOT: '/data/yuki' })).toEqual({
      backend: 'local',
      root: '/data/yuki',
    });
    expect(() => readStorageConfiguration({})).toThrow('YUKI_STORAGE_ROOT is required');
  });

  it('validates and normalizes a vendor-neutral S3 configuration', () => {
    const configuration = readStorageConfiguration(s3Environment()) as S3StorageConfiguration;
    expect(configuration).toMatchObject({
      backend: 's3',
      endpoint: new URL('http://minio:9000'),
      region: 'us-east-1',
      bucket: 'yuki',
      accessKeyId: 'yuki-minio',
      secretAccessKey: 'development-secret',
      forcePathStyle: true,
      multipartThresholdBytes: 8 * 1024 * 1024,
      signedDownloadTtlSeconds: 300,
    });
  });

  it('rejects credentials in endpoints and incomplete S3 secrets', () => {
    expect(() =>
      readStorageConfiguration({
        YUKI_STORAGE_BACKEND: 's3',
        YUKI_S3_ENDPOINT: 'http://user:secret@minio:9000/path',
      }),
    ).toThrow(
      /YUKI_S3_REGION is required.*YUKI_S3_SECRET_ACCESS_KEY is required.*without credentials.*must not contain a path/,
    );
  });

  it('rejects object bucket names that cannot be encoded portably', () => {
    expect(() =>
      readStorageConfiguration({
        ...s3Environment(),
        YUKI_S3_BUCKET: 'Not/A/Bucket',
      }),
    ).toThrow('YUKI_S3_BUCKET must be a 3-63 character lowercase DNS-style name');
  });
});

function s3Environment(): NodeJS.ProcessEnv {
  return {
    YUKI_STORAGE_BACKEND: 's3',
    YUKI_S3_ENDPOINT: 'http://minio:9000',
    YUKI_S3_REGION: 'us-east-1',
    YUKI_S3_BUCKET: 'yuki',
    YUKI_S3_ACCESS_KEY_ID: 'yuki-minio',
    YUKI_S3_SECRET_ACCESS_KEY: 'development-secret',
  };
}
