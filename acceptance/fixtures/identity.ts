import { resolve } from 'node:path';

import { test as base, expect, type Page } from '@playwright/test';

export interface OwnerCredentials {
  readonly username: string;
  readonly password: string;
}

export const ownerStorageStatePath = resolve('.auth/owner.json');

export function ownerCredentials(): OwnerCredentials {
  return {
    username: process.env.YUKI_ACCEPTANCE_USERNAME ?? 'Acceptance Owner',
    password: process.env.YUKI_ACCEPTANCE_PASSWORD ?? 'acceptance-only-password',
  };
}

export async function completeFirstOwnerSetup(
  page: Page,
  credentials: OwnerCredentials,
): Promise<void> {
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Create your owner account' })).toBeVisible();
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your models' })).toBeVisible();
}

export async function signIn(page: Page, credentials: OwnerCredentials): Promise<void> {
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Your models' })).toBeVisible();
}

interface AcceptanceFixtures {
  readonly authenticatedPage: Page;
  readonly credentials: OwnerCredentials;
}

export const test = base.extend<AcceptanceFixtures>({
  credentials: [ownerCredentials(), { option: true }],
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your models' })).toBeVisible();
    await use(page);
  },
});

export { expect } from '@playwright/test';
