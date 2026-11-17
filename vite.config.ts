/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const rootDir = import.meta.dirname;

/**
 * Rewrite Vite's built `index.html` so it works identically both over HTTP(S)
 * and when opened directly from disk (`file:///.../dist/index.html`):
 *
 * - Classic IIFE `<script defer src="...">` instead of `<script type="module" crossorigin>`
 *   (HTML spec forces CORS for all module scripts, which fails on `file://` origin `null`).
 * - Removes `crossorigin` from `<link rel="stylesheet">` (same `file://` CORS restriction).
 * - Removes unused `<link rel="modulepreload">` hints.
 * - In production builds, strips HTML comments and collapses redundant whitespace.
 */
export function transformBuiltHtml(html: string, minify: boolean): string {
  let out = html
    // Remove modulepreload links emitted for ESM chunks.
    .replace(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>\s*/gi, '')
    // Convert module scripts into classic deferred scripts without `crossorigin`.
    .replace(/<script\b([^>]*)>/gi, (_match, rawAttrs: string) => {
      if (!/\btype=["']module["']/i.test(rawAttrs)) return `<script${rawAttrs}>`;
      const cleaned = rawAttrs
        .replace(/\s*\btype=["']module["']/gi, '')
        .replace(/\s*\bcrossorigin(?:=["'][^"']*["'])?/gi, '')
        .trim();
      const hasDefer = /\bdefer\b/i.test(cleaned);
      const attrs = hasDefer ? cleaned : cleaned ? `defer ${cleaned}` : 'defer';
      return `<script ${attrs}>`;
    })
    // Strip `crossorigin` from stylesheet links so `file://` does not block CSS via CORS.
    .replace(/<link\b([^>]*)>/gi, (_match, rawAttrs: string) => {
      if (!/\bcrossorigin\b/i.test(rawAttrs)) return `<link${rawAttrs}>`;
      const cleaned = rawAttrs.replace(/\s*\bcrossorigin(?:=["'][^"']*["'])?/gi, '');
      return `<link${cleaned}>`;
    });

  if (minify) {
    // Protect non-empty bodies of whitespace-sensitive elements while still
    // compacting their opening tags' attributes.
    const preserved: string[] = [];
    out = out.replace(
      /(<(pre|textarea|script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi,
      (_match, open: string, _tag: string, body: string, close: string) => {
        if (body.length === 0) return `${open}${close}`;
        const idx = preserved.push(body) - 1;
        return `${open}__JSTU4_PRESERVE_${idx}__${close}`;
      },
    );

    out = out
      .replace(/<!--[\s\S]*?-->/g, '')
      // Collapse multi-line attributes, redundant spaces, and space before `/>`.
      .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)>/g, (_m, tag: string, attrs: string) => {
        const compactAttrs = attrs
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .replace(/\s+(\/)$/, '$1')
          .replace(/\s+$/, '');
        return `<${tag}${compactAttrs}>`;
      })
      // Remove redundant self-closing slash on HTML5 void elements (keeps SVG `<path .../>` intact).
      .replace(
        /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b([^>]*?)\s*\/>/gi,
        '<$1$2>',
      )
      .replace(/>\s*\n\s*</g, '><')
      // Trim newline indentation around inline text nodes (e.g. button glyphs `×`, `−`, `+`, `?`).
      .replace(/>\s*\n\s*([^<>\n]+?)\s*\n\s*</g, '>$1<')
      .trim();

    out = out.replace(
      /__JSTU4_PRESERVE_(\d+)__/g,
      (_m, idx: string) => preserved[Number(idx)] ?? '',
    );
  }

  return out;
}

function classicFileProtocolPlugin(isProd: boolean): Plugin {
  return {
    name: 'jstu4-classic-file-protocol',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return transformBuiltHtml(html, isProd);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const isProd = mode !== 'development';

  return {
    // `public/index.html` is the sole HTML entry point; disable Vite's static
    // `publicDir` copy so `public/index.html` is processed through the bundler.
    root: resolve(rootDir, 'public'),
    publicDir: false,
    // Relative base so the build works from any sub-path (e.g. GitHub Pages
    // project pages, direct `file://` opens, static hosting without rewrites).
    base: './',
    plugins: [classicFileProtocolPlugin(isProd)],
    resolve: {
      alias: {
        '/src': resolve(rootDir, 'src'),
      },
    },
    esbuild: isProd
      ? {
          legalComments: 'none',
        }
      : {
          legalComments: 'inline',
        },
    build: {
      outDir: resolve(rootDir, 'dist'),
      emptyOutDir: true,
      target: 'es2022',
      modulePreload: false,
      cssCodeSplit: false,
      sourcemap: !isProd,
      minify: isProd ? 'terser' : false,
      ...(isProd
        ? {
            terserOptions: {
              ecma: 2020,
              safari10: false,
              compress: {
                passes: 3,
                drop_console: true,
                drop_debugger: true,
                pure_getters: true,
              },
              format: {
                comments: false,
              },
            },
          }
        : {}),
      cssMinify: isProd ? 'esbuild' : false,
      assetsInlineLimit: isProd ? 4096 : 0,
      reportCompressedSize: isProd,
      rollupOptions: {
        treeshake: isProd ? { preset: 'recommended', propertyReadSideEffects: false } : true,
        output: {
          // IIFE bundle runs cleanly as `<script defer>` on `file://` and HTTP(S).
          format: 'iife',
          inlineDynamicImports: true,
          entryFileNames: isProd ? 'assets/[name]-[hash].js' : 'assets/[name].js',
          assetFileNames: isProd ? 'assets/[name]-[hash][extname]' : 'assets/[name][extname]',
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      // Hosted IDEs and preview proxies serve the app under their own domain;
      // allow those origins instead of hard-coding a whitelist.
      allowedHosts: true,
      fs: {
        allow: [rootDir],
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      allowedHosts: true,
    },
    test: {
      root: rootDir,
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
