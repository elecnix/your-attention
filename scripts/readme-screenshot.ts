// Draws docs/screenshot.png, the README's picture of the inbox, from made-up cards on a fresh inbox. The open card asks
// for a key through the secret widget, so the picture shows a sealed field as the person sees it.
// Run it after a change to the page: node --disable-warning=ExperimentalWarning scripts/readme-screenshot.ts
// It draws dark, as the README shows it. `scripts/readme-screenshot.ts light /tmp/light.png` draws another scheme to another
// file, for a pull request that wants both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { Client } from '../src/client.ts';
import { SecretRequests } from '../src/integrations/secrets.ts';
import { serve } from '../src/node/server.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-screenshot-'));
const server = await serve({ port: 0, host: '127.0.0.1', home, mdns: false, watch: false, log: () => {}, telemetry: { url: 'http://127.0.0.1:9/v1/report' } });
// The screenshot shows the page after the person has read the usage notice.
server.inbox.usage.update({ notified: true });
// The screenshot shows an inbox whose person already answered the PIN offer.
server.inbox.pin.setNeverAsk(true);
const agent = new Client({ url: server.url, token: fs.readFileSync(path.join(home, 'agent-token'), 'utf8').trim() });
const stop = new AbortController();
try {
  // card_post fills the widget's public key the same way, so the page seals the value as it would for a real agent.
  const secrets = new SecretRequests();
  const sealing = await secrets.prepare([
    'root = Card([key, scope])',
    'key = widget secret {"name": "OLLAMA_API_KEY"}',
    'scope = Form("scope", none, [which])',
    'none = Buttons([])',
    'which = FormControl("What should the run do with it?", RadioGroup("run", [RadioItem("Run tonight at 02:00", "", "tonight"), RadioItem("Run once now, then tonight", "", "now")]))',
  ].join('\n'));
  const posted = await agent.post({
    id: 'eval-key', agent: 'nightly-eval', title: 'Give the nightly eval run an Ollama API key?', priority: 'now',
    origin: { name: 'nightly-eval', harness: 'claude-code', host: 'laptop', cwd: '~/src/evals' },
    text: [
      'The nightly eval run scores 240 prompts against `glm-5.1:cloud` at 02:00. It failed the last two nights with `401 Unauthorized`, because the key in the runner\'s environment was revoked on Nov 25.',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Your answer] -- sealed in your browser --> V[(Sealed value)]',
      '  V -- opened in this session --> G[Grant, 1 hour]',
      '  G -- OLLAMA_API_KEY --> C[Environment of each command]',
      '  G -. never .-> M[The model]',
      '```',
      '',
      'Type a key below and your browser seals it to this session\'s public key before it leaves the page. Only this session can open it. Each command it runs gets the value as `$OLLAMA_API_KEY` for one hour, and the model, the inbox, the hooks and the transcript never see it.',
    ].join('\n'),
    recommendation: 'Create a key for this run alone at [ollama.com/settings/keys](https://ollama.com/settings/keys), so you can revoke it without breaking anything else.',
    body: sealing.body,
  });
  sealing.keep(posted.id);
  await agent.post({ id: 'rollout', agent: 'release', title: 'Approve the rollout plan?', priority: 'soon', text: 'The plan rolls out to 10% of users first.', options: [{ id: 'y', label: 'Approve' }, { id: 'n', label: 'Hold' }] });
  await agent.post({ id: 'retry-flag', agent: 'cleanup', title: 'Rename the retry flag before the release?', priority: 'later', text: '`--retries` reads better than `--retry-count`.', options: [{ id: 'y', label: 'Rename' }, { id: 'n', label: 'Keep' }] });
  // The open card's agent listens, so the card shows it can take the answer now.
  void agent.stream('nightly-eval', () => {}, stop.signal);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: process.argv[2] === 'light' ? 'light' : 'dark' });
  await page.goto(`${server.url}/#token=${server.ownerToken}`);
  await page.locator('.bar .pill.on').waitFor();
  await page.locator('.q', { hasText: 'Give the nightly eval run an Ollama API key?' }).click();
  // The field shows the made-up value below as dots. It is no key, works nowhere, and says so, so a reader who
  // recovers it from the picture finds nothing to use.
  await page.getByLabel('OLLAMA_API_KEY', { exact: true }).fill('fixture-not-a-key-0000000000000000');
  await page.getByLabel('Run tonight at 02:00').check();
  await page.locator('.focus-card svg[id^="diagram-"]').first().waitFor();
  await page.mouse.move(0, 0);
  // The page grows with the diagram, so the picture takes its full height and cuts no part of the card.
  await page.setViewportSize({ width: 1440, height: await page.evaluate(() => document.documentElement.scrollHeight) });
  await page.waitForTimeout(500);
  const out = process.argv[3] ?? path.join(import.meta.dirname, '..', 'docs', 'screenshot.png');
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`wrote ${out}`);
} finally {
  stop.abort();
  await server.close();
  fs.rmSync(home, { recursive: true, force: true });
}
