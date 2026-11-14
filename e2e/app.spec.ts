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
  // The help example overwrites 0110 with 1001 in place ("ненормированная замена"),
  // so v2.3-compatible normality checking reports "source altered".
  await expect(page.locator('#log')).toContainText('Внимание');
});

test('auto-run (Запуск/Стоп) finishes, supports reverse speed & restart from end', async ({
  page,
}) => {
  await page.goto('/');
  // Overwrite the first '1' with '0', then stop right after the result.
  await page.locator('#input-program').fill('0, ,<,a  a,1,0,a  a,0,>,b  b,0,>,b  b,1,>,b  b, ,#,b');
  await page.locator('#input-tape').fill('111');
  await page.locator('#btn-start').click();

  // Default speed is 1× (range -15× to 25×), media button is in Play state.
  await expect(page.locator('#btn-run-toggle')).toHaveAttribute('data-state', 'play');
  await expect(page.locator('#btn-run-toggle')).toHaveAttribute('aria-label', 'Запуск');
  await expect(page.locator('#speed-value')).toHaveText('1×');
  await expect(page.locator('#input-speed')).toHaveAttribute('min', '-15');
  await expect(page.locator('#input-speed')).toHaveAttribute('max', '25');
  await expect(page.locator('#btn-step-back')).toBeDisabled();

  // Raise speed to 10× via the slider.
  await page.locator('#input-speed').fill('10');
  await expect(page.locator('#speed-value')).toHaveText('10×');

  await page.locator('#btn-run-toggle').click();
  // The overwritten source cell triggers the v2.3-compatible warning, and the
  // run really stops (the log is only written when the machine halts).
  await expect(page.locator('#log')).toContainText('Внимание', { timeout: 5_000 });
  await expect(page.locator('#btn-run-toggle')).toBeDisabled();
  await expect(page.locator('#btn-step-back')).toBeEnabled();
  await expect(page.locator('#btn-restart')).toBeEnabled();
  await expect(page.locator('#display-tape')).toContainText('110');

  // Switch slider to negative speed and run in reverse back to step 0 (yellow highlight)!
  await page.locator('#input-speed').fill('-15');
  await expect(page.locator('#speed-value')).toHaveText('-15×');
  await expect(page.locator('#btn-run-toggle')).toBeEnabled();
  await page.locator('#btn-run-toggle').click();
  await expect(page.locator('#display-program')).toHaveAttribute('data-step-dir', 'reverse');
  await expect(page.locator('#log')).toContainText('начального состояния', { timeout: 5_000 });
  await expect(page.locator('#display-tape')).toContainText('111');
  await expect(page.locator('#btn-step-back')).toBeDisabled();
});

test('Play/Stop icon toggle, zero stop, and configurable min/max speed bounds in settings', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,>,0');
  await page.locator('#input-tape').fill('');
  await page.locator('#btn-start').click();

  // Start auto-run: button switches from Play (▶) to Stop (■) without changing width.
  const beforeBox = (await page.locator('#btn-run-toggle').boundingBox())!;
  await page.locator('#btn-run-toggle').click();
  await expect(page.locator('#btn-run-toggle')).toHaveAttribute('data-state', 'stop');
  await expect(page.locator('#btn-run-toggle')).toHaveAttribute('aria-pressed', 'true');
  const afterBox = (await page.locator('#btn-run-toggle').boundingBox())!;
  expect(afterBox.width).toBeCloseTo(beforeBox.width, 1);

  // Moving slider to 0 stops execution immediately.
  await page.locator('#input-speed').fill('0');
  await expect(page.locator('#speed-value')).toHaveText('0×');
  await expect(page.locator('#btn-run-toggle')).toHaveAttribute('data-state', 'play');
  await expect(page.locator('#btn-run-toggle')).toBeDisabled();
  await expect(page.locator('#btn-step')).toBeEnabled();

  // Change min & max speed in settings and verify the slider range & persistence.
  await page.locator('#btn-settings').click();
  await page.locator('#input-min-speed').fill('-30');
  await page.locator('#input-max-speed').fill('50');
  await page.locator('#input-max-speed').press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('#input-speed')).toHaveAttribute('min', '-30');
  await expect(page.locator('#input-speed')).toHaveAttribute('max', '50');

  await page.locator('#input-speed').fill('-20');
  await expect(page.locator('#speed-value')).toHaveText('-20×');

  await page.reload();
  await page.locator('#input-program').fill('0, ,>,0');
  await page.locator('#btn-start').click();
  await expect(page.locator('#input-speed')).toHaveAttribute('min', '-30');
  await expect(page.locator('#input-speed')).toHaveAttribute('max', '50');
  await expect(page.locator('#speed-value')).toHaveText('-20×');
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

