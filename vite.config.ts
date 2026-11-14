/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages
  // project pages, file:// previews, static hosting without rewrites).
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Hosted IDEs and preview proxies serve the app under their own domain;
    // allow those origins instead of hard-coding a whitelist.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
