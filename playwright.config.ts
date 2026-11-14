import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests: the app is a single page with no backend, so
 * `vite preview` of a production build is enough — no dev server needed.
 */
export default defineConfig({
  testDir: 'e2e',
  // Visual snapshots are opt-in: `npm run shots`.
  ...(process.env.SHOTS ? {} : { testIgnore: ['**/visual.spec.ts'] }),
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The CI browser defaults to en-US; pin the locale so language
        // detection (browser → ?lang= → stored choice) is deterministic.
        locale: 'ru-RU',
      },
    },
  ],
});