test('opens TU4 popup without modifying source program, preserves state 0 as 00, and copies TU4 code', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.locator('#input-program').fill(SWAP);
  await page.locator('#btn-totu4').click();

  // Original editor source stays untouched while popup shows the TU4 output.
  await expect(page.locator('#input-program')).toHaveValue(SWAP);
  await expect(page.locator('#tu4-dialog')).toBeVisible();
  await expect(page.locator('#tu4-output')).toHaveValue(/00, ,<,01/);
  await expect(page.locator('#log')).toContainText('TU4');

  // Copy button inside the popup copies the TU4 text.
  await page.locator('#btn-tu4-copy').click();
  await expect(page.locator('#tu4-status')).toContainText('TU4');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/00, ,<,01/);

  await page.locator('#btn-tu4-done').click();
  await expect(page.locator('#tu4-dialog')).toBeHidden();

  // Even when state 0 is not on the first line, it stays 00 and source remains untouched.
  const source = 'fin, ,#,fin\n0, ,>,fin';
  await page.locator('#input-program').fill(source);
  await page.locator('#btn-totu4').click();
  await expect(page.locator('#input-program')).toHaveValue(source);
  await expect(page.locator('#tu4-output')).toHaveValue('01, ,#,01\n00, ,>,01');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tu4-dialog')).toBeHidden();

  // The untouched source program still compiles and runs.
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

test('opens settings menu with the gear button and closes on Escape or outside click', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#settings-menu')).toBeHidden();
  await expect(page.locator('#btn-settings')).toHaveAttribute('aria-expanded', 'false');

  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-menu')).toBeVisible();
  await expect(page.locator('#btn-settings')).toHaveAttribute('aria-expanded', 'true');

  // Escape closes the settings menu and restores focus to the gear button.
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-menu')).toBeHidden();
  await expect(page.locator('#btn-settings')).toBeFocused();

  // Clicking outside closes the settings menu.
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-menu')).toBeVisible();
  await page.locator('#app-title').click();
  await expect(page.locator('#settings-menu')).toBeHidden();
});

test('switches language with a button inside settings and persists to localStorage', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#btn-settings').click();
  await expect(page.locator('#btn-lang')).toContainText('Русский');
  await page.locator('#btn-lang').click();
  await expect(page.locator('#btn-lang')).toContainText('English');
  await expect(page.locator('#btn-start')).toContainText('Start');
  await expect(page).toHaveTitle(/Turing machine/);

  const stored = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('jstu4:settings') ?? '{}') as { lang?: string },
  );
  expect(stored.lang).toBe('en');

  await page.reload();
  await expect(page.locator('#btn-start')).toContainText('Start');
});

test('the language switch keeps keyboard focus on the button', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btn-settings').click();
  await page.locator('#btn-lang').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#btn-lang')).toBeFocused();
});

test('supports ?lang=en deep links and keeps language switches across reload', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.locator('#btn-start')).toContainText('Start');
  await page.locator('#btn-settings').click();
  await page.locator('#btn-lang').click();
  await expect(page.locator('#btn-start')).toContainText('Старт');
  await page.reload();
  await expect(page.locator('#btn-start')).toContainText('Старт');
});

test('closing #help removes the hash so reloading does not reopen help', async ({ page }) => {
  await page.goto('/#help');
  await expect(page.locator('#help-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-dialog')).toBeHidden();
  await page.reload();
  await expect(page.locator('#help-dialog')).toBeHidden();
});

test('collapsible right-hand side panel holds #log, #stats, #hint and prevents hover layout shift', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  const appBox = (await page.locator('.app').boundingBox())!;
  const panelBox = (await page.locator('#sidepanel').boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(appBox.x + appBox.width - 1);

  // Hovering toolbar buttons updates #hint inside #sidepanel without moving the program pane.
  const progBefore = (await page.locator('#input-program').boundingBox())!;
  await page.locator('#btn-start').hover();
  await expect(page.locator('#hint')).toContainText('Ctrl+Enter');
  const progAfter = (await page.locator('#input-program').boundingBox())!;
  expect(progAfter.height).toBeCloseTo(progBefore.height, 1);

  // Collapsing the side panel hides it and expands the workspace.
  await page.locator('#btn-sidepanel').click();
  await expect(page.locator('#sidepanel')).toBeHidden();
  await page.locator('#btn-sidepanel').click();
  await expect(page.locator('#sidepanel')).toBeVisible();
});

