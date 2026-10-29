// Writes src/tui/openui-schema.json: the page's OpenUI library as a JSON schema, which the terminal client parses card
// bodies with. Run it after an upgrade of @openuidev/browser-bundle; test/browser/tui.spec.ts fails until you do.
// node scripts/openui-schema.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { serve } from '../src/node/server.ts';

export async function pageSchema(url: string, page: import('@playwright/test').Page): Promise<unknown> {
  await page.goto(url);
  return page.evaluate(async () => {
    const { library } = await import(new URL('components.js', document.baseURI).href) as { library: { toJSONSchema(): unknown } };
    return library.toJSONSchema();
  });
}

export const SCHEMA_FILE = path.join(import.meta.dirname, '..', 'src', 'tui', 'openui-schema.json');

if (import.meta.main) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-schema-'));
  const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report', blocked: 'a script sends nothing' } });
  const browser = await chromium.launch();
  try {
    const schema = await pageSchema(`${server.url}/`, await browser.newPage());
    fs.writeFileSync(SCHEMA_FILE, `${JSON.stringify(schema, null, 1)}\n`);
    console.log(`wrote ${SCHEMA_FILE}`);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}
