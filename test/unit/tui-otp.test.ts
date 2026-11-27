// The otp field in the terminal client: the same key, purpose and holder as the page, an approve or decline choice,
// and no digits, since the terminal answers a decision and the inbox mints the ticket.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { newSealKeys } from '../../src/core/sealed.ts';
import type { Card } from '../../src/core/types.ts';
import { BUILTIN_WIDGETS, expandWidgets } from '../../src/core/widgets.ts';
import { loadParser } from '../../src/tui/body.ts';
import { setup } from './tui-pane.ts';

async function pane() {
  const keys = await newSealKeys();
  const widget = { name: 'otp', ...BUILTIN_WIDGETS.find((w) => w.name === 'otp')!.versions[0]! };
  const body = expandWidgets([
    'root = Card([intro, npm])',
    'intro = TextContent("The automated review passed.")',
    `npm = widget otp ${JSON.stringify({ name: 'NPM_OTP', key: 'npm', purpose: 'npm stage approve your-attention@1.4.0', publicKey: JSON.stringify(keys.publicKey) })}`,
  ].join('\n'), () => widget).body;
  const c: Card = { id: 'otp', agent: 'a1', kind: 'ask', title: 'Publish?', priority: 'now', deliver: 'stream', version: 1, createdAt: 0, updatedAt: 0, replies: [], body, otp: ['NPM_OTP'], otpHolder: 'your own inbox on mbp, in ~/.your-attention/otp-keys.json, which only its user reads' };
  return setup(c, {}, 110);
}

before(async () => { await loadParser(); });

describe('an otp field in the terminal', () => {
  it('shows the key, the purpose and which inbox holds the key, with approve and decline', async () => {
    const t = (await pane()).text();
    assert.match(t, /One-time code from the key npm/);
    assert.match(t, /For: npm stage approve your-attention@1\.4\.0/);
    assert.match(t, /Key kept by: your own inbox on mbp, in ~\/\.your-attention\/otp-keys\.json, which only its user reads/);
    assert.match(t, /Approve one code from npm/);
    assert.match(t, /Decline/);
  });

  it('sends nothing for a field the person left alone, and the decision the person picked', async () => {
    const untouched = await pane();
    assert.deepEqual((await untouched.view.sealedAnswer()).values, {});
    const { view, focus, key } = await pane();
    focus('field:NPM_OTP/NPM_OTP');
    key('space');
    assert.deepEqual((await view.sealedAnswer()).values, { NPM_OTP: 'approve' });
    key('down');
    key('space');
    assert.deepEqual((await view.sealedAnswer()).values, { NPM_OTP: 'decline' });
  });
});