test('respects the browser language on first visit', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#btn-start')).toContainText('Start');
  await context.close();
});

test('switches theme auto / light / dark in settings and persists to localStorage', async ({
  page,
}) => {
  await page.goto('/');
  const html = page.locator('html');
  const choice = () => html.getAttribute('data-theme-choice');

  expect(await choice()).toBe('auto');
  await page.locator('#btn-settings').click();
  await page.locator('#btn-theme-light').click();
  expect(await choice()).toBe('light');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.locator('#btn-theme-dark').click();
  expect(await choice()).toBe('dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  expect(await choice()).toBe('dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.locator('#btn-settings').click();
  await page.locator('#btn-theme-auto').click();
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

test('Step and Run/Stop are disabled once the machine halts', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,#,0');
  await page.locator('#input-tape').fill('abc');
  await page.locator('#btn-start').click();

  await expect(page.locator('#btn-step')).toBeEnabled();
  await page.locator('#btn-step').click();
  await expect(page.locator('#btn-step')).toBeDisabled();
  await expect(page.locator('#btn-run-toggle')).toBeDisabled();
  await expect(page.locator('body')).toHaveAttribute('data-running', 'false');
});

test('a space symbol is readable in error messages', async ({ page }) => {
  await page.goto('/');
  // Two transitions on the same (space) symbol → ambiguous command.
  await page.locator('#input-program').fill('0, ,>,1  0, ,<,1');
  await page.locator('#btn-start').click();
  await expect(page.locator('#log')).toContainText('␣');
});

test('the program pane never overlaps the tape pane', async ({ page }) => {
  const longProgram = [
    '0, ,>,s1',
    ...Array.from({ length: 118 }, (_, i) => `s${i + 1}, ,>,s${i + 2}`),
    's119, ,#,s119',
  ].join('\n');

  for (const height of [480, 560, 700, 900]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto('/');
    await page.locator('#input-program').fill(longProgram);
    await page.locator('#input-tape').fill('1010');
    await page.locator('#btn-start').click();
    await expect(page.locator('#display-tape')).toBeVisible();

    const tape = (await page.locator('#display-tape').boundingBox())!;
    const label = (await page.locator('#label-program').boundingBox())!;
    expect(tape.y + tape.height).toBeLessThanOrEqual(label.y);
  }
});

test('starting with Enter in the tape field hides #input-tape so run hotkeys work', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,#,0');
  await page.locator('#input-tape').fill('101');
  await page.locator('#input-tape').press('Enter');

  await expect(page.locator('#input-tape')).toBeHidden();
  await expect(page.locator('#display-tape')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('#log')).toContainText('завершила работу');
  await page.keyboard.press('Escape');
  await expect(page.locator('#input-tape')).toBeVisible();
});

test('error mode keeps #input-tape visible, hides #display-tape, and Escape exits after Enter in tape', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#input-program').fill('???');
  await page.locator('#input-tape').fill('101');
  await page.locator('#input-tape').press('Enter');

  await expect(page.locator('#input-tape')).toBeVisible();
  await expect(page.locator('#display-tape')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#input-program')).toBeVisible();
  await expect(page.locator('#input-program')).toBeFocused();
});

test('switching language preserves edited program and active run', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill('0, ,>,1\n1, ,#,1');
  await page.locator('#input-tape').fill('101');
  await page.locator('#btn-settings').click();
  await page.locator('#btn-lang').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#input-program')).toHaveValue('0, ,>,1\n1, ,#,1');

  await page.locator('#btn-start').click();
  await page.locator('#btn-step').click();
  await page.locator('#btn-settings').click();
  await page.locator('#btn-lang').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#btn-step')).toBeVisible();
  await expect(page.locator('#stats')).toContainText('Выполнено операций: 1');
});

