import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneratedPreviewDescriptor, GeneratedPreviewResult } from './contracts.js';
import { generatePreview } from './generate.js';
import type { PreviewLimits, PreviewSourceFormat } from './types.js';
import { PreviewLimitError } from './types.js';

export async function generatePreviewFiles(
  inputPath: string,
  outputDirectory: string,
  format: PreviewSourceFormat,
  limits: PreviewLimits,
): Promise<GeneratedPreviewResult> {
  const metadata = await stat(inputPath);
  if (!metadata.isFile()) throw new PreviewLimitError('Preview input is not a regular file.');
  if (metadata.size > limits.maximumInputBytes)
    throw new PreviewLimitError('Preview input exceeds the configured byte limit.');
  const result = generatePreview(await readFile(inputPath), format, limits);
  if (result.status !== 'ready') return result;
  await mkdir(outputDirectory, { recursive: true });
  const descriptors: GeneratedPreviewDescriptor[] = [];
  for (const file of result.files) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(file.name)) throw new Error('Unsafe generated filename.');
    await writeFile(join(outputDirectory, file.name), file.bytes, { flag: 'wx' });
    descriptors.push({ name: file.name, mimeType: file.mimeType, byteSize: file.bytes.byteLength });
  }
  const { files: _files, ...metadataResult } = result;
  return { ...metadataResult, files: descriptors };
}
