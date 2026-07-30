import { expect, test } from '../fixtures/identity.js';
import { multipartModelZip, resultPhoto, secondVersionStl } from '../fixtures/model-package.js';

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

test('configures two independent OctoPrint printers and observes live facts', async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(75_000);
  await page.getByRole('link', { name: 'Printers', exact: true }).click();
  await addPrinter(page, 'Virtual Printer A', 'http://octoprint-a:5000/');
  await addPrinter(page, 'Virtual Printer B', 'http://octoprint-b:5000/', 20);

  await expect(page.getByRole('link', { name: /Virtual Printer A/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Virtual Printer B/ })).toBeVisible();
  await page.getByRole('link', { name: /Virtual Printer A/ }).click();
  await expect(page.getByRole('heading', { name: 'Virtual Printer A', level: 1 })).toBeVisible();
  await expect(page.getByText(/tool0: 205.2°/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/bed: 59.8°/)).toBeVisible();
  await expect(page.getByText('operational', { exact: true })).toBeVisible();
  const webcam = page.getByRole('img', { name: 'Webcam snapshot for Virtual Printer A' });
  await expect
    .poll(() =>
      webcam.evaluate(
        (image) => (image as unknown as { readonly naturalWidth: number }).naturalWidth,
      ),
    )
    .toBeGreaterThan(0);
});

test('imports, versions, previews, exports, and re-imports a multipart model', async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(120_000);
  const firstPackage = multipartModelZip();
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.locator('.import-drop-zone input[type="file"]').setInputFiles({
    name: 'release-package.zip',
    mimeType: 'application/zip',
    buffer: firstPackage,
  });
  await page.getByRole('textbox', { name: 'Model name' }).fill('Release Assembly');
  await page.getByRole('button', { name: 'Upload and import' }).click();
  await page.getByRole('link', { name: 'View imported model' }).click({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Release Assembly', level: 1 })).toBeVisible();

  await page.getByRole('textbox', { name: 'Comma-separated tags' }).fill('release, acceptance');
  await page.getByRole('button', { name: 'Save tags' }).click();
  const previewButtons = page.getByRole('button', { name: 'Generate preview' });
  await expect(previewButtons).toHaveCount(2);
  for (const button of await previewButtons.all()) await button.click();
  await expect(page.getByLabel('Interactive model preview')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Read-only G-code layer preview')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: 'Catalogue', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search' }).fill('Release Assembly');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.getByRole('link', { name: /Release Assembly/ }).click();

  await page.getByRole('link', { name: 'Add version' }).click();
  await page.locator('.import-drop-zone input[type="file"]').setInputFiles({
    name: 'release-v2.stl',
    mimeType: 'model/stl',
    buffer: secondVersionStl(),
  });
  await page.getByRole('textbox', { name: 'Version label' }).fill('v2');
  await page.getByRole('textbox', { name: 'Change note' }).fill('Larger release geometry');
  await page.getByRole('button', { name: 'Upload new version' }).click();
  await page.getByRole('link', { name: 'View imported model' }).click({ timeout: 60_000 });
  await expect(page.getByText('Larger release geometry')).toBeVisible();
  const originalDownload = page.getByRole('link', { name: 'release-package.zip' });
  const originalResponse = await page.request.get(await requiredHref(originalDownload));
  expect(originalResponse.ok()).toBe(true);
  expect(Buffer.compare(await originalResponse.body(), firstPackage)).toBe(0);

  await page.getByRole('button', { name: 'Restore as current' }).last().click();
  await expect(page.getByText('Current', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Prepare export' }).click();
  const exportDownload = page.getByRole('link', { name: 'Download Yuki package' });
  await expect(exportDownload).toBeVisible({ timeout: 60_000 });
  const exportResponse = await page.request.get(await requiredHref(exportDownload));
  expect(exportResponse.ok()).toBe(true);

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.getByLabel('Yuki export package').setInputFiles({
    name: 'release-assembly.yuki.zip',
    mimeType: 'application/vnd.yuki.model+zip',
    buffer: await exportResponse.body(),
  });
  await page.getByRole('button', { name: 'Re-import package' }).click();
  await page.getByRole('link', { name: 'View re-imported model' }).click({ timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: 'Comma-separated tags' })).toHaveValue(
    'acceptance, release',
  );
  await expect(page.locator('.version-list > li')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'release-package.zip' })).toBeVisible();
});