test('help dialog is centered in the viewport and sound switch persists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.locator('#btn-settings').click();
  await expect(page.locator('#btn-sound')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#btn-sound').click();
  await expect(page.locator('#btn-sound')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.locator('#btn-settings').click();
  await expect(page.locator('#btn-sound')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await page.keyboard.press('F1');
  const box = (await page.locator('#help-dialog').boundingBox())!;
  expect(box.x).toBeGreaterThan(100);
  expect(box.y).toBeGreaterThan(20);
});

test('unmark followed by step leaves only one current command', async ({ page }) => {
  await page.goto('/');
  await page.locator('#input-program').fill(SWAP);
  await page.locator('#input-tape').fill(' 0110');
  await page.locator('#btn-start').click();
  await page.locator('#btn-step').click();
  await page.locator('#btn-unmark').click();
  await page.locator('#btn-step').click();
  await expect(page.locator('.cmd.current')).toHaveCount(1);
});

test('version control panel saves, renames, filters named-only, restores, and confirms deletion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.goto('/');

  // History button sits immediately to the left of Settings; save button sits after Copy
  const historyBox = (await page.locator('#btn-history').boundingBox())!;
  const settingsBox = (await page.locator('#btn-settings').boundingBox())!;
  expect(historyBox.x + historyBox.width).toBeLessThanOrEqual(settingsBox.x + 2);

  await expect(page.locator('#btn-save')).toBeVisible();
  await expect(page.locator('#history-panel')).toBeHidden();
  await page.locator('#btn-history').click();
  await expect(page.locator('#history-panel')).toBeVisible();

  // Manual save in RU creates an entry with "Сохранено пользователем" in the unified list
  await page.locator('#input-program').fill('0, ,#,0');
  await page.locator('#input-tape').fill('v1');
  await page.locator('#btn-save').click();
  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(1);
  await expect(page.locator('#history-list')).toContainText('Сохранено пользователем');

  // Rename preserves the original creation timestamp
  const originalTitle =
    (await page.locator('#history-list .snapshot-item__title').first().textContent()) ?? '';
  const originalTimestamp = originalTitle.split(' ')[0] ?? '';
  await page.locator('#history-list .snapshot-action--rename').first().click();
  const editInput = page.locator('#history-list .snapshot-item__input');
  await editInput.fill('Baseline v1');
  await editInput.press('Enter');

  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(1);
  await expect(page.locator('#history-list')).toContainText('Baseline v1');
  await expect(page.locator('#history-list')).toContainText(originalTimestamp);

  // Edit code and restore the named snapshot → unsaved edits become an autosave in the same list
  await page.locator('#input-program').fill('0,1,0,0');
  await page.locator('#input-tape').fill('v2');
  await page.locator('#history-list .snapshot-item__load').first().click();
  await expect(page.locator('#input-program')).toHaveValue('0, ,#,0');
  await expect(page.locator('#input-tape')).toHaveValue('v1');
  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(2);
  await expect(page.locator('#history-list')).toContainText('автосохранение');

  // Toggle "Named only" ON → shows only the named snapshot
  await page.locator('#btn-named-only').click();
  await expect(page.locator('#btn-named-only')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(1);
  await expect(page.locator('#history-list')).toContainText('Baseline v1');
  await expect(page.locator('#history-list')).not.toContainText('автосохранение');

  // Toggle back OFF and reload — everything persists in localStorage
  await page.locator('#btn-named-only').click();
  await page.reload();
  await expect(page.locator('#history-panel')).toBeVisible();
  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(2);

  // Deleting shows confirmation dialog with snapshot name and "do not show again" checkbox
  await page
    .locator('#history-list .snapshot-item[data-named="true"] .snapshot-action--delete')
    .first()
    .click();
  await expect(page.locator('#delete-snapshot-dialog')).toBeVisible();
  await expect(page.locator('#delete-snapshot-name')).toHaveText('Baseline v1');
  await page.locator('#chk-skip-delete-confirm').check();
  await page.locator('#btn-confirm-delete-snapshot').click();
  await expect(page.locator('#delete-snapshot-dialog')).toBeHidden();
  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(1);

  // Re-enable confirmation in Settings
  await page.locator('#btn-settings').click();
  await expect(page.locator('#btn-setting-confirm-delete')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.locator('#btn-setting-confirm-delete').click();
  await expect(page.locator('#btn-setting-confirm-delete')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Next delete shows confirmation dialog again
  await page.locator('#history-list .snapshot-action--delete').first().click();
  await expect(page.locator('#delete-snapshot-dialog')).toBeVisible();
  await page.locator('#btn-confirm-delete-snapshot').click();
  await expect(page.locator('#history-list .snapshot-item')).toHaveCount(0);
});
