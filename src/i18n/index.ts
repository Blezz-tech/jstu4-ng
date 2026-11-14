import enJson from './locales/en.json';
import ruJson from './locales/ru.json';
import { formatMessage, type FormatParams } from './format';
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
export class I18n {
  private current: Lang;
  private readonly catalogs: Record<Lang, MessageCatalog>;
  private readonly listeners = new Set<LocaleListener>();

  constructor(initialLocale: Lang = DEFAULT_LANG) {
    this.current = initialLocale;
    this.catalogs = { ...defaultCatalogs };
  }

  get locale(): Lang {
    return this.current;
  }

  get meta(): LocaleMeta {
    return LOCALES[this.current];
  }

  get help(): HelpContent {
    return this.catalogs[this.current].help;
  }

  /** Register or override a locale catalog (supports future lazy-loaded locales). */
  registerCatalog(locale: Lang, catalog: MessageCatalog): void {
    this.catalogs[locale] = catalog;
    if (locale === this.current) this.emit();
  }

  /** Switch active locale and notify all subscribers. */
  setLocale(next: Lang): void {
    if (next === this.current) return;
    this.current = next;
    this.emit();
  }

  /** Cycle to the next registered locale (RU ↔ EN) and return it. */
  toggleLocale(): Lang {
    const index = LANGS.indexOf(this.current);
    const next = LANGS[(index + 1) % LANGS.length] ?? DEFAULT_LANG;
    this.setLocale(next);
    return next;
  }

  /** Subscribe to locale changes; returns an unsubscribe callback. */
  subscribe(listener: LocaleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Type-safe translation lookup with automatic fallback to `DEFAULT_LANG`. */
  t<K extends PlainMessageKey>(key: K): string;
  t<K extends ParameterizedMessageKey>(key: K, params: MessageParamsMap[K]): string;
  t(key: MessageKey, params?: FormatParams): string {
    const template =
      lookupRaw(this.catalogs[this.current], key) ??
      lookupRaw(this.catalogs[DEFAULT_LANG], key) ??
      key;
    return formatMessage(template, this.meta.bcp47, params);
  }

  /** Locale-aware number formatting via `Intl.NumberFormat`. */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.meta.bcp47, options).format(value);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

export function createI18n(initialLocale: Lang = DEFAULT_LANG): I18n {
  return new I18n(initialLocale);
}
