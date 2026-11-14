/**
 * Zero-dependency ICU-subset message formatter built on native `Intl` APIs.
 *
 * Supported expressions inside message templates:
 * - `{name}` — plain interpolation
 * - `{count, number}` — locale-aware formatting via `Intl.NumberFormat`
 * - `{sym, symbol}` — human-readable tape symbol (`' '` → `␣`, `'\t'` → `\t`)
 * - `{count, plural, =0 {none} one {# item} few {# items} many {# items} other {# items}}`
 *   — CLDR plural selection via `Intl.PluralRules` (`#` renders the formatted number)
 */

const numberFormatCache = new Map<string, Intl.NumberFormat>();
const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getNumberFormat(bcp47: string): Intl.NumberFormat {
  let formatter = numberFormatCache.get(bcp47);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(bcp47);
    numberFormatCache.set(bcp47, formatter);
  }
  return formatter;
}

function getPluralRules(bcp47: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(bcp47);
  if (rules === undefined) {
    rules = new Intl.PluralRules(bcp47);
    pluralRulesCache.set(bcp47, rules);
  }
  return rules;
}

/**
 * Render a tape symbol for humans. The space is a real symbol in TM
 * programs but is invisible in a message, so it is shown as the
 * "open box" glyph (U+2423).
 */
export function formatSymbol(symbol: string): string {
  if (symbol === ' ') return '\u2423';
  if (symbol === '\t') return '\\t';
  return symbol;
}

export type FormatParams = Readonly<Record<string, string | number>>;

/** Find the index of the `}` matching the `{` at `openIndex`, or `-1`. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an ICU expression into up to 3 top-level comma-separated parts. */
function splitExpression(expr: string): [string, string | undefined, string | undefined] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0 && parts.length < 2) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return [parts[0] ?? '', parts[1], parts[2]];
}

/** Parse plural branch blocks such as `=0 {none} one {# step} other {# steps}`. */
function parsePluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let cursor = 0;

  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor] ?? '')) cursor += 1;
    if (cursor >= body.length) break;

    const keyStart = cursor;
    while (cursor < body.length && !/[\s{]/.test(body[cursor] ?? '')) cursor += 1;
    const selector = body.slice(keyStart, cursor);

    while (cursor < body.length && /\s/.test(body[cursor] ?? '')) cursor += 1;
    if (body[cursor] !== '{') break;

    const closeIndex = findMatchingBrace(body, cursor);
    if (closeIndex < 0) break;

    branches.set(selector, body.slice(cursor + 1, closeIndex));
    cursor = closeIndex + 1;
  }

  return branches;
}

/** Format a localized message template with optional parameters and ICU plural/number rules. */
export function formatMessage(
  template: string,
  bcp47: string,
  params?: FormatParams,
  pluralHashReplacement?: string,
): string {
  let out = '';
  let i = 0;

  while (i < template.length) {
    const ch = template[i]!;

    if (ch === '#' && pluralHashReplacement !== undefined) {
      out += pluralHashReplacement;
      i += 1;
      continue;
    }

    if (ch !== '{') {
      out += ch;
      i += 1;
      continue;
    }

    const closeIndex = findMatchingBrace(template, i);
    if (closeIndex < 0) {
      out += template.slice(i);
      break;
    }

    const expr = template.slice(i + 1, closeIndex);
    const [key, kind, rest] = splitExpression(expr);
    const rawValue = params?.[key];

    if (rawValue === undefined) {
      out += template.slice(i, closeIndex + 1);
    } else if (kind === undefined || kind === '') {
      out += String(rawValue);
    } else if (kind === 'number') {
      out += getNumberFormat(bcp47).format(Number(rawValue));
    } else if (kind === 'symbol') {
      out += formatSymbol(String(rawValue));
    } else if (kind === 'plural' && rest !== undefined) {
      const numeric = Number(rawValue);
      const branches = parsePluralBranches(rest);
      const exact = branches.get(`=${numeric}`);
      const category = getPluralRules(bcp47).select(numeric);
      const chosen = exact ?? branches.get(category) ?? branches.get('other') ?? '';
      const formattedNum = getNumberFormat(bcp47).format(numeric);
      out += formatMessage(chosen, bcp47, params, formattedNum);
    } else {
      out += String(rawValue);
    }

    i = closeIndex + 1;
  }

  return out;
}
