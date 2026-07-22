import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type ArchiveLimits, ArchiveRejectedError } from '../../src/archive/contracts.js';
import { extractArchive } from '../../src/archive/extract.js';
import { buildZip, type ZipMemberFixture } from './zip-fixture.js';

const workspaces: string[] = [];
const limits: ArchiveLimits = {
  maximumArchiveBytes: 1024 * 1024,
  maximumMembers: 10,
  maximumMemberBytes: 100_000,
  maximumExpandedBytes: 200_000,
  maximumCompressionRatio: 100,
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe('hostile-safe ZIP extraction', () => {
  it('streams valid members, hashes outputs, and leaves the original archive unchanged', async () => {
    const fixture = await archive([
      { name: 'models/', externalAttributes: (0o040755 << 16) >>> 0 },
      { name: 'models/part.stl', contents: 'solid cube', compression: 'deflate' },
      { name: 'notes.txt', contents: 'hello' },
    ]);
    const before = createHash('sha256')
      .update(await readFile(fixture.input))
      .digest('hex');

    const result = await extractArchive({
      inputPath: fixture.input,
      outputDirectory: fixture.output,
      limits,
    });

    expect(result).toEqual({
      members: [
        {
          path: 'models/part.stl',
          size: 10,
          checksum: createHash('sha256').update('solid cube').digest('hex'),
        },
        {
          path: 'notes.txt',
          size: 5,
          checksum: createHash('sha256').update('hello').digest('hex'),
        },
      ],
      expandedBytes: 15,
    });
    expect(await readFile(path.join(fixture.output, 'models/part.stl'), 'utf8')).toBe('solid cube');
    expect(
      createHash('sha256')
        .update(await readFile(fixture.input))
        .digest('hex'),
    ).toBe(before);
  });

  it.each([
    '../escape.stl',
    'safe/../../escape.stl',
    '/absolute.stl',
    'C:/drive.stl',
    '\\\\server\\share.stl',
    'safe\\..\\escape.stl',
  ])('rejects unsafe path %s and cleans partial output', async (name) => {
    const fixture = await archive([
      { name: 'first.txt', contents: 'created first' },
      { name, contents: 'bad' },
    ]);
    await expectRejected(fixture, ['invalid_archive_path', 'malformed_archive']);
    await expect(stat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Unix symbolic links', async () => {
    const fixture = await archive([
      { name: 'link', contents: 'target', externalAttributes: (0o120777 << 16) >>> 0 },
    ]);
    await expectRejected(fixture, ['link_not_allowed']);
  });

  it('rejects duplicate, portable, Unicode, and file/directory collisions', async () => {
    const cases: readonly (readonly ZipMemberFixture[])[] = [
      [
        { name: 'same.txt', contents: 'a' },
        { name: 'same.txt', contents: 'b' },
      ],
      [
        { name: 'A.txt', contents: 'a' },
        { name: 'a.txt', contents: 'b' },
      ],
      [
        { name: 'caf\u00e9.txt', contents: 'a' },
        { name: 'cafe\u0301.txt', contents: 'b' },
      ],
      [
        { name: 'parent', contents: 'a' },
        { name: 'parent/child', contents: 'b' },
      ],
    ];
    for (const members of cases) {
      const fixture = await archive(members);
      await expectRejected(fixture, ['path_collision']);
    }
  });

  it('enforces the member count', async () => {
    const fixture = await archive([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    await expectRejected(fixture, ['too_many_members'], { maximumMembers: 2 });
  });

  it('enforces declared per-member and total expanded sizes before extraction', async () => {
    const member = await archive([{ name: 'large', contents: '123456' }]);
    await expectRejected(member, ['member_too_large'], { maximumMemberBytes: 5 });
    const total = await archive([
      { name: 'a', contents: '1234' },
      { name: 'b', contents: '5678' },
    ]);
    await expectRejected(total, ['expanded_size_exceeded'], { maximumExpandedBytes: 7 });
  });

  it('rejects suspicious compression ratios and compressed archive size', async () => {
    const bomb = await archive([
      { name: 'bomb', contents: '0'.repeat(20_000), compression: 'deflate' },
    ]);
    await expectRejected(bomb, ['compression_ratio_exceeded'], { maximumCompressionRatio: 2 });
    const compressed = await archive([{ name: 'plain', contents: '1234567890' }]);
    await expectRejected(compressed, ['archive_too_large'], { maximumArchiveBytes: 5 });
  });

  it('rejects encrypted and malformed or truncated archives with sanitized errors', async () => {
    const encrypted = await archive([{ name: 'secret', contents: 'ciphertext', flags: 0x801 }]);
    await expectRejected(encrypted, ['encrypted_archive']);
    const malformed = await archive([{ name: 'file', contents: 'hello' }]);
    const bytes = await readFile(malformed.input);
    await writeFile(malformed.input, bytes.subarray(0, bytes.length - 10));
    await expectRejected(malformed, ['malformed_archive']);
  });
});

async function archive(members: readonly ZipMemberFixture[]) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yuki-archive-test-'));
  workspaces.push(workspace);
  const input = path.join(workspace, 'original.zip');
  const output = path.join(workspace, 'output');
  await writeFile(input, buildZip(members));
  return { input, output };
}

async function expectRejected(
  fixture: { input: string; output: string },
  codes: readonly string[],
  overrides: Partial<ArchiveLimits> = {},
): Promise<void> {
  const promise = extractArchive({
    inputPath: fixture.input,
    outputDirectory: fixture.output,
    limits: { ...limits, ...overrides },
  });
  await expect(promise).rejects.toBeInstanceOf(ArchiveRejectedError);
  await expect(promise).rejects.toMatchObject({
    code: expect.stringMatching(new RegExp(`^(${codes.join('|')})$`)),
  });
  await expect(promise).rejects.not.toHaveProperty('cause');
}