test('evaluates independent queues and confirms start, controls, notification, and history', async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(180_000);
  await page.getByRole('link', { name: 'Printers', exact: true }).click();
  await page.getByRole('link', { name: /Virtual Printer A/ }).click();
  await addCurrentGcodeToQueue(page);
  await expect(page.getByText('compatible', { exact: true })).toBeVisible({ timeout: 60_000 });
  await confirmStart(page);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 60_000 });

  await confirmControl(page, 'Pause');
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 60_000 });
  await confirmControl(page, 'Resume');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 60_000 });
  await confirmControl(page, 'Cancel print');
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 60_000 });

  await addCurrentGcodeToQueue(page);
  await expect(page.getByRole('button', { name: 'Review & start' })).toBeVisible({
    timeout: 60_000,
  });
  await confirmStart(page);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: 'Printers', exact: true }).click();
  await page.getByRole('link', { name: /Virtual Printer B/ }).click();
  await addCurrentGcodeToQueue(page);
  await expect(page.getByText('incompatible', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Review & start' })).toHaveCount(0);

  await page.getByRole('link', { name: /^Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Print completed' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: 'Print cancelled' })).toBeVisible();

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.locator('.outcome-badge', { hasText: 'Successful' })).toBeVisible();
  await expect(page.locator('.outcome-badge', { hasText: 'Cancelled' })).toBeVisible();
  await page.locator('summary', { hasText: 'Edit result' }).first().click();
  await page.getByRole('textbox', { name: 'Notes' }).first().fill('Acceptance print inspected');
  await page.getByRole('button', { name: 'Save notes' }).first().click();
  await page.getByRole('combobox', { name: 'Correct outcome' }).first().selectOption('failed');
  await page.getByRole('textbox', { name: 'Reason' }).first().fill('Physical result reviewed');
  await page.getByRole('button', { name: 'Record correction' }).first().click();
  await page.getByLabel('Add result photo').first().setInputFiles({
    name: 'result.png',
    mimeType: 'image/png',
    buffer: resultPhoto(),
  });
  await page.getByRole('button', { name: 'Upload photo' }).first().click();
  await expect(page.getByRole('img', { name: 'result.png' })).toBeVisible();
  await expect(page.getByText('Acceptance print inspected')).toBeVisible();
  await expect(page.locator('.outcome-badge', { hasText: 'Failed' })).toBeVisible();
});

test('@post-restart preserves catalogue, queues, and history through restart and migration replay', async ({
  authenticatedPage: page,
}) => {
  test.skip(process.env.YUKI_ACCEPTANCE_POST_RESTART !== '1', 'Runs in the post-restart phase.');
  await expect(page.getByRole('link', { name: /Release Assembly/ }).first()).toBeVisible();
  await page
    .getByRole('link', { name: /Release Assembly/ })
    .first()
    .click();
  await expect(page.locator('.version-list > li')).toHaveCount(2);
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await page.locator('summary', { hasText: 'Edit result' }).first().click();
  await expect(page.getByRole('textbox', { name: 'Notes' }).first()).toHaveValue(
    'Acceptance print inspected',
  );
  await expect(page.getByRole('img', { name: 'result.png' })).toBeVisible();
  await page.getByRole('link', { name: 'Printers', exact: true }).click();
  await page.getByRole('link', { name: /Virtual Printer B/ }).click();
  await expect(page.getByText('incompatible', { exact: true })).toBeVisible();
});

async function addCurrentGcodeToQueue(page: import('@playwright/test').Page): Promise<void> {
  await selectFirstRealOption(page.getByRole('combobox', { name: 'Model' }));
  await expect(page.getByRole('combobox', { name: 'Current-version G-code' })).toBeEnabled();
  await selectFirstRealOption(page.getByRole('combobox', { name: 'Current-version G-code' }));
  await page.getByRole('button', { name: 'Add to queue' }).click();
}

async function selectFirstRealOption(locator: import('@playwright/test').Locator): Promise<void> {
  const value = await locator.locator('option').nth(1).getAttribute('value');
  if (!value) throw new Error('Expected a selectable option');
  await locator.selectOption(value);
}

async function confirmControl(
  page: import('@playwright/test').Page,
  action: 'Pause' | 'Resume' | 'Cancel print',
): Promise<void> {
  await page.getByRole('button', { name: action, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm action' }).click();
}

async function confirmStart(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Review & start' }).click();
  await expect(page.getByRole('dialog')).toContainText('Remote software cannot verify');
  await page.getByRole('button', { name: 'Confirm action' }).click();
}

async function addPrinter(
  page: import('@playwright/test').Page,
  name: string,
  url: string,
  buildWidth = 220,
): Promise<void> {
  await page.getByRole('button', { name: 'Add printer' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('OctoPrint URL').fill(url);
  await page.getByLabel('API key').fill('acceptance-api-key');
  await page.getByLabel('Width / diameter (mm)').fill(String(buildWidth));
  await page.getByLabel('Depth (mm)').fill(String(buildWidth));
  await page.getByRole('button', { name: 'Verify and add' }).click();
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
}

async function requiredHref(locator: import('@playwright/test').Locator): Promise<string> {
  const href = await locator.getAttribute('href');
  if (!href) throw new Error('Expected a download link');
  return href;
}
