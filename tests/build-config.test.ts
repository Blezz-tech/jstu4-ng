import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEMVER_RE } from '../scripts/check-conventional-commits.js';
import { TM_VERSION } from '../src/core/version';
import { transformBuiltHtml } from '../vite.config';

describe('transformBuiltHtml (file:// compatibility & production HTML minification)', () => {
  const sampleHtml = `<!doctype html>
<html lang="ru">
  <head>
    <!-- comment -->
    <script type="module" crossorigin src="./assets/index-abc123.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/chunk.js">
    <link rel="stylesheet" crossorigin href="./assets/index-abc123.css">
  </head>
  <body>
    <button
      id="btn-start"
      type="button"
      data-i18n="controls.start"
    ></button>
  </body>
</html>`;

  it('removes CORS-triggering type="module", crossorigin, and modulepreload for file:// compatibility', () => {
    const devHtml = transformBuiltHtml(sampleHtml, false);

    expect(devHtml).toContain('<script defer src="./assets/index-abc123.js"></script>');
    expect(devHtml).toContain('<link rel="stylesheet" href="./assets/index-abc123.css">');
    expect(devHtml).not.toContain('type="module"');
    expect(devHtml).not.toContain('crossorigin');
    expect(devHtml).not.toContain('modulepreload');
    // Dev build keeps readable formatting and comments.
    expect(devHtml).toContain('<!-- comment -->');
  });

  it('additionally strips comments and collapses redundant whitespace in production builds', () => {
    const prodHtml = transformBuiltHtml(sampleHtml, true);

    expect(prodHtml).toContain('<script defer src="./assets/index-abc123.js"></script>');
    expect(prodHtml).toContain('<link rel="stylesheet" href="./assets/index-abc123.css">');
    expect(prodHtml).toContain('<button id="btn-start" type="button" data-i18n="controls.start">');
    expect(prodHtml).not.toContain('<!-- comment -->');
    expect(prodHtml).not.toContain('type="module"');
    expect(prodHtml).not.toContain('crossorigin');
    expect(prodHtml.length).toBeLessThan(sampleHtml.length);
  });

  it('trims button glyph newlines and HTML5 void slashes while preserving SVG and preformatted bodies', () => {
    const richHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <button id="btn-close" type="button">
      ×
    </button>
    <svg viewBox="0 0 24 24">
      <path d="M0 0h24" />
    </svg>
    <pre
      id="code"
    >  line 1
  line 2</pre>
  </body>
</html>`;

    const prodHtml = transformBuiltHtml(richHtml, true);

    expect(prodHtml).toContain('<meta charset="utf-8">');
    expect(prodHtml).toContain('<button id="btn-close" type="button">×</button>');
    expect(prodHtml).toContain('<path d="M0 0h24"/>');
    expect(prodHtml).toContain('<pre id="code">  line 1\n  line 2</pre>');
  });
});

describe('SemVer & package metadata', () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
    name: string;
    version: string;
    author: string;
    repository: { url: string };
  };

  it('keeps package.json version valid SemVer 2.0.0 and synchronized with TM_VERSION', () => {
    expect(pkg.version).toMatch(SEMVER_RE);
    expect(TM_VERSION).toBe(pkg.version);
  });

  it('publishes jstu4-ng repository and Blezz-tech author metadata', () => {
    expect(pkg.name).toBe('jstu4-ng');
    expect(pkg.author).toBe('Blezz-tech');
    expect(pkg.repository.url).toBe('https://github.com/Blezz-tech/jstu4-ng.git');
  });
});
