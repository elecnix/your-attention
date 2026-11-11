import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { isSealed, newSealKeys, openSealed } from '../../src/core/sealed.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { describeAnswer } from '../../src/client.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { cardTools } from '../../src/integrations/tools.ts';
import type { Client } from '../../src/client.ts';
import type { Card, NewCard } from '../../src/core/types.ts';
import { seal } from '../../web/sealed.js';

const agent: Caller = { token: 'ta', role: 'agent' };
const owner: Caller = { token: 'to', role: 'owner' };

/** A body that places the secret widget with a public key, as card_post fills it. */
async function secretBody(name = 'API_KEY') {
  const keys = await newSealKeys();
  const body = `root = Card([intro, key])\nintro = TextContent("To call the demo API.")\nkey = widget secret ${JSON.stringify({ name, publicKey: JSON.stringify(keys.publicKey) })}`;
  return { keys, body };
}

describe('sealed secrets', () => {
  it('opens what the page sealed, and only with the key that asked', async () => {
    const keys = await newSealKeys();
    const sealed = await seal(keys.publicKey, 'sk-example-not-real');
    assert.ok(isSealed(sealed));
    assert.doesNotMatch(JSON.stringify(sealed), /sk-example/);
    assert.equal(await openSealed(keys.privateKey, sealed), 'sk-example-not-real');
    const other = await newSealKeys();
    await assert.rejects(openSealed(other.privateKey, sealed));
  });
});

describe('the secret widget', () => {
  it('is a built-in widget that the guidance lists with when to place it', () => {
    const inbox = new Inbox(new MemoryStorage());
    assert.ok(inbox.listWidgets().some((w) => w.name === 'secret' && w.builtin));
    assert.match(inbox.widgetCatalog(), /- secret: .*card_post fills/);
  });

  it('places a sealed field on a card of any kind, and the card names the field', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const { body } = await secretBody('OLLAMA_API_KEY');
    const card = inbox.postCard(agent, { agent: 's1', title: 'Key?', body, options: [{ id: 'o1', label: 'Use staging' }] });
    assert.equal(card.kind, 'ask');
    assert.match(card.body ?? '', /SecretInput\("OLLAMA_API_KEY", "\{/);
    assert.deepEqual(card.secrets, ['OLLAMA_API_KEY']);
  });

  it('refuses a placement without the public key that card_post fills, a private key, a bad name, or a name used twice', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const keys = await newSealKeys();
    const place = (values: Record<string, unknown>) => `root = Card([k])\nk = widget secret ${JSON.stringify(values)}`;
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Key?', body: place({ name: 'API_KEY' }) }), /API_KEY needs the public key.*card_post/);
    const priv = await crypto.subtle.generateKey({ name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', priv.privateKey);
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Key?', body: place({ name: 'API_KEY', publicKey: JSON.stringify(jwk) }) }), /private/);
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Key?', body: place({ name: 'bad name', publicKey: JSON.stringify(keys.publicKey) }) }), /variable name/);
    const twice = `root = Card([a, b])\na = widget secret ${JSON.stringify({ name: 'K', publicKey: JSON.stringify(keys.publicKey) })}\nb = widget secret ${JSON.stringify({ name: 'K', publicKey: JSON.stringify(keys.publicKey) })}`;
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Key?', body: twice }), /K twice/);
  });

  it('finds a call after a single-quoted string or a comment that holds a double quote, as the OpenUI parser reads them', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const keys = await newSealKeys();
    const key = JSON.stringify(JSON.stringify(keys.publicKey));
    const single = inbox.postCard(agent, { agent: 's1', title: 'Key?', body: `root = Card([t, k])\nt = TextContent('say "hi"')\nk = Form("k", b, [f])\nb = Buttons([])\nf = FormControl("A", SecretInput("A", ${key}))` });
    assert.deepEqual(single.secrets, ['A']);
    const comment = inbox.postCard(agent, { agent: 's1', title: 'Key?', body: `root = Card([k]) # it's "the key\nk = Form("k", b, [f])\nb = Buttons([])\nf = FormControl("B", SecretInput('B', ${key}))` });
    assert.deepEqual(comment.secrets, ['B']);
  });

  it('answers 400, not an internal error, for a name with an escape JSON does not read', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const keys = await newSealKeys();
    const body = `root = Card([k])\nk = Form("k", b, [f])\nb = Buttons([])\nf = FormControl("A", SecretInput("A\\'B", ${JSON.stringify(JSON.stringify(keys.publicKey))}))`;
    assert.throws(() => inbox.postCard(agent, { agent: 's1', title: 'Key?', body }), (e: Error & { status?: number }) => e.status === 400 && /variable name/.test(e.message));
  });

  it('revises a secret card that an older inbox stored, and keeps what it asks for', async () => {
    const storage = new MemoryStorage();
    const inbox = new Inbox(storage);
    const { publicKey } = await newSealKeys();
    const old = inbox.postCard(agent, { id: 'old', agent: 's1', title: 'Paste the key', text: 'For the deploy.' });
    storage.put('cards', 'old', { ...old, kind: 'secret', secret: { name: 'OLD_KEY', publicKey } });
    const patched = inbox.patchCard(agent, 'old', [{ old: 'deploy', new: 'staging deploy' }], 'text');
    assert.equal(patched.kind, 'secret');
    assert.equal(patched.secret?.name, 'OLD_KEY');
    assert.equal(patched.text, 'For the staging deploy.');
  });

  it('reads SecretInput in a string as text, not as a field', () => {
    const inbox = new Inbox(new MemoryStorage());
    const card = inbox.postCard(agent, { agent: 's1', title: 'Docs', body: 'root = Card([t])\nt = TextContent("Write SecretInput(\\"X\\", \\"\\") to ask.")' });
    assert.equal(card.secrets, undefined);
  });

  it('refuses the removed secret card kind, and names the widget', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const { publicKey } = await newSealKeys();
    assert.throws(() => inbox.postCard(agent, { agent: 's1', kind: 'secret', title: 'Key?', secret: { name: 'K', publicKey } } as never), /widget secret/);
  });

  it('stores only a sealed value in a secret field, never plain text or an image', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const { keys, body } = await secretBody();
    inbox.postCard(agent, { id: 'k1', agent: 's1', title: 'Key?', body });
    await assert.rejects(inbox.answer('k1', { values: { API_KEY: 'plain' } }), /API_KEY takes only a sealed value/);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await assert.rejects(inbox.answer('k1', { values: {}, images: [{ src: png, name: 'k.png', field: 'API_KEY' }] }), /API_KEY takes no images/);
    const sealed = await seal(keys.publicKey, 'value');
    const a = await inbox.answer('k1', { values: { API_KEY: sealed, other: 'fine' } });
    assert.ok(isSealed(a.values['API_KEY']));
    assert.equal(inbox.search(sealed.data.slice(0, 12)).length, 0, 'a sealed value stays out of search');
    const declined = await inbox.answer('k1', { values: { API_KEY: '' }, comment: 'Use the staging key instead.' });
    assert.equal(declined.values['API_KEY'], undefined, 'an empty field declines, and the inbox keeps nothing for it');
  });

  it('declines an empty secret field whose name an object inherits, such as constructor', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const { body } = await secretBody('constructor');
    inbox.postCard(agent, { id: 'k2', agent: 's1', title: 'Key?', body });
    const a = await inbox.answer('k2', { values: {}, comment: 'Not now.' });
    assert.equal(Object.hasOwn(a.values, 'constructor'), false);
  });

  it('keeps a secret field out of a dismissal\'s draft', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const { body } = await secretBody();
    inbox.postCard(agent, { id: 'k1', agent: 's1', title: 'Key?', body });
    const card = inbox.dismiss(owner, 'k1', { values: { API_KEY: 'sk-live-1234', note: 'kept' }, comment: 'Using the other key.' });
    assert.deepEqual(card.closed?.draft?.values, { note: 'kept' });
  });

  it('sends the answer to hooks without the sealed value', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const seen: unknown[] = [];
    inbox.connectExtension({ token: 'te', role: 'extension' }, { name: 'watch', hooks: ['answer.saved'] }, (ev) => seen.push(ev));
    const { keys, body } = await secretBody();
    inbox.postCard(owner, { id: 'k1', agent: 's1', title: 'Key?', body });
    await inbox.answer('k1', { values: { API_KEY: await seal(keys.publicKey, 'v'), note: 'n' } });
    const ev = seen.find((e) => (e as { hook?: string }).hook === 'answer.saved') as { answer: { values: Record<string, unknown> } } | undefined;
    assert.deepEqual(ev?.answer.values, { note: 'n' });
  });

  it('describes a sealed value to the agent without its ciphertext', async () => {
    const keys = await newSealKeys();
    const sealed = await seal(keys.publicKey, 'v');
    const text = describeAnswer({ id: 'k1', secrets: ['API_KEY'] } as Card, { values: { API_KEY: sealed } } as never);
    assert.equal(text, 'API_KEY: (sealed)');
  });
});

