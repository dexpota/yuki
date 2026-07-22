import type { GeneratedArtifactStatus } from './contracts.js';

export type ArtifactCompletion =
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }
  | { readonly status: 'unsupported'; readonly code: string; readonly message: string };

export function mayStartArtifact(status: GeneratedArtifactStatus): boolean {
  return status === 'queued' || status === 'processing' || status === 'failed';
}

export function sanitizedCompletion(completion: ArtifactCompletion): ArtifactCompletion {
  if (completion.status === 'ready') return completion;
  const code = completion.code.replace(/[^a-z0-9_]/gi, '_').slice(0, 100) || 'preview_failed';
  const message = completion.message
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
  return { ...completion, code, message: message || 'Preview generation did not complete.' };
}
