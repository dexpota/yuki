export interface ArchiveLimits {
  readonly maximumArchiveBytes: number;
  readonly maximumMembers: number;
  readonly maximumMemberBytes: number;
  readonly maximumExpandedBytes: number;
  readonly maximumCompressionRatio: number;
}

export interface ExtractArchiveRequest {
  readonly inputPath: string;
  readonly outputDirectory: string;
  readonly limits: ArchiveLimits;
}

export interface ExtractedArchiveMember {
  readonly path: string;
  readonly size: number;
  readonly checksum: string;
}

export interface ExtractArchiveResult {
  readonly members: readonly ExtractedArchiveMember[];
  readonly expandedBytes: number;
}

export type ArchiveRejectionCode =
  | 'archive_too_large'
  | 'encrypted_archive'
  | 'invalid_archive_path'
  | 'link_not_allowed'
  | 'malformed_archive'
  | 'member_too_large'
  | 'too_many_members'
  | 'expanded_size_exceeded'
  | 'compression_ratio_exceeded'
  | 'path_collision';

export class ArchiveRejectedError extends Error {
  override readonly name = 'ArchiveRejectedError';

  public constructor(public readonly code: ArchiveRejectionCode) {
    super(messageFor(code));
  }
}

function messageFor(code: ArchiveRejectionCode): string {
  const messages: Record<ArchiveRejectionCode, string> = {
    archive_too_large: 'The archive exceeds the configured compressed-size limit.',
    encrypted_archive: 'Encrypted archives are not supported.',
    invalid_archive_path: 'The archive contains an unsafe member path.',
    link_not_allowed: 'Archive links are not supported.',
    malformed_archive: 'The archive is malformed or truncated.',
    member_too_large: 'An archive member exceeds the configured size limit.',
    too_many_members: 'The archive contains too many members.',
    expanded_size_exceeded: 'The archive expands beyond the configured size limit.',
    compression_ratio_exceeded: 'The archive contains an unsafe compression ratio.',
    path_collision: 'The archive contains colliding member paths.',
  };
  return messages[code];
}
