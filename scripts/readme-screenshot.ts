// Draws docs/screenshot.png, the README's picture of the inbox, from made-up cards on a fresh inbox.
// Run it after a change to the page: node --disable-warning=ExperimentalWarning scripts/readme-screenshot.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from '@playwright/test';
import { Client } from '../src/client.ts';
import { serve } from '../src/node/server.ts';

/** A one-color PNG, as a data: URL. */
function swatch(rgb: [number, number, number], w = 172, h = 138): string {
  const crc = (b: Buffer): number => {
    let c = ~0;
    for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-screenshot-'));
const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report' } });
// The screenshot shows the page after the person has read the usage notice.
server.inbox.usage.update({ notified: true });
// The screenshot shows an inbox whose person already answered the PIN offer.
server.inbox.pin.setNeverAsk(true);
const agent = new Client({ url: server.url, token: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim() });
const stop = new AbortController();
try {
  const measurements = '# Measurements\n\n| Layout | Titles shown | Time to answer |\n| --- | --- | --- |\n| A | 14 | 9.1 s |\n| B | 11 | 7.4 s |\n';
  await agent.post({
    id: 'queue-layout', agent: 'queue-layout', title: 'Which queue layout should ship?', priority: 'now',
    origin: { name: 'queue-layout', harness: 'claude-code', host: 'laptop', cwd: '~/src/inbox' },
    text: 'I measured both layouts on 100 cards. Layout A shows more titles, and layout B shows the priority of each. It also affects [[rollout]].',
    recommendation: 'Layout B: the priority is what you scan for.',
    attachments: [
      { src: swatch([66, 90, 214]), name: 'layout-a.png', alt: 'Layout A' },
      { src: swatch([214, 132, 52]), name: 'layout-b.png', alt: 'Layout B' },
      { src: `data:text/markdown;base64,${Buffer.from(measurements).toString('base64')}`, name: 'measurements.md' },
    ],
    options: [{ id: 'a', label: 'Layout A', description: 'More titles on screen' }, { id: 'b', label: 'Layout B', description: 'Priority on every row' }],
  });
  await agent.post({ id: 'rollout', agent: 'release', title: 'Approve the rollout plan?', priority: 'soon', text: 'The plan rolls out to 10% of users first.', options: [{ id: 'y', label: 'Approve' }, { id: 'n', label: 'Hold' }] });
  await agent.post({ id: 'retry-flag', agent: 'cleanup', title: 'Rename the retry flag before the release?', priority: 'later', text: '`--retries` reads better than `--retry-count`.', options: [{ id: 'y', label: 'Rename' }, { id: 'n', label: 'Keep' }] });
  await agent.post({ id: 'api-tests', agent: 'api-tests', title: 'api-tests is waiting for you', priority: 'now', text: 'The test run needs a staging key.' });
  // The open card's agent listens, so the card shows it can take the answer now.
  void agent.stream('queue-layout', () => {}, stop.signal);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${server.url}/#token=${server.ownerToken}`);
  await page.locator('.bar .pill.on').waitFor();
  await page.locator('.q', { hasText: 'Which queue layout should ship?' }).click();
  await page.locator('.focus-card .recommendation').waitFor();
  await page.locator('.focus-card img').last().waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  const out = path.join(import.meta.dirname, '..', 'docs', 'screenshot.png');
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`wrote ${out}`);
} finally {
  stop.abort();
  await server.close();
  fs.rmSync(home, { recursive: true, force: true });
}
