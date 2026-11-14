// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const htmlPath = resolve(import.meta.dirname, '../public/index.html');
const rawHtml = readFileSync(htmlPath, 'utf8');
const bodyMatch = rawHtml.match(/<body>([\s\S]*)<\/body>/);
const bodyMarkup = bodyMatch?.[1] ?? '';

function stubMatchMedia(prefersDark = false): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('settings menu & run speed UI (public/index.html + src/main.ts)', () => {
  let mounted: { dispose(): void } | null = null;

  async function boot(): Promise<void> {
    const mod = await import('../src/main');
    mounted = mod.app;
  }

  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    Object.defineProperty(window.navigator, 'languages', {
      value: ['ru-RU'],
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'language', {
      value: 'ru-RU',
      configurable: true,
    });
    document.documentElement.lang = 'ru';
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeChoice;
    document.body.innerHTML = bodyMarkup;
    stubMatchMedia(false);
    // jsdom does not implement HTMLDialogElement.showModal/close natively.
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
      dialog.showModal = () => {
        dialog.setAttribute('open', '');
      };
      dialog.close = () => {
        dialog.removeAttribute('open');
        dialog.dispatchEvent(new Event('close'));
      };
    }
  });

  afterEach(() => {
    mounted?.dispose();
    mounted = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  it('toggles the settings menu via the gear button, closes on Escape and outside pointerdown', async () => {
    await boot();

    const gearBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const menu = document.querySelector<HTMLElement>('#settings-menu')!;
    const title = document.querySelector<HTMLElement>('#app-title')!;

    expect(menu.hidden).toBe(true);
    expect(gearBtn.getAttribute('aria-expanded')).toBe('false');

    gearBtn.click();
    expect(menu.hidden).toBe(false);
    expect(gearBtn.getAttribute('aria-expanded')).toBe('true');

    // Escape closes the settings menu and restores focus to the gear button.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(gearBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(gearBtn);

    // Re-open and close by clicking outside.
    gearBtn.click();
    expect(menu.hidden).toBe(false);
    title.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(true);
  });

  it('switches language with a button, theme, sound, minSpeed, and maxSpeed and persists all to localStorage', async () => {
    await boot();

    const gearBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const langBtn = document.querySelector<HTMLButtonElement>('#btn-lang')!;
    const darkBtn = document.querySelector<HTMLButtonElement>('#btn-theme-dark')!;
    const soundBtn = document.querySelector<HTMLButtonElement>('#btn-sound')!;
    const minSpeedInput = document.querySelector<HTMLInputElement>('#input-min-speed')!;
    const maxSpeedInput = document.querySelector<HTMLInputElement>('#input-max-speed')!;
    const speedSlider = document.querySelector<HTMLInputElement>('#input-speed')!;
    const startBtn = document.querySelector<HTMLButtonElement>('#btn-start')!;

    gearBtn.click();

    // Language switch button toggles RU -> EN.
    expect(langBtn.textContent?.trim()).toBe('Русский');
    langBtn.click();
    expect(langBtn.textContent?.trim()).toBe('English');
    expect(document.documentElement.lang).toBe('en');
    expect(startBtn.textContent?.trim()).toBe('Start');

    // Theme segmented button switches to dark.
    darkBtn.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeChoice).toBe('dark');
    expect(darkBtn.getAttribute('aria-pressed')).toBe('true');

    // Sound switch toggles ON (toggle switch relies on aria-checked, no redundant On/Off text).
    expect(soundBtn.getAttribute('aria-checked')).toBe('false');
    expect(soundBtn.textContent?.trim()).toBe('');
    soundBtn.click();
    expect(soundBtn.getAttribute('aria-checked')).toBe('true');
    expect(soundBtn.textContent?.trim()).toBe('');

    // Min & Max speed in settings default to -15 and 25 and update the slider bounds.
    expect(minSpeedInput.value).toBe('-15');
    expect(maxSpeedInput.value).toBe('25');
    expect(speedSlider.min).toBe('-15');
    expect(speedSlider.max).toBe('25');

    minSpeedInput.value = '-20';
    minSpeedInput.dispatchEvent(new Event('input', { bubbles: true }));
    minSpeedInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(speedSlider.min).toBe('-20');

    maxSpeedInput.value = '40';
    maxSpeedInput.dispatchEvent(new Event('input', { bubbles: true }));
    maxSpeedInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(speedSlider.max).toBe('40');

    // All settings are stored in localStorage under `jstu4:settings`.
    const raw = window.localStorage.getItem('jstu4:settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      lang: 'en',
      theme: 'dark',
      sound: true,
      speed: 1,
      minSpeed: -20,
      maxSpeed: 40,
    });
  });

  it('supports media-player Play/Stop, ←/→ step arrows, yellow reverse highlight, zero-bar stop, and restart', async () => {
    vi.useFakeTimers();
    await boot();

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const programView = document.querySelector<HTMLElement>('#display-program')!;
    const startBtn = document.querySelector<HTMLButtonElement>('#btn-start')!;
    const stepBackBtn = document.querySelector<HTMLButtonElement>('#btn-step-back')!;
    const stepBtn = document.querySelector<HTMLButtonElement>('#btn-step')!;
    const runToggleBtn = document.querySelector<HTMLButtonElement>('#btn-run-toggle')!;
    const restartBtn = document.querySelector<HTMLButtonElement>('#btn-restart')!;
    const speedControl = document.querySelector<HTMLElement>('#speed-control')!;
    const speedSlider = document.querySelector<HTMLInputElement>('#input-speed')!;
    const speedValue = document.querySelector<HTMLElement>('#speed-value')!;
    const log = document.querySelector<HTMLElement>('#log')!;
    const stats = document.querySelector<HTMLElement>('#stats')!;

    programInput.value = '0, ,>,0';
    startBtn.click();

    // Uniform arrow + Play/Stop icon buttons.
    expect(stepBackBtn.textContent?.trim()).toBe('←');
    expect(stepBtn.textContent?.trim()).toBe('→');
    expect(stepBackBtn.disabled).toBe(true);
    expect(restartBtn.disabled).toBe(true);
    expect(runToggleBtn.dataset.state).toBe('play');
    expect(runToggleBtn.getAttribute('aria-label')).toBe('Запуск');
    expect(runToggleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(runToggleBtn.querySelector('.btn__media-icon--play')).not.toBeNull();
    expect(runToggleBtn.querySelector('.btn__media-icon--stop')).not.toBeNull();
    expect(programView.dataset.stepDir).toBe('forward');
    expect(speedSlider.min).toBe('-15');
    expect(speedSlider.max).toBe('25');
    expect(speedSlider.value).toBe('1');
    expect(speedValue.textContent).toBe('1×');
    expect(speedControl.dataset.direction).toBe('forward');
    expect(speedControl.style.getPropertyValue('--zero-ratio')).toBe('0.375');
    expect(document.querySelector('#speed-zero')).not.toBeNull();

    // Click Play (▶) -> switches to Stop (■) and STAYS on Stop across multiple ticks!
    runToggleBtn.click();
    expect(runToggleBtn.dataset.state).toBe('stop');
    expect(runToggleBtn.getAttribute('aria-label')).toBe('Стоп');
    expect(runToggleBtn.getAttribute('aria-pressed')).toBe('true');

    vi.advanceTimersByTime(600);
    expect(stats.textContent).toContain('Выполнено операций: 3');
    expect(runToggleBtn.dataset.state).toBe('stop');
    expect(runToggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(programView.dataset.stepDir).toBe('forward');
    expect(stepBackBtn.disabled).toBe(false);
    expect(restartBtn.disabled).toBe(false);

    // Move slider to 0 -> stops execution and sets direction='stopped'.
    speedSlider.value = '0';
    speedSlider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(speedValue.textContent).toBe('0×');
    expect(speedControl.dataset.direction).toBe('stopped');
    expect(runToggleBtn.dataset.state).toBe('play');
    expect(runToggleBtn.getAttribute('aria-label')).toBe('Запуск');
    expect(runToggleBtn.disabled).toBe(true);

    // Click ← (Step back) -> decrements operationsCount and switches highlight to yellow ('reverse').
    stepBackBtn.click();
    expect(stats.textContent).toContain('Выполнено операций: 2');
    expect(programView.dataset.stepDir).toBe('reverse');

    // Slide to -2.5× -> direction='reverse', click Play -> rewinds in yellow to 0 and shows notice.
    speedSlider.value = '-2.5';
    speedSlider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(speedValue.textContent).toBe('-2.5×');
    expect(speedControl.dataset.direction).toBe('reverse');
    expect(runToggleBtn.disabled).toBe(false);

    runToggleBtn.click();
    expect(runToggleBtn.dataset.state).toBe('stop');
    vi.advanceTimersByTime(200);
    expect(stats.textContent).toContain('Выполнено операций: 0');
    expect(programView.dataset.stepDir).toBe('reverse');
    expect(log.textContent).toBe('Машина достигла начального состояния');
    expect(runToggleBtn.dataset.state).toBe('play');
    expect(stepBackBtn.disabled).toBe(true);
    expect(stepBtn.disabled).toBe(false);

    // Step forward (→) switches back to green ('forward'); Restart returns to step 0 in green.
    stepBtn.click();
    expect(stats.textContent).toContain('Выполнено операций: 1');
    expect(programView.dataset.stepDir).toBe('forward');
    restartBtn.click();
    expect(stats.textContent).toContain('Выполнено операций: 0');
    expect(programView.dataset.stepDir).toBe('forward');
    expect(log.textContent).toBe('Машина перезапущена');

    const stored = JSON.parse(window.localStorage.getItem('jstu4:settings') ?? '{}') as {
      speed?: number;
    };
    expect(stored.speed).toBe(-2.5);
  });

  it('houses #log, #stats, and #hint inside a collapsible right-hand #sidepanel toggled next to ?', async () => {
    await boot();

    const appShell = document.querySelector<HTMLElement>('#app-shell')!;
    const helpBtn = document.querySelector<HTMLButtonElement>('#btn-help')!;
    const sidepanelBtn = document.querySelector<HTMLButtonElement>('#btn-sidepanel')!;
    const sidepanel = document.querySelector<HTMLElement>('#sidepanel')!;
    const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
    const log = document.querySelector<HTMLElement>('#log')!;
    const stats = document.querySelector<HTMLElement>('#stats')!;
    const hint = document.querySelector<HTMLElement>('#hint')!;
    const startBtn = document.querySelector<HTMLButtonElement>('#btn-start')!;
    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;

    // Toggle button sits immediately after ? in the top bar.
    expect(helpBtn.nextElementSibling).toBe(sidepanelBtn);

    // #log, #stats, and #hint live in #sidepanel (and #hint is NOT in .toolbar).
    expect(sidepanel.contains(log)).toBe(true);
    expect(sidepanel.contains(stats)).toBe(true);
    expect(sidepanel.contains(hint)).toBe(true);
    expect(toolbar.contains(hint)).toBe(false);
    expect(document.documentElement.dir).toBe('ltr');

    // Hovering a toolbar button updates #hint inside #sidepanel.
    // jsdom sets offsetParent === null by default; stub it so syncHint sees visible buttons.
    Object.defineProperty(startBtn, 'offsetParent', { value: toolbar, configurable: true });
    startBtn.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hint.textContent).toBe('Разобрать программу и запустить её (Ctrl+Enter)');
    startBtn.dispatchEvent(new MouseEvent('mouseleave'));
    expect(hint.textContent).toBe('');

    // Clicking the toggle collapses the side panel and persists sidepanelOpen: false.
    expect(sidepanel.hidden).toBe(false);
    expect(appShell.dataset.sidepanel).toBe('open');
    sidepanelBtn.click();
    expect(sidepanel.hidden).toBe(true);
    expect(appShell.dataset.sidepanel).toBe('closed');
    expect(sidepanelBtn.getAttribute('aria-expanded')).toBe('false');
    expect(
      (
        JSON.parse(window.localStorage.getItem('jstu4:settings') ?? '{}') as {
          sidepanelOpen?: boolean;
        }
      ).sidepanelOpen,
    ).toBe(false);

    // Triggering a compile error automatically opens the side panel so errors are never missed.
    programInput.value = '???';
    startBtn.click();
    expect(sidepanel.hidden).toBe(false);
    expect(appShell.dataset.sidepanel).toBe('open');
    expect(log.dataset.kind).toBe('error');
  });

  it('restores saved settings from localStorage on load', async () => {
    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({
        lang: 'en',
        theme: 'dark',
        sound: true,
        speed: -3.5,
        minSpeed: -20,
        maxSpeed: 30,
      }),
    );

    await boot();

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('#btn-start')?.textContent?.trim()).toBe('Start');
    expect(document.querySelector('#btn-lang')?.textContent?.trim()).toBe('English');
    expect(document.querySelector('#btn-theme-dark')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#btn-sound')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('#input-speed')?.min).toBe('-20');
    expect(document.querySelector<HTMLInputElement>('#input-speed')?.max).toBe('30');
    expect(document.querySelector<HTMLInputElement>('#input-speed')?.value).toBe('-3.5');
    expect(document.querySelector('#speed-value')?.textContent).toBe('-3.5×');
    expect(document.querySelector<HTMLInputElement>('#input-min-speed')?.value).toBe('-20');
    expect(document.querySelector<HTMLInputElement>('#input-max-speed')?.value).toBe('30');
  });

  it('adjusts minSpeed and maxSpeed with − and + stepper buttons, enforces bounds, and persists', async () => {
    await boot();

    const gearBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const minInput = document.querySelector<HTMLInputElement>('#input-min-speed')!;
    const minDec = document.querySelector<HTMLButtonElement>('#btn-min-speed-dec')!;
    const minInc = document.querySelector<HTMLButtonElement>('#btn-min-speed-inc')!;
    const maxInput = document.querySelector<HTMLInputElement>('#input-max-speed')!;
    const maxDec = document.querySelector<HTMLButtonElement>('#btn-max-speed-dec')!;
    const maxInc = document.querySelector<HTMLButtonElement>('#btn-max-speed-inc')!;
    const speedSlider = document.querySelector<HTMLInputElement>('#input-speed')!;

    gearBtn.click();

    // Min speed starts at -15: − gives -16, + returns to -15.
    minDec.click();
    expect(minInput.value).toBe('-16');
    expect(speedSlider.min).toBe('-16');
    minInc.click();
    minInc.click();
    expect(minInput.value).toBe('-14');
    expect(speedSlider.min).toBe('-14');

    // Max speed starts at 25: + gives 26, − returns to 25 and then 24.
    maxInc.click();
    expect(maxInput.value).toBe('26');
    expect(speedSlider.max).toBe('26');
    maxDec.click();
    maxDec.click();
    expect(maxInput.value).toBe('24');
    expect(speedSlider.max).toBe('24');

    // Verify boundary disabling at -1 (for minSpeed +) and 1 (for maxSpeed −).
    minInput.value = '-1';
    minInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(minInc.disabled).toBe(true);
    expect(minDec.disabled).toBe(false);

    maxInput.value = '1';
    maxInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(maxDec.disabled).toBe(true);
    expect(maxInc.disabled).toBe(false);

    const stored = JSON.parse(window.localStorage.getItem('jstu4:settings') ?? '{}') as {
      minSpeed?: number;
      maxSpeed?: number;
    };
    expect(stored.minSpeed).toBe(-1);
    expect(stored.maxSpeed).toBe(1);
  });

  it('shows converted TU4 code in a popup dialog without modifying the source program', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await boot();

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const toTu4Btn = document.querySelector<HTMLButtonElement>('#btn-totu4')!;
    const tu4Dialog = document.querySelector<HTMLDialogElement>('#tu4-dialog')!;
    const tu4Output = document.querySelector<HTMLTextAreaElement>('#tu4-output')!;
    const tu4Status = document.querySelector<HTMLElement>('#tu4-status')!;
    const tu4CopyBtn = document.querySelector<HTMLButtonElement>('#btn-tu4-copy')!;
    const tu4DoneBtn = document.querySelector<HTMLButtonElement>('#btn-tu4-done')!;

    const source = 'fin, ,#,fin\n0, ,>,fin';
    programInput.value = source;

    expect(tu4Dialog.open).toBe(false);
    toTu4Btn.click();

    // Source program stays completely unchanged while the modal displays TU4 output.
    expect(programInput.value).toBe(source);
    expect(tu4Dialog.open).toBe(true);
    expect(tu4Output.readOnly).toBe(true);
    expect(tu4Output.value).toBe('01, ,#,01\n00, ,>,01');

    // Copy button copies converted code and displays confirmation inside the popup.
    tu4CopyBtn.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('01, ,#,01\n00, ,>,01');
      expect(tu4Status.textContent).toBe('Код TU4 скопирован в буфер обмена');
    });

    // Closing the dialog clears the status and keeps original program intact.
    tu4DoneBtn.click();
    expect(tu4Dialog.open).toBe(false);
    expect(tu4Status.textContent).toBe('');
    expect(programInput.value).toBe(source);
  });
});
