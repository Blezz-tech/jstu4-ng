import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createI18n, detectLang, formatMessage, formatSymbol, LANGS } from '../src/i18n';
import enJson from '../src/i18n/locales/en.json';
import ruJson from '../src/i18n/locales/ru.json';

function collectStringLeaves(
  obj: Record<string, unknown>,
  prefix = '',
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    if (prefix === '' && key === 'help') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result.set(path, value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [nestedKey, nestedVal] of collectStringLeaves(
        value as Record<string, unknown>,
        path,
      )) {
        result.set(nestedKey, nestedVal);
      }
    }
  }
  return result;
}

function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  const pattern = /\{([a-zA-Z0-9_]+)(?:\s*,[^}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return names.sort();
}

describe('i18n catalogs & declarative HTML bindings', () => {
  const ruLeaves = collectStringLeaves(ruJson);
  const enLeaves = collectStringLeaves(enJson);

  it('keeps identical key trees across ru.json and en.json', () => {
    expect([...enLeaves.keys()].sort()).toEqual([...ruLeaves.keys()].sort());
  });

  it('keeps identical interpolation placeholder names across all locales', () => {
    for (const [key, ruValue] of ruLeaves) {
      const enValue = enLeaves.get(key);
      expect(enValue, `missing key in en.json: ${key}`).toBeDefined();
      expect(extractPlaceholders(enValue!), `placeholder mismatch for key "${key}"`).toEqual(
        extractPlaceholders(ruValue),
      );
    }
  });

  it('verifies every data-i18n and data-i18n-attr key in public/index.html exists in all catalogs', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../public/index.html'), 'utf8');
    const referencedKeys: string[] = [];

    for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
      if (match[1]) referencedKeys.push(match[1]);
    }
    for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      const spec = match[1] ?? '';
      for (const pair of spec.split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        expect(colon, `malformed data-i18n-attr entry "${trimmed}"`).toBeGreaterThan(0);
        referencedKeys.push(trimmed.slice(colon + 1).trim());
      }
    }

    expect(referencedKeys.length).toBeGreaterThan(20);
    for (const key of referencedKeys) {
      expect(ruLeaves.has(key), `missing HTML key "${key}" in ru.json`).toBe(true);
      expect(enLeaves.has(key), `missing HTML key "${key}" in en.json`).toBe(true);
    }
  });
});

describe('detectLang (BCP-47 via Intl.Locale)', () => {
  it('resolves query parameter over stored preference and navigator languages', () => {
    expect(detectLang('?lang=en-GB', 'ru', ['ru-RU'])).toBe('en');
    expect(detectLang('?lang=ru-Cyrl-RU', 'en', ['en-US'])).toBe('ru');
    expect(detectLang('', 'en', ['ru-RU'])).toBe('en');
    expect(detectLang('', null, ['de-DE', 'en-AU'])).toBe('en');
    expect(detectLang('', null, ['fr-FR', 'ja'])).toBe('ru');
  });

  it('gracefully handles malformed BCP-47 tags', () => {
    expect(detectLang('?lang=???', null, ['!!!', 'en_US'])).toBe('en');
  });
});

describe('formatMessage (ICU subset + native Intl)', () => {
  it('formats plain, symbol, and Intl.NumberFormat placeholders', () => {
    expect(formatSymbol(' ')).toBe('␣');
    expect(formatSymbol('\t')).toBe('\\t');
    expect(formatSymbol('a')).toBe('a');

    expect(formatMessage('State {q}, sym {a, symbol}', 'en-US', { q: '0', a: ' ' })).toBe(
      'State 0, sym ␣',
    );
    expect(formatMessage('Steps: {n, number}', 'en-US', { n: 1250 })).toBe('Steps: 1,250');
    expect(formatMessage('Шагов: {n, number}', 'ru-RU', { n: 1250 })).toBe(
      `Шагов: ${new Intl.NumberFormat('ru-RU').format(1250)}`,
    );
  });

  it('selects CLDR plural rules via Intl.PluralRules for Russian and English', () => {
    const ruTpl =
      '{n, plural, =0 {нет шагов} one {# шаг} few {# шага} many {# шагов} other {# шагов}}';
    expect(formatMessage(ruTpl, 'ru-RU', { n: 0 })).toBe('нет шагов');
    expect(formatMessage(ruTpl, 'ru-RU', { n: 1 })).toBe('1 шаг');
    expect(formatMessage(ruTpl, 'ru-RU', { n: 2 })).toBe('2 шага');
    expect(formatMessage(ruTpl, 'ru-RU', { n: 5 })).toBe('5 шагов');
    expect(formatMessage(ruTpl, 'ru-RU', { n: 11 })).toBe('11 шагов');
    expect(formatMessage(ruTpl, 'ru-RU', { n: 21 })).toBe('21 шаг');
    expect(formatMessage(ruTpl, 'ru-RU', { n: 22 })).toBe('22 шага');

    const enTpl = '{n, plural, =0 {no steps} one {# step} other {# steps}}';
    expect(formatMessage(enTpl, 'en-US', { n: 0 })).toBe('no steps');
    expect(formatMessage(enTpl, 'en-US', { n: 1 })).toBe('1 step');
    expect(formatMessage(enTpl, 'en-US', { n: 1000 })).toBe('1,000 steps');
  });
});

describe('I18n reactive service', () => {
  it('notifies subscribers on locale changes and supports unsubscribe', () => {
    const i18n = createI18n('ru');
    const seen: string[] = [];
    const unsubscribe = i18n.subscribe((locale) => seen.push(locale));

    expect(i18n.locale).toBe('ru');
    expect(i18n.meta.bcp47).toBe('ru-RU');
    expect(i18n.meta.dir).toBe('ltr');
    expect(LANGS).toEqual(['ru', 'en']);

    expect(i18n.toggleLocale()).toBe('en');
    expect(i18n.t('controls.start')).toBe('Start');
    expect(i18n.t('error.ambiguousCommand', { q: '0', a: ' ' })).toContain('␣');

    // No-op when setting the same locale.
    i18n.setLocale('en');
    expect(seen).toEqual(['en']);

    unsubscribe();
    i18n.setLocale('ru');
    expect(seen).toEqual(['en']);
    expect(i18n.t('controls.start')).toBe('Старт');
  });

  it('formats numbers using the active locale', () => {
    const i18n = createI18n('en');
    expect(i18n.formatNumber(12345)).toBe('12,345');
    const spy = vi.fn();
    i18n.subscribe(spy);
    i18n.setLocale('ru');
    expect(spy).toHaveBeenCalledWith('ru');
    expect(i18n.formatNumber(12345)).toBe(new Intl.NumberFormat('ru-RU').format(12345));
  });
});
