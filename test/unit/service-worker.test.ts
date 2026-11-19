// The page's service worker, run in a stand-in worker scope: what a push shows, and where a click goes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, '../../web/sw.js'), 'utf8');

interface Shown { title: string; options: Record<string, unknown> }
interface Win { url: string; focused: boolean; navigated?: string; focus(): Promise<void>; navigate(url: string): Promise<void> }

function worker(scope: string, windows: Win[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    registration: { scope, showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
    clients: { matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn); },
  };
  vm.runInNewContext(SOURCE, { self, URL, JSON, encodeURIComponent, Promise });
  /** Dispatch an event and wait for what it handed to waitUntil. */
  const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { shown, opened, fire, has: (type: string) => listeners.has(type) };
}

const win = (url: string): Win => {
  const w: Win = { url, focused: false, focus: async () => { w.focused = true; }, navigate: async (to: string) => { w.navigated = to; } };
  return w;
};
const message = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } });
const SCOPE = 'https://hosted.example.invalid/i/0123/';

describe('the service worker', () => {
  it('shows a notification for a push, with the card title as its text and one tag for each card', async () => {
    const w = worker(SCOPE);
    await w.fire('push', message({ id: 'c1', title: 'Deploy now?' }));
    assert.equal(w.shown.length, 1);
    assert.equal(w.shown[0]?.title, 'A card is waiting for you');
    assert.equal(w.shown[0]?.options['body'], 'Deploy now?');
    assert.equal(w.shown[0]?.options['tag'], 'card:c1');
    assert.deepEqual(JSON.parse(JSON.stringify(w.shown[0]?.options['data'])), { id: 'c1' });
    assert.equal(w.shown[0]?.options['icon'], `${SCOPE}icon-192.png`, 'icons come from the inbox\'s own path, which a relay prefixes');
  });

  it('still shows something when the payload is empty or unreadable, since a browser needs a notification for each push', async () => {
    for (const event of [{ data: null }, message('not json'), message({ id: 5 }), message(null)]) {
      const w = worker(SCOPE);
      await w.fire('push', event);
      assert.equal(w.shown.length, 1);
      assert.equal(w.shown[0]?.title, 'A card is waiting for you');
      assert.equal(w.shown[0]?.options['body'], undefined);
    }
  });

  it('opens the card in a new window when no page of this inbox is open', async () => {
    const w = worker(SCOPE, [win('https://hosted.example.invalid/i/9999/')]);
    const closed: boolean[] = [];
    await w.fire('notificationclick', { notification: { data: { id: 'a b' }, close: () => closed.push(true) } });
    assert.deepEqual(closed, [true]);
    assert.deepEqual(w.opened, [`${SCOPE}#card=a%20b`], 'another inbox\'s page is not this one');
  });

  it('focuses a page of this inbox and moves it to the card, without opening a second window', async () => {
    const page = win(`${SCOPE}#card=old`);
    const w = worker(SCOPE, [win('https://hosted.example.invalid/elsewhere'), page]);
    await w.fire('notificationclick', { notification: { data: { id: 'c2' }, close: () => {} } });
    assert.equal(page.focused, true);
    assert.equal(page.navigated, `${SCOPE}#card=c2`);
    assert.deepEqual(w.opened, []);
  });

  it('opens a new window when the open page cannot be moved', async () => {
    const page = win(SCOPE);
    page.navigate = async () => { throw new Error('refused'); };
    const w = worker(SCOPE, [page]);
    await w.fire('notificationclick', { notification: { data: { id: 'c3' }, close: () => {} } });
    assert.deepEqual(w.opened, [`${SCOPE}#card=c3`]);
  });

  it('opens the inbox itself for a notification with no card', async () => {
    const w = worker('http://127.0.0.1:4815/');
    await w.fire('notificationclick', { notification: { data: undefined, close: () => {} } });
    assert.deepEqual(w.opened, ['http://127.0.0.1:4815/']);
  });

  it('takes over no request and keeps no cache', () => {
    const w = worker(SCOPE);
    assert.equal(w.has('fetch'), false);
    assert.ok(!/caches\./.test(SOURCE));
  });
});
