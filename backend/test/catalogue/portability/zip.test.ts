import { describe, expect, it } from 'vitest';

import {
  canonicalManifestJson,
  parseManifestV1,
  readPortableZip,
  writePortableZip,
} from '../../../src/catalogue/portability/index.js';
import { manifest } from './fixture.js';

describe('portable ZIP stream', () => {
  it('round trips the manifest and original bytes without buffering the export API', async () => {
    const document = manifest();
    const manifestBytes = Buffer.from(canonicalManifestJson(document));
    const assetBytes = Buffer.from([1, 2, 3, 4]);
    const archive = await collect(
      writePortableZip(entries(manifestBytes, assetBytes, document.assets[0]?.path as string)),
    );
    let importedManifest = '';
    let importedAsset: Uint8Array = Buffer.alloc(0);

    await readPortableZip(
      chunks(archive, 7),
      async (entry) => {
        importedManifest = (await collect(entry.bytes)).toString('utf8');
        const parsed = parseManifestV1(JSON.parse(importedManifest));
        return new Map(parsed.assets.map((asset) => [asset.path, asset.byteSize]));
      },
      async (entry) => {
        importedAsset = await collect(entry.bytes);
      },
    );

    expect(JSON.parse(importedManifest)).toEqual(document);
    expect(importedAsset).toEqual(assetBytes);
  });

  it('rejects archive entry path traversal before writing bytes', async () => {
    await expect(
      collect(
        writePortableZip(
          (async function* () {
            yield { path: '../outside', size: 0, source: chunks(Buffer.alloc(0), 1) };
          })(),
        ),
      ),
    ).rejects.toThrow('invalid');
  });
});

async function* entries(manifestBytes: Buffer, assetBytes: Buffer, path: string) {
  yield { path: 'manifest.json', size: manifestBytes.length, source: chunks(manifestBytes, 3) };
  yield { path, size: assetBytes.length, source: chunks(assetBytes, 1) };
}
async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
