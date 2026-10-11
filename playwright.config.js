// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: 'list',
  use: {
    headless: false,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      // iPhone emulation (viewport, touch, iOS Safari user agent) on Playwright's WebKit.
      name: 'iphone-15',
      use: { ...devices['iPhone 15'] },
    },
  ],
});
