import { test } from '@playwright/test';

/**
 * Manual visual check: writes screenshots for the main modes, themes and
 * languages into `screenshots/`. Run with `npx playwright test e2e/visual.spec.ts`
 * (excluded from the default run because it produces artifacts).
 */
const SWAP = [
  '00, ,<,rep',
  'rep,0,1,mov  rep,1,0,mov  rep, ,>,fin  // rewrite the cell',
  'mov,0,<,rep  mov,1,<,rep               // step left',
  'fin,0,>,fin  fin,1,>,fin  fin, ,#,fin  // move after the word',
].join('\n');

test.describe('screenshots', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const lang of ['ru', 'en'] as const) {
      test(`edit mode, ${theme}, ${lang}`, async ({ page }) => {
        await page.addInitScript(() => window.localStorage.clear());
        await page.goto(`/?lang=${lang}`);
        await page.evaluate((value) => {
          localStorage.setItem('jstu4:program', value);
        }, SWAP);
        await page.reload();
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `screenshots/edit-${theme}-${lang}.png`, fullPage: false });
      });
    }
  }

  test('run mode with visited marks', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto('/');
    await page.locator('#input-program').fill(SWAP);
    await page.locator('#input-tape').fill(' 0110');
    await page.locator('#btn-start').click();
    for (let i = 0; i < 8; i += 1) await page.locator('#btn-step').click();
    await page.screenshot({ path: 'screenshots/run.png' });
  });

  test('error mode', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto('/');
    await page.locator('#input-program').fill('0,1,>,1\n0,1,<,1');
    await page.locator('#btn-start').click();
    await page.screenshot({ path: 'screenshots/error.png' });
  });

  test('help dialog', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto('/');
    await page.keyboard.press('F1');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/help.png' });
  });

  test('mobile', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.screenshot({ path: 'screenshots/mobile.png' });
  });
});
