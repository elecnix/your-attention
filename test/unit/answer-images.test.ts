import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Answer, Card } from '../../src/core/types.ts';
import { describeAnswer } from '../../src/client.ts';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { imagesDir, saveAnswerImages } from '../../src/integrations/images.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import { checkImage, draftProblem, imageFiles, IMAGE_LIMIT_BYTES, IMAGE_TYPES } from '../../web/paste-images.js';

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

describe('where the images of an answer land', () => {
  const withHome = async (home: string, run: () => void | Promise<void>) => {
    const saved = process.env['YOUR_ATTENTION_HOME'];
    process.env['YOUR_ATTENTION_HOME'] = home;
    try { await run(); } finally {
      if (saved === undefined) delete process.env['YOUR_ATTENTION_HOME'];
      else process.env['YOUR_ATTENTION_HOME'] = saved;
    }
  };

  it('keeps a card id or an agent name of .. inside the images folder', async () => {
    const home = path.join(os.tmpdir(), 'ya-images-names');
    await withHome(home, () => {
      // The card id and the agent name both come from the agent, so neither may walk up a level.
      assert.equal(imagesDir('..', '..'), path.join(home, 'images', '_', '_'));
      assert.equal(imagesDir('', '.'), path.join(home, 'images', '_', '_'));
      assert.equal(imagesDir('s1', '../../etc'), path.join(home, 'images', 's1', '.._.._etc'));
      assert.equal(imagesDir('s1', 'c1'), path.join(home, 'images', 's1', 'c1'));
      // The OpenCode plugin names its agent `opencode:<session>`, and a colon cannot be in a Windows path: the
      // sanitiser replaces it, so the folder it makes is legal on every system.
      assert.equal(imagesDir('opencode:s1', 'c1'), path.join(home, 'images', 'opencode_s1', 'c1'));
    });
  });

  it('gives a line for each image when the folder cannot be made, rather than losing the answer', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-images-home-'));
    // A file where the images folder has to go, which makes mkdirSync fail the way a read-only home does.
    fs.writeFileSync(path.join(home, 'images'), '');
    await withHome(home, async () => {
      const answer = { card: 'c1', savedAt: 7, images: [{ id: 'a1', name: 'shot.png', type: 'image/png', size: 3 }] } as unknown as Answer;
      const reached = async () => { throw new Error('the fetch was never needed'); };
      const lines = await saveAnswerImages({ attachment: reached } as never, 's1', answer);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /^shot\.png \(could not be saved: /);
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('an answer whose images take a moment', () => {
  it('reaches the agent that holds the card when the images finish, not the one that held it before', async () => {
    // Another session may claim the card while the files are written. The claim's flush runs before this answer
    // exists, so the answer has to name the card's new agent when it delivers, or nothing streams it.
    const blobs = new MemoryBlobs();
    const inbox = new Inbox(new MemoryStorage(), Date.now, blobs);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
    const heard = { s1: [] as string[], s2: [] as string[] };
    inbox.connect(agent, 's1', (e) => heard.s1.push(e.type));
    inbox.connect(agent, 's2', (e) => heard.s2.push(e.type));
    const put = blobs.put.bind(blobs);
    blobs.put = async (key, bytes, type) => { await put(key, bytes, type); inbox.claim(agent, 'c1', 's2'); };
    await inbox.answer('c1', { comment: 'see this', images: [{ src: png, name: 's.png' }] });
    assert.deepEqual(heard.s2.filter((t) => t === 'answer'), ['answer'], 'the new holder of the card receives the answer');
    assert.deepEqual(heard.s1.filter((t) => t === 'answer'), [], 'the agent that no longer holds the card receives nothing');
  });
});

describe('the images of one answer share a byte budget', () => {
  it('refuses images that add up to more than the answer route can carry, and says the total', () => {
    const file = (size: number) => ({ type: 'image/png', size, name: 'shot.png' });
    const held = [{ size: 4 * 1024 * 1024 }, { size: 4 * 1024 * 1024 }];
    assert.equal(draftProblem(held, file(2 * 1024 * 1024)), null, 'ten megabytes still fit');
    assert.match(draftProblem(held, file(3 * 1024 * 1024)) ?? '', /add up to 11 MB.*at most 10 MB of images/);
  });

  it('an answer over the budget is refused with 413, before anything is stored', async () => {
    const inbox = setup();
    // 8 MB of base64 is 6 MB of bytes, so two of them are past the 10 MB an answer carries and each is under the 8 MB
    // an image may be.
    const big = `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}`;
    await assert.rejects(inbox.answer('c1', { images: [{ src: big, name: 'one.png' }, { src: big, name: 'two.png' }] }), (e: Error & { status?: number }) => e.status === 413);
    // Nothing was stored, so the card is still waiting and its answer slot is empty.
    assert.equal((await inbox.answer('c1', { comment: 'just text' })).images, undefined);
  });
});

describe('an answer whose card is gone by the time its images are written', () => {
  it('gives the bytes back and leaves no file behind', async () => {
    // `reset` can delete the card while the blobs are written. The images are charged to the lifetime upload limit
    // before that, so a 404 that kept them would charge the inbox for files nothing names.
    const blobs = new MemoryBlobs();
    const inbox = new Inbox(new MemoryStorage(), Date.now, blobs);
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which one?' });
    const used = inbox.uploads().used;
    const written: string[] = [];
    const put = blobs.put.bind(blobs);
    blobs.put = async (key, bytes, type) => { written.push(key); await put(key, bytes, type); await inbox.reset({ token: 'to', role: 'owner' }); };
    await assert.rejects(inbox.answer('c1', { images: [{ src: png, name: 's.png' }] }), /unknown card/);
    assert.equal(written.length, 1, 'the image was written before the card went');
    assert.equal(inbox.uploads().used, used, 'the bytes are charged and then given back');
    await assert.rejects(inbox.attachment(agent, written[0]!), 'the file went with the refund');
  });
});
