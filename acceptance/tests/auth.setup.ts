import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test as setup } from '@playwright/test';

import {
  completeFirstOwnerSetup,
  ownerCredentials,
  ownerStorageStatePath,
  signIn,
} from '../fixtures/identity.js';

setup('creates the first owner and records a reusable authenticated session', async ({ page }) => {
  const credentials = ownerCredentials();
  await page.goto('/');
  await completeFirstOwnerSetup(page, credentials);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('username or password is incorrect');

  await signIn(page, credentials);
  await mkdir(dirname(ownerStorageStatePath), { recursive: true });
  await page.context().storageState({ path: ownerStorageStatePath });
});
