import { expect, test } from '@playwright/test';

/**
 * Visual screenshot generator: writes up-to-date screenshots for the main modes,
 * panels, dialogs, themes and languages into `screenshots/`.
 * Run with `npm run shots` (excluded from the default E2E run).
 */
const SWAP = [
  '00, ,<,rep',
  'rep,0,1,mov  rep,1,0,mov  rep, ,>,fin  // rewrite the cell',
  'mov,0,<,rep  mov,1,<,rep               // step left',
  'fin,0,>,fin  fin,1,>,fin  fin, ,#,fin  // move after the word',
].join('\n');

test.describe('screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('shots-cleared')) {
        window.localStorage.clear();
        window.sessionStorage.setItem('shots-cleared', '1');
      }
    });
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const lang of ['ru', 'en'] as const) {
      test(`edit mode, ${theme}, ${lang}`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`/?lang=${lang}`);
        await page.locator('#input-program').fill(SWAP);
        await page.locator('#input-tape').fill(' 0110');
        await page.locator('#input-tape').blur();
        await page.waitForTimeout(150);
        await page.screenshot({ path: `screenshots/edit-${theme}-${lang}.png`, fullPage: false });
      });
    }
  }

  test('run mode with visited marks', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.locator('#input-program').fill(SWAP);
    await page.locator('#input-tape').fill(' 0110');
    await page.locator('#btn-start').click();
    for (let i = 0; i < 8; i += 1) await page.locator('#btn-step').click();
    await page.locator('#btn-step').blur();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/run.png' });
  });

  test('error mode', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.locator('#input-program').fill('0,1,>,1\n0,1,<,1');
    await page.locator('#btn-start').click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/error.png' });
  });

  test('help dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.locator('#input-program').fill(SWAP);
    await page.locator('#input-tape').fill(' 0110');
    await page.keyboard.press('F1');
    await expect(page.locator('#help-dialog')).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/help.png' });
  });

  test('settings menu', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.locator('#input-program').fill(SWAP);
    await page.locator('#input-tape').fill(' 0110');
    await page.locator('#btn-settings').click();
    await expect(page.locator('#settings-menu')).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/settings.png' });
  });

  test('version history panel', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 820 });
    await page.goto('/');
    await page.locator('#btn-history').click();
    await expect(page.locator('#history-panel')).toBeVisible();

    await page.locator('#input-program').fill(SWAP);
    await page.locator('#input-tape').fill(' 0110');
    await page.locator('#btn-save').click();

    await page.locator('#history-list .snapshot-action--rename').first().click();
    const editInput = page.locator('#history-list .snapshot-item__input');
    await editInput.fill('Замена 0 ↔ 1');
    await editInput.press('Enter');

    await page.locator('#input-tape').fill(' 1001');
    await page.locator('#history-list .snapshot-item__load').first().click();
    await expect(page.locator('#history-list .snapshot-item')).toHaveCount(2);
    await page.locator('#input-tape').blur();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/history.png' });
  });

  test('mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.locator('#input-program').fill(SWAP);
    await page.locator('#input-program').evaluate((node) => {
      node.scrollLeft = 0;
      node.scrollTop = 0;
    });
    await page.locator('#input-tape').fill(' 0110');
    await page.locator('#input-tape').blur();
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/mobile.png' });
  });
});
