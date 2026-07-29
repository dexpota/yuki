import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3BlobStore } from '../../src/platform/storage/index.js';
import { verifyBlobStoreContract } from './blob-store-contract.js';

const endpoint = process.env.YUKI_TEST_S3_ENDPOINT;
const suite = endpoint ? describe : describe.skip;
const bucket = `yuki-contract-${process.pid}`;
let client: S3Client;

suite('BlobStore contract: S3/MinIO', () => {
  beforeAll(async () => {
    client = new S3Client({
      endpoint: endpoint ?? 'http://127.0.0.1:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.YUKI_TEST_S3_ACCESS_KEY_ID ?? 'yuki-minio',
        secretAccessKey:
          process.env.YUKI_TEST_S3_SECRET_ACCESS_KEY ?? 'yuki-development-minio-secret',
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (listed.Contents?.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: listed.Contents.flatMap((item) => (item.Key ? [{ Key: item.Key }] : [])),
          },
        }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  it('passes the same streaming, range, integrity, lifecycle, and signing contract', async () => {
    const store = new S3BlobStore(client, {
      bucket,
      multipartThresholdBytes: 5 * 1024 * 1024,
      signedDownloadTtlSeconds: 300,
    });
    await store.checkAccess();
    await verifyBlobStoreContract(store, { signedDownloads: true });
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const multipart = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    expect(objects.Contents ?? []).toEqual([]);
    expect(multipart.Uploads ?? []).toEqual([]);
  }, 15_000);
});
