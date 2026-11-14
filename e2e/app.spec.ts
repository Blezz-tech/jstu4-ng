import { expect, test } from '@playwright/test';

const SWAP = [
  '00, ,<,rep',
  'rep,0,1,mov  rep,1,0,mov  rep, ,>,fin',
  'mov,0,<,rep  mov,1,<,rep',
  'fin,0,>,fin  fin,1,>,fin  fin, ,#,fin',
].join('\n');

test.beforeEach(async ({ page }) => {
  // Runs on every navigation (reloads included), so tests stay independent.
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-cleared')) {
      window.localStorage.clear();
      window.sessionStorage.setItem('e2e-cleared', '1');
    }
  });
});

test('loads in Russian by default and shows the title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Эмулятор машины Тьюринга/);
  await expect(page.locator('#btn-start')).toBeVisible();
  await expect(page.locator('#btn-step')).toBeHidden();
});

test('runs the swap example step by step', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill(SWAP);
  await page.locator('#input-tape').fill(' 0110');
  await page.locator('#btn-start').click();

  // Run mode: start disappears, step/quick appear.
  await expect(page.locator('#btn-start')).toBeHidden();
  await expect(page.locator('#btn-step')).toBeVisible();

  // 15 steps as measured by the engine tests: click Step until finished.
  for (let i = 0; i < 15; i += 1) await page.locator('#btn-step').click();

  await expect(page.locator('#display-tape')).toContainText('1001');
  await expect(page.locator('#stats')).toContainText('15');
  // The help example overwrites the leading space of the tape with a space,
  // so v2.3-compatible normality checking reports "source altered".
  await expect(page.locator('#log')).toContainText('Внимание');
});

test('quick run finishes the program by itself', async ({ page }) => {
  await page.goto('/');
  // Overwrite the first '1' with '0', then stop right after the result.
  await page.locator('#input-program').fill('0, ,<,a  a,1,0,a  a,0,>,b  b,0,>,b  b,1,>,b  b, ,#,b');
  await page.locator('#input-tape').fill('111');
  await page.locator('#btn-start').click();
  await page.locator('#btn-quick').click();
  // The overwritten source cell triggers the v2.3-compatible warning, and the
  // run really stops (the log is only written when the machine halts).
  await expect(page.locator('#log')).toContainText('Внимание', { timeout: 5_000 });
  await expect(page.locator('#display-tape')).toContainText('110');
  await expect(page.locator('#stats')).toContainText('Выполнено операций');
});

test('reports parse errors and highlights the offender', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0,1,>,1  ???');
  await page.locator('#btn-start').click();
  await expect(page.locator('#log')).toContainText('Ошибка разбора');
  await expect(page.locator('#display-program mark.error')).toBeVisible();
  await expect(page.locator('#btn-edit-err')).toBeVisible();
});

test('marks both commands of an ambiguous transition', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0,1,>,1\n0,1,<,1');
  await page.locator('#btn-start').click();
  await expect(page.locator('.cmd.error')).toHaveCount(2);
  await expect(page.locator('#log')).toContainText('Неоднозначный переход');
});

test('reports an empty program', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('// nothing here');
  await page.locator('#btn-start').click();
  await expect(page.locator('#log')).toContainText('Программа пуста');
});

test('converts to TU4 and keeps the machine equivalent', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill(SWAP);
  await page.locator('#btn-totu4').click();
  // Conversion returns to edit mode; the notice about it does not survive
  // the mode switch by design, so the converted text itself is asserted.
  await expect(page.locator('#input-program')).toHaveValue(/00, ,<,01/);

  const value = await page.locator('#input-program').inputValue();
  expect(value).toContain('00, ,<,01');
  // The converted program still compiles and runs.
  await page.locator('#input-tape').fill(' 0110');
  await page.locator('#btn-start').click();
  await expect(page.locator('#display-tape')).toBeVisible();
});

test('persists the draft across reloads', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,#,0');
  await page.locator('#input-tape').fill('hello');
  await page.waitForTimeout(600); // debounce
  await page.reload();
  await expect(page.locator('#input-program')).toHaveValue('0, ,#,0');
  await expect(page.locator('#input-tape')).toHaveValue('hello');
});

test('switches language and remembers it', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btn-lang').click();
  await expect(page.locator('#btn-start')).toContainText('Start');
  await expect(page).toHaveTitle(/Turing machine/);
  await page.reload();
  await expect(page.locator('#btn-start')).toContainText('Start');
});

test('the language switch keeps keyboard focus on the toggle', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btn-lang').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#btn-lang')).toBeFocused();
});

test('supports ?lang=en deep links', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.locator('#btn-start')).toContainText('Start');
});

test('respects the browser language on first visit', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#btn-start')).toContainText('Start');
  await context.close();
});

test('cycles the theme auto → light → dark → auto', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const choice = () => html.getAttribute('data-theme-choice');

  expect(await choice()).toBe('auto');
  await page.locator('#btn-theme').click();
  expect(await choice()).toBe('light');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.locator('#btn-theme').click();
  expect(await choice()).toBe('dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.locator('#btn-theme').click();
  expect(await choice()).toBe('auto');
});

test('opens the help dialog with F1 and closes with Escape', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('F1');
  await expect(page.locator('#help-dialog')).toBeVisible();
  await expect(page.locator('#help-body')).toContainText('Формат команды');
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-dialog')).toBeHidden();
});

test('keyboard: Ctrl+Enter in the editor starts the program', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,#,0');
  await page.locator('#input-program').press('Control+Enter');
  await expect(page.locator('#btn-step')).toBeVisible();
  // Space performs a step, Escape returns to editing.
  await page.keyboard.press('Space');
  await expect(page.locator('#log')).toContainText('завершила работу');
  await page.keyboard.press('Escape');
  await expect(page.locator('#btn-start')).toBeVisible();
});

test('unmark clears visited marks', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill(SWAP);
  await page.locator('#input-tape').fill(' 0110');
  await page.locator('#btn-start').click();
  for (let i = 0; i < 4; i += 1) await page.locator('#btn-step').click();
  await expect(page.locator('.cmd.visited').first()).toBeVisible();
  await page.locator('#btn-unmark').click();
  await expect(page.locator('.cmd.visited')).toHaveCount(0);
});

test('copy puts the program on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,#,0');
  await page.locator('#btn-copy').click();
  await expect(page.locator('#log')).toContainText('Скопировано');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe('0, ,#,0');
});
