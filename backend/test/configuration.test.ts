import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  readApiConfiguration,
  readWorkerConfiguration,
} from '../src/platform/configuration.js';

describe('backend configuration', () => {
  it('provides local-safe process defaults', () => {
    expect(readApiConfiguration({})).toEqual({
      environment: 'development',
      host: '0.0.0.0',
      port: 3000,
      shutdownGracePeriodMs: 10_000,
    });
    expect(readWorkerConfiguration({})).toEqual({
      environment: 'development',
      shutdownGracePeriodMs: 10_000,
    });
  });

  it('reads explicit API and runtime settings', () => {
    expect(
      readApiConfiguration({
        NODE_ENV: 'production',
        YUKI_API_HOST: '127.0.0.1',
        YUKI_API_PORT: '8080',
        YUKI_SHUTDOWN_GRACE_PERIOD_MS: '25000',
      }),
    ).toEqual({
      environment: 'production',
      host: '127.0.0.1',
      port: 8080,
      shutdownGracePeriodMs: 25_000,
    });
  });

  it('reports every invalid setting without exposing the environment', () => {
    expect(() =>
      readApiConfiguration({
        NODE_ENV: 'staging',
        YUKI_API_HOST: ' ',
        YUKI_API_PORT: '70000',
        YUKI_SHUTDOWN_GRACE_PERIOD_MS: 'secret-not-a-number',
      }),
    ).toThrowError(ConfigurationError);

    try {
      readApiConfiguration({
        NODE_ENV: 'staging',
        YUKI_API_HOST: ' ',
        YUKI_API_PORT: '70000',
        YUKI_SHUTDOWN_GRACE_PERIOD_MS: 'secret-not-a-number',
      });
    } catch (error) {
      expect(error).toMatchObject({
        issues: [
          'NODE_ENV must be one of development, test, production',
          'YUKI_SHUTDOWN_GRACE_PERIOD_MS must be an integer between 1 and 300000',
          'YUKI_API_HOST must not be empty',
          'YUKI_API_PORT must be an integer between 1 and 65535',
        ],
      });
      expect(String(error)).not.toContain('secret-not-a-number');
    }
  });
});
