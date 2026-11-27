// The secret_access field in the terminal client: the same candidates, choices and answer values as the page.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { summarize } from '../../src/core/summary.ts';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import type { Card, Sealed } from '../../src/core/types.ts';
import { loadParser } from '../../src/tui/body.ts';
import { CardView, type CardViewHost } from '../../src/tui/cardview.ts';
import type { KeyEvent } from '../../src/tui/input.ts';
import { makeTheme } from '../../src/tui/theme.ts';
import { buildQueue, type InboxState } from '../../web/queue.js';

const theme = makeTheme({ color: 0, unicode: true, hyperlinks: false });
const plain = (doc: { lines: { spans: { text: string }[] }[] }): string => doc.lines.map((l) => l.spans.map((x) => x.text).join('')).join('\n');
const J = JSON.stringify;

const CANDIDATES = [
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'laptop', type: 'api-key', host: 'api.openai.com' },
  { id: 'openai-team', label: 'OpenAI key, team', source: 'vault', instance: 'laptop', status: 'off', reason: 'the vault is locked' },
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'desktop' },
];

async function setup() {
  const keys = await newSealKeys();
  const body = [
    'root = Card([a, b])',
    'a = Form("OPENAI_API_KEY", ab, [af])', 'ab = Buttons([])',
    `af = FormControl("OPENAI_API_KEY", SecretAccess("OPENAI_API_KEY", ${J(J(keys.publicKey))}, ${J(J(CANDIDATES))}))`,
    'b = Form("DEPLOY_TOKEN", bb, [bf])', 'bb = Buttons([])',
    `bf = FormControl("DEPLOY_TOKEN", SecretAccess("DEPLOY_TOKEN", ${J(J(keys.publicKey))}, "[]"))`,
  ].join('\n');
  const c: Card = { id: 'acc', agent: 'a1', kind: 'ask', title: 'Two secrets', priority: 'now', deliver: 'stream', version: 1, createdAt: 0, updatedAt: 0, replies: [], body, secrets: ['OPENAI_API_KEY', 'DEPLOY_TOKEN'] };
  const host: CardViewHost = { theme, address: (id) => `http://127.0.0.1:4815/#card=${id}`, act: () => {}, fileText: () => undefined, now: () => 600_000 };
  const s: InboxState = { cards: [summarize(c, undefined)], answers: {}, presence: {}, states: { [c.id]: 'open' }, levels: [{ id: 'now', label: 'Decide now', definition: '', color: '#e5484d' }] };
  const view = new CardView(c, host);
  const build = () => view.build(90, s, buildQueue(s, 'none'));
  build();
  const text = () => plain(build());
  const focus = (prefix: string) => { build(); const id = view.stops().find((x) => x.startsWith(prefix)); assert.ok(id, `no stop ${prefix} in ${view.stops().join(', ')}`); view.focus = id; build(); };
  const key = (name: string, mods: Partial<KeyEvent> = {}) => { view.key({ type: 'key', name, ctrl: false, alt: false, shift: false, ...mods }); build(); };
  const type = (t: string) => { for (const ch of t) key(ch, { text: ch }); };
  return { keys, view, text, focus, key, type };
}

before(async () => { await loadParser(); });

describe('a secret_access field in the terminal', () => {
  it('shows each candidate with its source and instance, grouped by instance, and an unavailable one as such', async () => {
    const { text } = await setup();
    const t = text();
    assert.match(t, /On laptop/);
    assert.match(t, /On desktop/);
    assert.match(t, /age on laptop · api-key · api\.openai\.com/);
    assert.match(t, /unavailable: the vault is locked/);
    assert.match(t, /Decline: the agent gets no access to OPENAI_API_KEY/);
    assert.match(t, /Type a value for DEPLOY_TOKEN instead/);
  });

  it('sends nothing for a field the person left alone', async () => {
    const { view } = await setup();
    const { values } = await view.sealedAnswer();
    assert.deepEqual(values, {});
  });

  it('grants a candidate, skipping the unavailable one, until the answer time plus the ceiling picked', async () => {
    const { view, focus, key, text } = await setup();
    focus('access:OPENAI_API_KEY/OPENAI_API_KEY');
    key('down'); // past the unavailable candidate, to the one on desktop
    key('space');
    assert.match(text(), /OPENAI_API_KEY access ends at most after/);
    assert.match(text(), /15 minutes without use/);
    focus('ceiling:OPENAI_API_KEY');
    key('right'); // from 1 hour to 4 hours
    const before = Date.now();
    const { values } = await view.sealedAnswer();
    const v = values['OPENAI_API_KEY'] as { grant: string; source: string; instance: string; until: number };
    assert.deepEqual({ ...v, until: 0 }, { grant: 'openai', source: 'age', instance: 'desktop', until: 0 });
    assert.ok(v.until >= before + 4 * 3600_000 && v.until <= Date.now() + 4 * 3600_000);
  });

  it('declines one field and seals a typed value in the other', async () => {
    const { keys, view, focus, key, type } = await setup();
    focus('access:OPENAI_API_KEY/OPENAI_API_KEY');
    key('down'); key('down'); // decline
    key('space');
    focus('access:DEPLOY_TOKEN/DEPLOY_TOKEN');
    key('down'); // type a value
    key('space');
    focus('field:DEPLOY_TOKEN/DEPLOY_TOKEN');
    type('made-up-token');
    const { values } = await view.sealedAnswer();
    assert.deepEqual(values['OPENAI_API_KEY'], { decline: true });
    assert.equal(await openSealed(keys.privateKey, values['DEPLOY_TOKEN'] as Sealed), 'made-up-token');
    // A dismissal never records what was typed.
    assert.equal(view.draft().values['DEPLOY_TOKEN'], undefined);
  });
});

describe('a secret_access field with control characters', () => {
  it('draws the field name and the instance without their escape sequences', async () => {
    const keys = await newSealKeys();
    const name = 'BAD\u001b]0;owned\u0007';
    const cands = [{ id: 'x', label: 'X', source: 'age', instance: 'lap\u001b[2Jtop' }];
    const body = ['root = Card([a])', `a = Form("f", ab, [af])`, 'ab = Buttons([])', `af = FormControl("F", SecretAccess(${J(name)}, ${J(J(keys.publicKey))}, ${J(J(cands))}))`].join('\n');
    const c: Card = { id: 'esc', agent: 'a1', kind: 'ask', title: 'Escapes', priority: 'now', deliver: 'stream', version: 1, createdAt: 0, updatedAt: 0, replies: [], body };
    const host: CardViewHost = { theme, address: (id) => `http://127.0.0.1:4815/#card=${id}`, act: () => {}, fileText: () => undefined, now: () => 600_000 };
    const s: InboxState = { cards: [summarize(c, undefined)], answers: {}, presence: {}, states: { [c.id]: 'open' }, levels: [{ id: 'now', label: 'Decide now', definition: '', color: '#e5484d' }] };
    const view = new CardView(c, host);
    const build = () => view.build(90, s, buildQueue(s, 'none'));
    build();
    view.focus = view.stops().find((x) => x.startsWith('access:'));
    build();
    view.key({ type: 'key', name: 'space', ctrl: false, alt: false, shift: false });
    const t = plain(build());
    assert.match(t, /access ends at most after/);
    assert.doesNotMatch(t, /\u001b|\u0007/);
  });
});
