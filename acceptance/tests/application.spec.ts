import { expect, test } from '../fixtures/identity.js';

test('authenticated fixture opens the empty catalogue and core navigation', async ({
  authenticatedPage: page,
  credentials,
}) => {
  await expect(page.getByText(credentials.username, { exact: true })).toBeVisible();
  await expect(page.getByText('No models match these filters.')).toBeVisible();

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/\/import$/);
  await expect(page.getByRole('heading', { name: 'Add a model' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
});
