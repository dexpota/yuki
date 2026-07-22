export const archiveProcessorOperation = 'extract-zip' as const;
export const archiveProcessorPayloadVersion = 1 as const;

export interface ArchiveProcessingLimits {
  readonly maximumArchiveBytes: number;
  readonly maximumMembers: number;
  readonly maximumMemberBytes: number;
  readonly maximumExpandedBytes: number;
  readonly maximumCompressionRatio: number;
}

export interface ArchiveProcessorRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly operation: typeof archiveProcessorOperation;
  readonly payloadVersion: typeof archiveProcessorPayloadVersion;
  readonly inputPath: '/input/archive.zip';
  readonly outputDirectory: '/output/archive';
  readonly limits: ArchiveProcessingLimits;
}

export interface ArchiveProcessorResult {
  readonly members: readonly {
    readonly path: string;
    readonly size: number;
    readonly checksum: string;
  }[];
  readonly expandedBytes: number;
}

export function archiveProcessorRequest(
  requestId: string,
  limits: ArchiveProcessingLimits,
): ArchiveProcessorRequest {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new TypeError('requestId is invalid');
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive safe integer`);
  }
  return {
    protocolVersion: 1,
    requestId,
    operation: archiveProcessorOperation,
    payloadVersion: archiveProcessorPayloadVersion,
    inputPath: '/input/archive.zip',
    outputDirectory: '/output/archive',
    limits,
  };
}
