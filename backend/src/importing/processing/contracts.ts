import type { Readable } from 'node:stream';

import type { DetectionProcessorResult } from '../detection/contract.js';

export interface ImportProcessingInput {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly originalFilename: string;
  readonly claimedMimeType: string;
  readonly checksum: string;
  readonly size: number;
  /** A fresh stream is returned for each attempt; original bytes are never modified. */
  readonly openOriginal: () => Promise<Readable>;
}

export interface PreparedImportFile {
  /** Stable across retries. Archive members use their validated relative path. */
  readonly fileKey: string;
  readonly originalFilename: string;
  readonly size: number;
  readonly checksum: string;
  readonly detection: DetectionProcessorResult;
  /** Omitted only when this file is the retained original upload. */
  readonly open?: () => Promise<Readable>;
}

export interface RejectedImportFile {
  readonly fileKey: string;
  readonly originalFilename: string;
  readonly size: number;
  readonly checksum: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface PreparedImportBatch {
  readonly kind: 'file' | 'archive';
  readonly originalDetection: DetectionProcessorResult;
  /** Archive extraction must have been preceded by complete central-directory inspection. */
  readonly files: readonly (PreparedImportFile | RejectedImportFile)[];
  /** Releases processor response workspaces after returned streams are consumed. */
  readonly cleanup?: () => Promise<void>;
}

/**
 * Deployment boundary owned by the composition root. Implementations may materialize
 * inputs in a private workspace and call the restricted processor container, but must
 * not expose host paths or a Docker socket to the API/worker.
 */
export interface ImportContentProcessor {
  inspect(input: ImportProcessingInput): Promise<PreparedImportBatch>;
}

export function isRejectedImportFile(
  file: PreparedImportFile | RejectedImportFile,
): file is RejectedImportFile {
  return 'error' in file;
}
