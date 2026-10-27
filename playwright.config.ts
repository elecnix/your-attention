import { defineConfig, devices } from '@playwright/test';

// Each spec file starts its own inbox, so the files run in parallel without sharing state.
export default defineConfig({
  testDir: 'test/browser',
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
