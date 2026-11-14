import type ruCatalog from './locales/ru.json';

/** Supported locale metadata registry (BCP-47 tag, writing direction, native name). */
export const LOCALES = {
  ru: { bcp47: 'ru-RU', dir: 'ltr', nativeName: 'Русский' },
  en: { bcp47: 'en-US', dir: 'ltr', nativeName: 'English' },
} as const;

export type Lang = keyof typeof LOCALES;
export const LANGS = Object.keys(LOCALES) as readonly Lang[];
export const DEFAULT_LANG: Lang = 'ru';

export interface LocaleMeta {
  readonly bcp47: string;
  readonly dir: 'ltr' | 'rtl';
  readonly nativeName: string;
}

export interface HelpSection {
  readonly title: string;
  readonly blocks: readonly HelpBlock[];
}

export type HelpInline = string | { readonly label: string; readonly href: string };

export type HelpBlock =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'rich'; readonly parts: readonly HelpInline[] }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'code'; readonly lines: readonly string[] };

export interface HelpContent {
  readonly title: string;
  readonly back: string;
  readonly sections: readonly HelpSection[];
}

/** Shape of a declarative JSON message catalog (`src/i18n/locales/*.json`). */
export type MessageCatalog = Omit<typeof ruCatalog, 'help'> & {
  readonly help: HelpContent;
};

type StringLeafKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends readonly unknown[]
      ? never
      : T[K] extends Record<string, unknown>
        ? StringLeafKeys<T[K], `${Prefix}${K}.`>
        : never;
}[keyof T & string];

/** Every valid dot-separated translation key in the JSON message catalogs. */
export type MessageKey = StringLeafKeys<Omit<MessageCatalog, 'help'>>;

/** Compile-time required parameter map for every parameterized message key. */
export interface MessageParamsMap {
  readonly 'error.parseError': { readonly text: string };
  readonly 'error.ambiguousCommand': { readonly q: string; readonly a: string };
  readonly 'error.targetStateDoesNotExist': { readonly w: string };
  readonly 'error.initialStateDoesNotExist': { readonly q: string };
  readonly 'error.noSuchCommand': { readonly q: string; readonly a: string };
  readonly 'stats.summary': {
    readonly commandsCount: number;
    readonly initialDataLength: number;
    readonly maxDataLength: number;
    readonly operationsCount: number;
  };
  readonly 'settings.languageAria': { readonly language: string };
}

export type ParameterizedMessageKey = keyof MessageParamsMap;
export type PlainMessageKey = Exclude<MessageKey, ParameterizedMessageKey>;
