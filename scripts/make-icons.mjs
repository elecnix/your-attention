// Draws the PNG icons of the page from web/icon.svg: the Home Screen icon of an iPhone, and the two sizes the web app manifest names.
// It uses the browser Playwright already installs. Run `node scripts/make-icons.mjs` after a change to web/icon.svg.
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const svg = fs.readFileSync('web/icon.svg', 'utf8');
const sizes = { 'web/apple-touch-icon.png': 180, 'web/icon-192.png': 192, 'web/icon-512.png': 512 };
const browser = await chromium.launch();
for (const [file, size] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  fs.writeFileSync(file, await page.screenshot({ type: 'png' }));
  await page.close();
}
await browser.close();
