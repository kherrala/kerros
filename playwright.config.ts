import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5181',
    viewport: { width: 1600, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5181 --strictPort',
    // Health-check app.html, not / — the reference editor moved off the root (which is now the docs home).
    url: 'http://127.0.0.1:5181/app.html',
    reuseExistingServer: !process.env.CI,
    env: { VITE_MML_API_KEY: 'playwright-test-key' },
  },
});
