import { defineConfig, devices } from '@playwright/test';

import { ownerStorageStatePath } from './fixtures/identity.js';

const channel = process.env.YUKI_PLAYWRIGHT_CHANNEL?.trim();

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.YUKI_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:18080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: 'owner-setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['owner-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: ownerStorageStatePath,
      },
    },
  ],
});
