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

describe('settings menu UI (public/index.html + src/main.ts)', () => {
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

  it('switches language with a button, theme, and sound and persists all to localStorage', async () => {
    await import('../src/main');

    const gearBtn = document.querySelector<HTMLButtonElement>('#btn-settings')!;
    const langBtn = document.querySelector<HTMLButtonElement>('#btn-lang')!;
    const darkBtn = document.querySelector<HTMLButtonElement>('#btn-theme-dark')!;
    const soundBtn = document.querySelector<HTMLButtonElement>('#btn-sound')!;
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

    // All three settings are stored in localStorage under `jstu4:settings`.
    const raw = window.localStorage.getItem('jstu4:settings');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      lang: 'en',
      theme: 'dark',
      sound: true,
    });
  });

  it('restores saved settings from localStorage on load', async () => {
    window.localStorage.setItem(
      'jstu4:settings',
      JSON.stringify({ lang: 'en', theme: 'dark', sound: true }),
    );

    await import('../src/main');

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('#btn-start')?.textContent?.trim()).toBe('Start');
    expect(document.querySelector('#btn-lang')?.textContent?.trim()).toBe('English');
    expect(document.querySelector('#btn-theme-dark')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#btn-sound')?.getAttribute('aria-checked')).toBe('true');
  });
});
