// Writes src/adapters/openui-library.ts: the components a card body can use, read from the page itself in a browser,
// so the inbox checks bodies against exactly the list the page draws with. test/browser/body-check.spec.ts fails when they differ.
// Run it after a change to web/library-spec.js or to @openuidev/browser-bundle: node --disable-warning=ExperimentalWarning scripts/openui-library.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { serve } from '../src/node/server.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-library-'));
const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', blocked: 'the generator sends nothing' } });
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${server.url}/#token=${server.ownerToken}`);
  const schema = await page.evaluate(async () => (await import(String('/components.js'))).librarySchema());
  await browser.close();
  const out = path.join(import.meta.dirname, '..', 'src', 'adapters', 'openui-library.ts');
  fs.writeFileSync(out, [
    '// Written by scripts/openui-library.ts from the page library. Do not edit it by hand.',
    '// The components a card body can use, as the OpenUI parser reads them.',
    `export const LIBRARY = ${JSON.stringify(schema)};`,
    '',
  ].join('\n'));
  console.log(`wrote ${out}`);
} finally {
  await server.close();
  fs.rmSync(home, { recursive: true, force: true });
}
