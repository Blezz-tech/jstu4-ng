/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const rootDir = import.meta.dirname;

export default defineConfig({
  // `public/index.html` is the sole HTML entry point; disable Vite's static
  // `publicDir` copy so `public/index.html` is processed through the bundler.
  root: resolve(rootDir, 'public'),
  publicDir: false,
  // Relative base so the build works from any sub-path (e.g. GitHub Pages
  // project pages, file:// previews, static hosting without rewrites).
  base: './',
  resolve: {
    alias: {
      '/src': resolve(rootDir, 'src'),
    },
  },
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
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
});
