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
  readonly sidepanelOpen?: boolean;
  readonly historyOpen?: boolean;
  readonly namedOnly?: boolean;
  readonly confirmSnapshotDelete?: boolean;
}

export interface LegacyRawSettings {
  readonly lang: string | null;
  readonly theme: string | null;
  readonly sound: string | null;
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

const OPTIONAL_BOOL_KEYS = [
  'sidepanelOpen',
  'historyOpen',
  'namedOnly',
  'confirmSnapshotDelete',
] as const;

function isTheme(value: unknown): value is Theme {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/**
 * Validate and sanitize a parsed JSON value into normalized {@link AppSettings}.
 * Returns `null` when the input is not a plain object (e.g. `null`, array, primitive).
 */
export function parseSettings(raw: unknown): AppSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const minSpeed =
    typeof rec['minSpeed'] === 'number'
      ? clampMinSpeed(rec['minSpeed'])
      : DEFAULT_SETTINGS.minSpeed;
  const maxSpeed =
    typeof rec['maxSpeed'] === 'number'
      ? clampMaxSpeed(rec['maxSpeed'])
      : DEFAULT_SETTINGS.maxSpeed;
  const speed = clampSpeed(
    typeof rec['speed'] === 'number' ? rec['speed'] : DEFAULT_SETTINGS.speed,
    minSpeed,
    maxSpeed,
  );
  const result: Record<string, unknown> = {
    lang: typeof rec['lang'] === 'string' && isLang(rec['lang']) ? rec['lang'] : null,
    theme: isTheme(rec['theme']) ? rec['theme'] : DEFAULT_SETTINGS.theme,
    sound: typeof rec['sound'] === 'boolean' ? rec['sound'] : DEFAULT_SETTINGS.sound,
    speed,
    minSpeed,
    maxSpeed,
  };
  for (const key of OPTIONAL_BOOL_KEYS) {
    if (typeof rec[key] === 'boolean') result[key] = rec[key];
  }
  return result as unknown as AppSettings;
}

/** Normalize legacy per-key localStorage preference strings into {@link AppSettings}. */
export function parseLegacySettings(raw: LegacyRawSettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    lang: isLang(raw.lang) ? raw.lang : DEFAULT_SETTINGS.lang,
    theme: isTheme(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme,
    sound: raw.sound === '1',
  };
}

/**
 * `localStorage` wrapper that never throws: private mode, disabled storage and
 * quota errors all degrade to an in-memory no-op.
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
      const parsed = parseSettings(JSON.parse(raw));
      if (parsed !== null) return parsed;
    } catch {
      /* corrupted JSON — fall through to legacy keys / defaults */
    }
  }

  return parseLegacySettings({
    lang: read(KEYS.legacyLang),
    theme: read(KEYS.legacyTheme),
    sound: read(KEYS.legacySound),
  });
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
