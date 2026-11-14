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
    const dialog = document.querySelector<HTMLDialogElement>('#help-dialog')!;
    dialog.showModal = () => {
      dialog.setAttribute('open', '');
    };
    dialog.close = () => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  it('toggles the settings menu via the gear button, closes on Escape and outside pointerdown', async () => {
    await import('../src/main');

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

  it('switches language with a button, theme, sound, and maxSpeed and persists all to localStorage', async () => {
    await import('../src/main');

    const gearBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const langBtn = document.querySelector<HTMLButtonElement>('#btn-lang')!;
    const darkBtn = document.querySelector<HTMLButtonElement>('#btn-theme-dark')!;
    const soundBtn = document.querySelector<HTMLButtonElement>('#btn-sound')!;
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

    // Sound switch toggles ON.
    expect(soundBtn.getAttribute('aria-checked')).toBe('false');
    soundBtn.click();
    expect(soundBtn.getAttribute('aria-checked')).toBe('true');
    expect(soundBtn.textContent?.trim()).toBe('On');

    // Max speed in settings updates the speed slider max.
    expect(maxSpeedInput.value).toBe('10');
    expect(speedSlider.max).toBe('10');
    maxSpeedInput.value = '25';
    maxSpeedInput.dispatchEvent(new Event('input', { bubbles: true }));
    maxSpeedInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(speedSlider.max).toBe('25');

    // All settings are stored in localStorage under `jstu4:settings`.
    const raw = window.localStorage.getItem('jstu4:settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      lang: 'en',
      theme: 'dark',
      sound: true,
      speed: 1,
      maxSpeed: 25,
    });
  });

  it('toggles Run/Stop button in run mode and updates speed coefficient via slider', async () => {
    vi.useFakeTimers();
    await import('../src/main');

    const programInput = document.querySelector<HTMLTextAreaElement>('#input-program')!;
    const startBtn = document.querySelector<HTMLButtonElement>('#btn-start')!;
    const runToggleBtn = document.querySelector<HTMLButtonElement>('#btn-run-toggle')!;
    const speedSlider = document.querySelector<HTMLInputElement>('#input-speed')!;
    const speedValue = document.querySelector<HTMLElement>('#speed-value')!;
    const stats = document.querySelector<HTMLElement>('#stats')!;

    programInput.value = '0, ,>,0';
    startBtn.click();

    expect(runToggleBtn.textContent?.trim()).toBe('Запуск');
    expect(runToggleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(speedSlider.min).toBe('0.5');
    expect(speedSlider.max).toBe('10');
    expect(speedSlider.value).toBe('1');
    expect(speedValue.textContent).toBe('1×');

    // Click Запуск -> becomes Стоп and advances steps at 1× (200 ms/step).
    runToggleBtn.click();
    expect(runToggleBtn.textContent?.trim()).toBe('Стоп');
    expect(runToggleBtn.getAttribute('aria-pressed')).toBe('true');

    vi.advanceTimersByTime(400);
    expect(stats.textContent).toContain('Выполнено операций: 2');

    // Change speed slider to 2.5× -> shows 2.5× and persists.
    speedSlider.value = '2.5';
    speedSlider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(speedValue.textContent).toBe('2.5×');

    // Click Стоп -> pauses in run mode without resetting.
    runToggleBtn.click();
    expect(runToggleBtn.textContent?.trim()).toBe('Запуск');
    expect(runToggleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.dataset.mode).toBe('run');

    const stored = JSON.parse(window.localStorage.getItem('jstu4:settings') ?? '{}') as {
      speed?: number;
    };
    expect(stored.speed).toBe(2.5);
  });

  it('places #statusbar (with #log and #stats) above the workspace right below .topbar', async () => {
    await import('../src/main');

    const topbar = document.querySelector('.topbar')!;
    const statusbar = document.querySelector('#statusbar')!;
    const workspace = document.querySelector('.workspace')!;
    const log = document.querySelector('#log')!;
    const stats = document.querySelector('#stats')!;

    expect(statusbar.contains(log)).toBe(true);
    expect(statusbar.contains(stats)).toBe(true);
    expect(
      topbar.compareDocumentPosition(statusbar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      statusbar.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('restores saved settings from localStorage on load', async () => {
    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({ lang: 'en', theme: 'dark', sound: true, speed: 3.5, maxSpeed: 30 }),
    );

    await import('../src/main');

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('#btn-start')?.textContent?.trim()).toBe('Start');
    expect(document.querySelector('#btn-lang')?.textContent?.trim()).toBe('English');
    expect(document.querySelector('#btn-theme-dark')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#btn-sound')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('#input-speed')?.max).toBe('30');
    expect(document.querySelector<HTMLInputElement>('#input-speed')?.value).toBe('3.5');
    expect(document.querySelector('#speed-value')?.textContent).toBe('3.5×');
    expect(document.querySelector<HTMLInputElement>('#input-max-speed')?.value).toBe('30');
  });
});
