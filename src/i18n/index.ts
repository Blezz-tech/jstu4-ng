import { en } from './en';
import { ru } from './ru';
import { DEFAULT_LANG, LANGS, type Lang, type Messages } from './types';

export { LANGS, DEFAULT_LANG, type Lang, type Messages } from './types';

const dictionaries: Readonly<Record<Lang, Messages>> = { ru, en };

export function isLang(value: string | null | undefined): value is Lang {
  return value !== null && value !== undefined && (LANGS as readonly string[]).includes(value);
}

export function messages(lang: Lang): Messages {
  return dictionaries[lang];
}

/**
 * Pick the UI language.
 *
 * Order: `?lang=` → explicit user choice → `navigator.languages`, but a browser
 * without Russian simply keeps the default language (Russian) instead of
 * forcing English on a RU-first audience: the original emulator was RU-first
 * as well, and `?lang=en` is a documented deep link.
 */
export function detectLang(
  search: string,
  stored: string | null,
  preferred: readonly string[],
): Lang {
  const fromQuery = new URLSearchParams(search).get('lang');
  if (isLang(fromQuery)) return fromQuery;
  if (isLang(stored)) return stored;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}