describe('the integration side of the secret widget', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-secret-'));
  process.env['YOUR_ATTENTION_HOME'] = home;

  /** A client that posts into an in-memory inbox, as card_post does. */
  function client(inbox: Inbox): Client {
    return { post: async (c: NewCard) => inbox.postCard(agent, c) } as unknown as Client;
  }

  it('fills the public key in card_post, and opens the answer into a private file named by the field', async () => {
    const inbox = new Inbox(new MemoryStorage());
    const secrets = new SecretRequests();
    const ctx = { inbox: client(inbox), secrets, agent: 's1', origin: async () => undefined, arrival: 'later' };
    const said = await runTool(ctx, 'card_post', { id: 'k1', title: 'Key?', body: 'root = Card([intro, key])\nintro = TextContent("To call the demo API.")\nkey = widget secret {"name": "DEMO_KEY"}' });
    assert.match(said, /Posted card k1/);
    const card = inbox.getCard('k1');
    assert.deepEqual(card.secrets, ['DEMO_KEY']);
    const publicKey = JSON.parse(/SecretInput\("DEMO_KEY", ("(?:[^"\\]|\\.)*")\)/.exec(card.body ?? '')![1]!);
    const answer = await inbox.answer('k1', { values: { DEMO_KEY: await seal(JSON.parse(publicKey), 'demo-value-not-real') } });
    const text = await secrets.receive(card, answer);
    assert.doesNotMatch(text, /demo-value-not-real/);
    const file = /It is in (\S+), which/.exec(text)?.[1];
    assert.equal(file, path.join(home, 'secrets', 's1', 'DEMO_KEY'));
    assert.equal(fs.readFileSync(String(file), 'utf8'), 'demo-value-not-real');
    if (process.platform !== 'win32') assert.equal(fs.statSync(String(file)).mode & 0o777, 0o600);
    const empty = await inbox.answer('k1', { values: {}, comment: 'Not now.' });
    assert.match(await secrets.receive(card, empty), /did not send DEMO_KEY/);
  });

  it('answers an old card_ask_secret call with the widget that replaces it', async () => {
    assert.ok(!cardTools.some((t) => t.name === 'card_ask_secret'));
    const ctx = { inbox: client(new Inbox(new MemoryStorage())), secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'later' };
    await assert.rejects(runTool(ctx, 'card_ask_secret', { name: 'K', title: 'Key?' }), /card_ask_secret was removed.*widget secret \{"name": "/);
  });
});
