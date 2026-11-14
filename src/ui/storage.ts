import { isLang, type Lang } from '../i18n';

const PREFIX = 'jstu4:';
const KEYS = {
  program: `${PREFIX}program`,
  tape: `${PREFIX}tape`,
  lang: `${PREFIX}lang`,
  theme: `${PREFIX}theme`,
  sound: `${PREFIX}sound`,
} as const;

export type Theme = 'auto' | 'light' | 'dark';

export interface SavedState {
  readonly program: string | null;
  readonly tape: string | null;
  readonly lang: Lang | null;
  readonly theme: Theme;
  readonly sound: boolean;
}

/**
 * `localStorage` wrapper that never throws: private mode, disabled storage and
 * quota errors all degrade to an in-memory no-op (the app keeps working, it
 * just does not remember anything).
 */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage is unavailable — ignore */
  }
}

export function loadState(): SavedState {
  const theme = read(KEYS.theme);
  const lang = read(KEYS.lang);
  return {
    program: read(KEYS.program),
    tape: read(KEYS.tape),
    lang: isLang(lang) ? lang : null,
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    sound: read(KEYS.sound) === '1',
  };
}

export function saveProgram(text: string): void {
  write(KEYS.program, text === '' ? null : text);
}

export function saveTape(text: string): void {
  write(KEYS.tape, text === '' ? null : text);
}

export function saveLang(lang: Lang): void {
  write(KEYS.lang, lang);
}

export function saveTheme(theme: Theme): void {
  write(KEYS.theme, theme);
}

export function saveSound(enabled: boolean): void {
  write(KEYS.sound, enabled ? '1' : '0');
}
