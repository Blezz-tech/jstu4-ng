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
    out = out
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/>\s*\n\s*</g, '><')
      .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)>/g, (_m, tag: string, attrs: string) => {
        const compactAttrs = attrs.replace(/\s*\n\s*/g, ' ').replace(/\s+(\/?>?)$/, '$1');
        return `<${tag}${compactAttrs}>`;
      })
      .trim();
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
          drop: ['console', 'debugger'],
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
      minify: isProd ? 'esbuild' : false,
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
