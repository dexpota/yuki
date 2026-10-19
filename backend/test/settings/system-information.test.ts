import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../src/platform/http/index.js';
import {
  registerSettingsFeature,
  type SettingsDatabaseSchema,
  SystemInformationService,
} from '../../src/settings/index.js';

const revision = 'a'.repeat(40);

describe('system information and release availability', () => {
  it('reports the build identity and links to the validated newer release', async () => {
    const service = new SystemInformationService('1.2.0', revision, async () => release('1.3.0'));

    await expect(service.get()).resolves.toEqual({
      version: '1.2.0',
      revision,
      release: {
        status: 'update-available',
        latestVersion: '1.3.0',
        releaseNotesUrl: 'https://github.com/dexpota/yuki/releases/tag/1.3.0',
        updateGuideUrl:
          'https://github.com/dexpota/yuki/blob/1.3.0/deploy/PRODUCTION.md#apply-a-release-update',
      },
    });
  });

  it('marks matching releases current and unsupported build identities unsupported', async () => {
    const calls = vi.fn(async () => release('1.2.0'));
    await expect(
      new SystemInformationService('1.2.0', revision, calls).get(),
    ).resolves.toMatchObject({
      release: { status: 'current' },
    });
    await expect(
      new SystemInformationService('0.0.0-development', 'unknown', calls).get(),
    ).resolves.toMatchObject({ release: { status: 'unsupported' } });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('reports check-unavailable without failing when the metadata request fails', async () => {
    const service = new SystemInformationService('1.2.0', revision, async () => {
      throw new Error('network unavailable');
    });

    await expect(service.get()).resolves.toMatchObject({
      version: '1.2.0',
      revision,
      release: {
        status: 'check-unavailable',
        latestVersion: null,
        releaseNotesUrl: null,
        updateGuideUrl: null,
      },
    });
  });

  it('rejects malformed or oversized GitHub release metadata', async () => {
    const malformed = new SystemInformationService(
      '1.2.0',
      revision,
      async () => new Response(JSON.stringify({ tag_name: 'latest' })),
    );
    const oversized = new SystemInformationService(
      '1.2.0',
      revision,
      async () =>
        new Response('{"tag_name":"1.3.0"}', {
          headers: { 'content-length': '40000' },
        }),
    );

    await expect(malformed.get()).resolves.toMatchObject({
      release: { status: 'check-unavailable' },
    });
    await expect(oversized.get()).resolves.toMatchObject({
      release: { status: 'check-unavailable' },
    });
  });

  it('requires authentication for the system-information endpoint', async () => {
    const application = await createHttpApplication();
    registerSettingsFeature(application, {
      database: {} as Kysely<SettingsDatabaseSchema>,
      systemInformation: new SystemInformationService('1.2.0', revision, async () =>
        release('1.2.0'),
      ),
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('owner must remain unavailable');
        },
      },
    });

    try {
      expect(
        (await application.inject({ method: 'GET', url: '/api/v1/system/information' })).statusCode,
      ).toBe(401);
    } finally {
      await application.close();
    }
  });

  it('returns build and availability metadata to an authenticated owner', async () => {
    const application = await createHttpApplication();
    registerSettingsFeature(application, {
      database: {} as Kysely<SettingsDatabaseSchema>,
      systemInformation: new SystemInformationService('1.2.0', revision, async () =>
        release('1.3.0'),
      ),
      identity: {
        requireOwner: async () => undefined,
        ownerForRequest: () => {
          throw new Error('the public system report does not need owner lookup');
        },
      },
    });

    try {
      const response = await application.inject({
        method: 'GET',
        url: '/api/v1/system/information',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        version: '1.2.0',
        revision,
        release: { status: 'update-available', latestVersion: '1.3.0' },
      });
    } finally {
      await application.close();
    }
  });
});

function release(tag: string): Response {
  return new Response(JSON.stringify({ tag_name: tag }), {
    headers: { 'content-type': 'application/json' },
  });
}
