// @ts-check
// Sample spec: opens tractorjunction.com in a headed browser and holds it open
// (page.pause() opens the Playwright Inspector) until you press Resume or close it.
import { test } from '@playwright/test';

test('launch tractorjunction.com and hold', async ({ page }) => {
  test.setTimeout(0); // no timeout while the browser is held open

  await page.goto('https://www.tractorjunction.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.pause();
});
