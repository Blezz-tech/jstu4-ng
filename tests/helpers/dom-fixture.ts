import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

const htmlPath = resolve(import.meta.dirname, '../../public/index.html');
const rawHtml = readFileSync(htmlPath, 'utf8');
const bodyMarkup = rawHtml.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';

export interface MockMql {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  fireChange(nextMatches: boolean): void;
}

/**
 * Reset jsdom globals, inject `public/index.html` body markup, polyfill
 * `<dialog>` modal APIs, and stub `window.matchMedia` with a controllable mock.
 */
export function setupAppDom(prefersDark = false): MockMql {
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

  const listeners = new Set<() => void>();
  const mql: MockMql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((_type: string, cb: () => void) => {
      listeners.add(cb);
    }),
    removeEventListener: vi.fn((_type: string, cb: () => void) => {
      listeners.delete(cb);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    fireChange(nextMatches: boolean) {
      mql.matches = nextMatches;
      for (const cb of listeners) cb();
    },
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      ...mql,
      media: query,
      get matches(): boolean {
        return mql.matches && query.includes('dark');
      },
    })),
  );

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

  return mql;
}

export function teardownAppDom(): void {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.innerHTML = '';
}
