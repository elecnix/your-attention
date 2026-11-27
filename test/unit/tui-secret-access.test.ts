// The secret_access field in the terminal client: the same candidates, choices and answer values as the page.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { newSealKeys, openSealed } from '../../src/core/sealed.ts';
import type { Card, Sealed } from '../../src/core/types.ts';
import { loadParser } from '../../src/tui/body.ts';
import { accessBody } from '../../web/stories/access.js';
import { setup } from './tui-pane.ts';


const CANDIDATES = [
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'laptop', type: 'api-key', host: 'api.openai.com' },
  { id: 'openai-team', label: 'OpenAI key, team', source: 'vault', instance: 'laptop', status: 'off', reason: 'the vault is locked' },
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'desktop' },
];

/** A card with one SecretAccess field per entry, each in a form of its own, and the pane that draws it. */
async function pane(fields: { name: string; candidates: unknown[] }[]) {
  const keys = await newSealKeys();
  const body = accessBody(fields, 'A card that asks for secrets.', keys.publicKey);
  const c: Card = { id: 'acc', agent: 'a1', kind: 'ask', title: 'Secrets', priority: 'now', deliver: 'stream', version: 1, createdAt: 0, updatedAt: 0, replies: [], body, secrets: fields.map((f) => f.name) };
  return { keys, ...setup(c, {}, 90) };
}
const twoFields = () => pane([{ name: 'OPENAI_API_KEY', candidates: CANDIDATES }, { name: 'DEPLOY_TOKEN', candidates: [] }]);

before(async () => { await loadParser(); });

describe('a secret_access field in the terminal', () => {
  it('shows each candidate with its source and instance, grouped by instance, and an unavailable one as such', async () => {
    const t = (await twoFields()).text();
    assert.match(t, /On laptop/);
    assert.match(t, /On desktop/);
    assert.match(t, /age on laptop · api-key · api\.openai\.com/);
    assert.match(t, /unavailable: the vault is locked/);
    assert.match(t, /Decline: the agent gets no access to OPENAI_API_KEY/);
    assert.match(t, /Type a value for DEPLOY_TOKEN instead/);
  });

  it('sends nothing for a field the person left alone', async () => {
    const { values } = await (await twoFields()).view.sealedAnswer();
    assert.deepEqual(values, {});
  });

  it('grants a candidate, skipping the unavailable one, until the answer time plus the ceiling picked', async () => {
    const { view, focus, key, text } = await twoFields();
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
    const { keys, view, focus, key, type } = await twoFields();
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

  it('keeps the keyboard working after a revision drops the candidate it highlighted', async () => {
    const { view, focus, key, text } = await twoFields();
    focus('access:OPENAI_API_KEY/OPENAI_API_KEY');
    key('down'); key('down'); key('down'); // to Type a value, the last row
    const fewer = await pane([{ name: 'OPENAI_API_KEY', candidates: [] }, { name: 'DEPLOY_TOKEN', candidates: [] }]);
    view.card = { ...view.card, version: 2, body: fewer.view.card.body };
    focus('access:OPENAI_API_KEY/OPENAI_API_KEY');
    key('up');
    key('space');
    assert.match(text(), /▶ \(•\) Decline: the agent gets no access to OPENAI_API_KEY/);
  });

  it('draws a field name and an instance without their escape sequences', async () => {
    const { focus, key, text } = await pane([{ name: 'BAD\u001b]0;owned\u0007', candidates: [{ id: 'x', label: 'X', source: 'age', instance: 'lap\u001b[2Jtop' }] }]);
    focus('access:');
    key('space');
    const t = text();
    assert.match(t, /access ends at most after/);
    assert.doesNotMatch(t, /\u001b|\u0007/);
  });
});
