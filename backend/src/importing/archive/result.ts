import type { ArchiveProcessorResult } from './contract.js';

export function parseArchiveProcessorResult(value: unknown): ArchiveProcessorResult {
  if (!isRecord(value) || !Array.isArray(value.members) || !safeNonnegative(value.expandedBytes)) {
    throw new TypeError('Processor returned a malformed archive result');
  }
  const paths = new Set<string>();
  const members = value.members.map((member) => {
    if (
      !isRecord(member) ||
      typeof member.path !== 'string' ||
      !validMemberPath(member.path) ||
      !safeNonnegative(member.size) ||
      typeof member.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(member.checksum)
    ) {
      throw new TypeError('Processor returned a malformed archive result');
    }
    const collisionKey = member.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (paths.has(collisionKey))
      throw new TypeError('Processor returned a malformed archive result');
    paths.add(collisionKey);
    return { path: member.path, size: member.size, checksum: member.checksum };
  });
  let aggregateSize = 0;
  for (const member of members) {
    aggregateSize += member.size;
    if (!Number.isSafeInteger(aggregateSize)) {
      throw new TypeError('Processor returned an inconsistent archive result');
    }
  }
  if (aggregateSize !== value.expandedBytes) {
    throw new TypeError('Processor returned an inconsistent archive result');
  }
  return { members, expandedBytes: value.expandedBytes };
}

function validMemberPath(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 4096 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function safeNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
