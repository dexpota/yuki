const releaseApi = 'https://api.github.com/repos/dexpota/yuki/releases/latest';
const releaseRoot = 'https://github.com/dexpota/yuki';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const maximumReleaseBytes = 32 * 1024;
const cacheMilliseconds = 60 * 60 * 1000;
const unavailableCacheMilliseconds = 60 * 1000;

export type ReleaseAvailability =
  | 'current'
  | 'update-available'
  | 'unsupported'
  | 'check-unavailable';

export interface SystemInformation {
  readonly version: string;
  readonly revision: string;
  readonly release: {
    readonly status: ReleaseAvailability;
    readonly latestVersion: string | null;
    readonly releaseNotesUrl: string | null;
    readonly updateGuideUrl: string | null;
  };
}

export class SystemInformationService {
  private cachedUntil = 0;
  private cachedRelease: SystemInformation['release'] | undefined;
  private pendingRelease: Promise<SystemInformation['release']> | undefined;

  public constructor(
    private readonly version: string,
    private readonly revision: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public async get(): Promise<SystemInformation> {
    const version = safeText(this.version, 64, 'unknown');
    const revision = revisionPattern.test(this.revision) ? this.revision : 'unknown';
    const supportedBuild = versionPattern.test(version) && revision !== 'unknown';
    const release = supportedBuild
      ? await this.latestRelease(version)
      : {
          status: 'unsupported' as const,
          latestVersion: null,
          releaseNotesUrl: null,
          updateGuideUrl: null,
        };
    return { version, revision, release };
  }

  private async latestRelease(version: string): Promise<SystemInformation['release']> {
    if (this.cachedRelease && this.cachedUntil > this.now()) return this.cachedRelease;
    if (!this.pendingRelease) {
      this.pendingRelease = this.fetchLatestRelease(version).finally(() => {
        this.pendingRelease = undefined;
      });
    }
    return this.pendingRelease;
  }

  private async fetchLatestRelease(version: string): Promise<SystemInformation['release']> {
    try {
      const response = await this.fetcher(releaseApi, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'Yuki-release-check',
        },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error('release source returned an error');
      const latestVersion = await readReleaseVersion(response);
      const compared = compareVersions(version, latestVersion);
      const status = compared === 0 ? 'current' : compared < 0 ? 'update-available' : 'unsupported';
      const releaseUrl = `${releaseRoot}/releases/tag/${latestVersion}`;
      const result: SystemInformation['release'] = {
        status,
        latestVersion,
        releaseNotesUrl: releaseUrl,
        updateGuideUrl: `${releaseRoot}/blob/${latestVersion}/deploy/PRODUCTION.md#apply-a-release-update`,
      };
      this.cachedRelease = result;
      this.cachedUntil = this.now() + cacheMilliseconds;
      return result;
    } catch {
      const result: SystemInformation['release'] = {
        status: 'check-unavailable',
        latestVersion: null,
        releaseNotesUrl: null,
        updateGuideUrl: null,
      };
      this.cachedRelease = result;
      this.cachedUntil = this.now() + unavailableCacheMilliseconds;
      return result;
    }
  }
}

async function readReleaseVersion(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumReleaseBytes)
    throw new Error('release metadata exceeds size limit');
  if (!response.body) throw new Error('release metadata is empty');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumReleaseBytes) throw new Error('release metadata exceeds size limit');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const metadata: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  if (!isRecord(metadata) || typeof metadata.tag_name !== 'string')
    throw new Error('release metadata is invalid');
  if (!versionPattern.test(metadata.tag_name)) throw new Error('release tag is unsupported');
  return metadata.tag_name;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  }
  return 0;
}

function safeText(value: string, maximumLength: number, fallback: string): string {
  return value.length > 0 && value.length <= maximumLength && !/[\r\n\0]/.test(value)
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
