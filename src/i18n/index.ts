import enJson from './locales/en.json';
import ruJson from './locales/ru.json';
import { formatMessage, formatNumber, type FormatParams } from './format';
import {
  DEFAULT_LANG,
  LANGS,
  LOCALES,
  type HelpContent,
  type Lang,
  type LocaleMeta,
  type MessageCatalog,
  type MessageKey,
  type MessageParamsMap,
  type ParameterizedMessageKey,
  type PlainMessageKey,
} from './types';

export { bindDomI18n, applyDomI18n } from './dom';
export { formatMessage, formatSymbol, type FormatParams } from './format';
export {
  DEFAULT_LANG,
  LANGS,
  LOCALES,
  type HelpBlock,
  type HelpContent,
  type HelpInline,
  type HelpSection,
  type Lang,
  type LocaleMeta,
  type MessageCatalog,
  type MessageKey,
  type MessageParamsMap,
  type ParameterizedMessageKey,
  type PlainMessageKey,
} from './types';

const defaultCatalogs: Readonly<Record<Lang, MessageCatalog>> = {
  ru: ruJson as MessageCatalog,
  en: enJson as MessageCatalog,
};

export function isLang(value: string | null | undefined): value is Lang {
  return (
    value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(LOCALES, value)
  );
}

/** Extract canonical primary language subtag via `Intl.Locale` (BCP-47). */
function primaryLanguage(tag: string): string | null {
  try {
    return new Intl.Locale(tag).language.toLowerCase();
  } catch {
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    return base || null;
  }
}

/**
 * Negotiate the UI language using BCP-47 tags (`Intl.Locale`).
 *
 * Precedence: `?lang=` query parameter → saved user choice → first supported
 * language in `navigator.languages` → default (`ru`).
 */
export function detectLang(
  search: string,
  stored: string | null,
  preferred: readonly string[],
): Lang {
  const fromQuery = new URLSearchParams(search).get('lang');
  const queryBase = fromQuery ? primaryLanguage(fromQuery) : null;
  if (isLang(queryBase)) return queryBase;
  if (isLang(stored)) return stored;
  for (const tag of preferred) {
    const base = primaryLanguage(tag);
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}

/** Walk a dot-separated key inside a catalog object. */
function lookupRaw(catalog: MessageCatalog, key: string): string | undefined {
  let cursor: unknown = catalog;
  for (const segment of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

export type LocaleListener = (locale: Lang) => void;

/**
 * Reactive, zero-dependency i18n service backed by pure JSON catalogs and
 * native Web Platform `Intl` APIs (`Intl.Locale`, `Intl.NumberFormat`,
 * `Intl.PluralRules`).
 */
export interface I18n {
  readonly locale: Lang;
  readonly meta: LocaleMeta;
  readonly help: HelpContent;
  /** Switch active locale and notify all subscribers. */
  setLocale(next: Lang): void;
  /** Cycle to the next registered locale (RU ↔ EN) and return it. */
  toggleLocale(): Lang;
  /** Subscribe to locale changes; returns an unsubscribe callback. */
  subscribe(listener: LocaleListener): () => void;
  /** Type-safe translation lookup with automatic fallback to `DEFAULT_LANG`. */
  t<K extends PlainMessageKey>(key: K): string;
  t<K extends ParameterizedMessageKey>(key: K, params: MessageParamsMap[K]): string;
  /** Locale-aware number formatting via cached `Intl.NumberFormat`. */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
}

export function createI18n(initialLocale: Lang = DEFAULT_LANG): I18n {
  let current: Lang = initialLocale;
  const listeners = new Set<LocaleListener>();

  const emit = (): void => {
    for (const listener of listeners) listener(current);
  };

  const setLocale = (next: Lang): void => {
    if (next === current) return;
    current = next;
    emit();
  };

  const toggleLocale = (): Lang => {
    const index = LANGS.indexOf(current);
    const next = LANGS[(index + 1) % LANGS.length] ?? DEFAULT_LANG;
    setLocale(next);
    return next;
  };

  const subscribe = (listener: LocaleListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  function t<K extends PlainMessageKey>(key: K): string;
  function t<K extends ParameterizedMessageKey>(key: K, params: MessageParamsMap[K]): string;
  function t(key: MessageKey, params?: FormatParams): string {
    const template =
      lookupRaw(defaultCatalogs[current], key) ??
      lookupRaw(defaultCatalogs[DEFAULT_LANG], key) ??
      key;
    return formatMessage(template, LOCALES[current].bcp47, params);
  }

  return {
    get locale(): Lang {
      return current;
    },
    get meta(): LocaleMeta {
      return LOCALES[current];
    },
    get help(): HelpContent {
      return defaultCatalogs[current].help;
    },
    setLocale,
    toggleLocale,
    subscribe,
    t,
    formatNumber: (value, options) => formatNumber(value, LOCALES[current].bcp47, options),
  };
}
