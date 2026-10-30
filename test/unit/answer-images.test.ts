import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Answer, Card } from '../../src/core/types.ts';
import { describeAnswer } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import { checkImage, imageFiles, IMAGE_LIMIT_BYTES, IMAGE_TYPES } from '../../web/paste-images.js';

// A 1x1 PNG.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const agent: Caller = { token: 'ta', role: 'agent' };

function setup() {
  const inbox = new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs());
  inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
  return inbox;
}

describe('images pasted into an answer', () => {
  it('stores each image and serves its bytes to the agent that asked', async () => {
    const inbox = setup();
    const a = await inbox.answer('c1', { comment: 'see these', images: [{ src: png, name: 'shot.png', field: 'comment' }, { src: png }] });
    assert.equal(a.images?.length, 2);
    assert.deepEqual(a.images?.map((f) => [f.name, f.type, f.field]), [['shot.png', 'image/png', 'comment'], ['pasted-2.png', 'image/png', undefined]]);
    const back = await inbox.attachment(agent, a.images![0]!.id!);
    assert.equal(back.file.type, 'image/png');
    assert.equal(back.bytes.length, 70);
    await assert.rejects(inbox.attachment({ token: 'other', role: 'agent' }, a.images![0]!.id!), /another client/);
    assert.equal((await inbox.attachment({ token: 'o', role: 'owner' }, a.images![1]!.id!)).file.name, 'pasted-2.png');
  });

  it('refuses a file that is not an image, and says which one', async () => {
    const inbox = setup();
    const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`;
    await assert.rejects(inbox.answer('c1', { images: [{ src: png }, { src: pdf, name: 'a.pdf' }] }), /image 2 \(a\.pdf\).*PNG, JPEG, GIF or WebP/);
    await assert.rejects(inbox.answer('c1', { images: [{ src: 'https://example.com/a.png' }] }), /data: URL/);
  });

  it('refuses an image over 8 MB and more than 10 images', async () => {
    const inbox = setup();
    const big = `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 64).toString('base64')}`;
    await assert.rejects(inbox.answer('c1', { images: [{ src: big }] }), (e: Error & { status?: number }) => e.status === 413);
    await assert.rejects(inbox.answer('c1', { images: Array.from({ length: 11 }, () => ({ src: png })) }), /at most 10 images/);
  });

  it('keeps the images of an earlier answer in previous, and deletes none until the card goes', async () => {
    const inbox = setup();
    const first = await inbox.answer('c1', { images: [{ src: png }] });
    const second = await inbox.answer('c1', { comment: 'again' });
    assert.equal(second.images, undefined);
    assert.equal(second.previous[0]?.images?.[0]?.id, first.images?.[0]?.id);
    await inbox.attachment(agent, first.images![0]!.id!);
  });

  it('serves it through the answer route', async () => {
    const inbox = setup();
    const handle = createHandler(inbox, { heartbeatMs: 50 });
    const owner = (await inbox.createToken('page', 'owner')).secret;
    const res = await handle(new Request('http://inbox.test/v1/cards/c1/answer', {
      method: 'POST', headers: { authorization: `Bearer ${owner}` },
      body: JSON.stringify({ values: {}, images: [{ src: png, name: 'a.png', field: 'q0' }] }),
    }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { images: unknown[] }).images.length, 1);
  });

  it('tells the agent where each image is', () => {
    const c = { id: 'c1', agent: 's1', kind: 'ask', title: 'q', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] } as Card;
    const a = { card: 'c1', version: 1, values: {}, comment: 'see', delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [],
      images: [{ id: 'i1', name: 'shot.png', type: 'image/png', field: 'comment' }, { id: 'i2', name: 'b.png', type: 'image/png' }] } as Answer;
    assert.equal(describeAnswer(c, a, ['/home/u/img/shot.png', '/home/u/img/b.png']),
      'Comment: see\nImage pasted in comment: /home/u/img/shot.png\nImage: /home/u/img/b.png');
    assert.match(describeAnswer(c, a), /2 pasted images/);
  });
});

describe('paste handler', () => {
  const file = (type: string, size = 10, name = 'x') => ({ type, size, name, kind: 'file' });
  it('takes the image files from the clipboard and leaves text alone', () => {
    const items = [{ kind: 'string', type: 'text/plain', getAsFile: () => null }, { kind: 'file', type: 'image/png', getAsFile: () => file('image/png') }];
    assert.equal(imageFiles({ items } as never).length, 1);
    assert.equal(imageFiles({ items: [items[0]] } as never).length, 0);
    assert.equal(imageFiles(null).length, 0);
  });
  it('accepts the four image types and refuses the rest with a message', () => {
    for (const t of IMAGE_TYPES) assert.equal(checkImage(file(t)), null);
    assert.match(checkImage(file('application/pdf', 5, 'a.pdf')) ?? '', /a\.pdf.*PNG, JPEG, GIF or WebP/);
    assert.match(checkImage(file('image/png', IMAGE_LIMIT_BYTES + 1, 'big.png')) ?? '', /big\.png.*8 MB/);
  });
});
