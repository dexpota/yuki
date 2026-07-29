import { S3Client } from '@aws-sdk/client-s3';

import type { BlobStore } from './blob-store.js';
import type { StorageConfiguration } from './configuration.js';
import { LocalBlobStore } from './local-blob-store.js';
import { S3BlobStore } from './s3-blob-store.js';

export async function createBlobStore(configuration: StorageConfiguration): Promise<BlobStore> {
  if (configuration.backend === 'local') return LocalBlobStore.create(configuration.root);
  const store = new S3BlobStore(
    new S3Client({
      endpoint: configuration.endpoint.href,
      region: configuration.region,
      forcePathStyle: configuration.forcePathStyle,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    }),
    {
      bucket: configuration.bucket,
      multipartThresholdBytes: configuration.multipartThresholdBytes,
      signedDownloadTtlSeconds: configuration.signedDownloadTtlSeconds,
    },
  );
  await store.checkAccess();
  return store;
}
