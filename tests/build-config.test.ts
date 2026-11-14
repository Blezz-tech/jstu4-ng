import { describe, expect, it } from 'vitest';
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
});
