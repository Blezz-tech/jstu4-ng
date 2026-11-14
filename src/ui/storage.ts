import { isLang, type Lang } from '../i18n';
import {
  clampMaxSpeed,
  clampMinSpeed,
  clampSpeed,
  DEFAULT_MAX_SPEED,
  DEFAULT_MIN_SPEED,
  DEFAULT_SPEED,
} from './speed';

const PREFIX = 'jstu4:';
const KEYS = {
  program: `${PREFIX}program`,
  tape: `${PREFIX}tape`,
  settings: `${PREFIX}settings`,
  // Legacy per-field keys kept as read fallback so existing visitors keep
  // their saved preferences when upgrading.
  legacyLang: `${PREFIX}lang`,
  legacyTheme: `${PREFIX}theme`,
  legacySound: `${PREFIX}sound`,
} as const;

export type Theme = 'auto' | 'light' | 'dark';

export interface AppSettings {
  readonly lang: Lang | null;
  readonly theme: Theme;
  readonly sound: boolean;
  readonly speed: number;
  readonly minSpeed: number;
  readonly maxSpeed: number;
}

export interface SavedState {
  readonly program: string | null;
  readonly tape: string | null;
  readonly settings: AppSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  lang: null,
  theme: 'auto',
  sound: false,
  speed: DEFAULT_SPEED,
  minSpeed: DEFAULT_MIN_SPEED,
  maxSpeed: DEFAULT_MAX_SPEED,
};

function isTheme(value: unknown): value is Theme {
  return value === 'auto' || value === 'light' || value === 'dark';
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

export function loadSettings(): AppSettings {
  const raw = read(KEYS.settings);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const minSpeed =
          typeof record['minSpeed'] === 'number'
            ? clampMinSpeed(record['minSpeed'])
            : DEFAULT_SETTINGS.minSpeed;
        const maxSpeed =
          typeof record['maxSpeed'] === 'number'
            ? clampMaxSpeed(record['maxSpeed'])
            : DEFAULT_SETTINGS.maxSpeed;
        const speed =
          typeof record['speed'] === 'number'
            ? clampSpeed(record['speed'], minSpeed, maxSpeed)
            : clampSpeed(DEFAULT_SETTINGS.speed, minSpeed, maxSpeed);
        return {
          lang:
            typeof record['lang'] === 'string' && isLang(record['lang']) ? record['lang'] : null,
          theme: isTheme(record['theme']) ? record['theme'] : DEFAULT_SETTINGS.theme,
          sound: typeof record['sound'] === 'boolean' ? record['sound'] : DEFAULT_SETTINGS.sound,
          speed,
          minSpeed,
          maxSpeed,
        };
      }
    } catch {
      /* corrupted JSON — fall through to legacy keys / defaults */
    }
  }

  const legacyLang = read(KEYS.legacyLang);
  const legacyTheme = read(KEYS.legacyTheme);
  return {
    lang: isLang(legacyLang) ? legacyLang : DEFAULT_SETTINGS.lang,
    theme: isTheme(legacyTheme) ? legacyTheme : DEFAULT_SETTINGS.theme,
    sound: read(KEYS.legacySound) === '1',
    speed: DEFAULT_SETTINGS.speed,
    minSpeed: DEFAULT_SETTINGS.minSpeed,
    maxSpeed: DEFAULT_SETTINGS.maxSpeed,
  };
}

export function saveSettings(settings: AppSettings): void {
  write(KEYS.settings, JSON.stringify(settings));
}

export function loadState(): SavedState {
  return {
    program: read(KEYS.program),
    tape: read(KEYS.tape),
    settings: loadSettings(),
  };
}

export function saveProgram(text: string): void {
  write(KEYS.program, text === '' ? null : text);
}

export function saveTape(text: string): void {
  write(KEYS.tape, text === '' ? null : text);
}
