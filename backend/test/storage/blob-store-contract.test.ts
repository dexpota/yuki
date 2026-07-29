import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { LocalBlobStore } from '../../src/platform/storage/index.js';
import { verifyBlobStoreContract } from './blob-store-contract.js';

describe('BlobStore contract: local', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'yuki-storage-contract-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the portable storage contract', async () => {
    await verifyBlobStoreContract(await LocalBlobStore.create(root), {
      signedDownloads: false,
    });
  });
});
