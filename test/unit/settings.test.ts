// The inbox's owner settings: Group by and the pinned tag values live here, next to allowHtml, so every page and the
// terminal client share them. The owner changes them with PUT /v1/settings, and GET /v1/state returns them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InboxError } from '../../src/core/inbox.ts';
import type { Pin } from '../../src/core/types.ts';
import { oneCardInbox } from './fixture.ts';

describe('settings', () => {
  it('starts with allowHtml off and no grouping or pins', () => {
    assert.deepEqual(oneCardInbox().settings(), { allowHtml: false });
  });

  it('round trips Group by and the pinned tag values', () => {
    const inbox = oneCardInbox();
    const saved = inbox.setSettings({ groupBy: 'tag:repo', pins: [['topic', 'billing'], ['repo', 'acme/api']] });
    assert.equal(saved.groupBy, 'tag:repo');
    assert.deepEqual(saved.pins, [['topic', 'billing'], ['repo', 'acme/api']]);
    assert.deepEqual(inbox.settings(), saved);
  });

  it('keeps the other settings on a partial change', () => {
    const inbox = oneCardInbox();
    inbox.setSettings({ allowHtml: true, groupBy: 'agent', pins: [['topic', 'billing']] });
    const next = inbox.setSettings({ pins: [] });
    assert.deepEqual(next, { allowHtml: true, groupBy: 'agent', pins: [] });
  });

  it('adds and removes one pin at a time, so a pin another device sets survives', () => {
    const inbox = oneCardInbox();
    inbox.setSettings({ pins: [['topic', 'billing']] });
    // Two devices pin different values: each change names only its own.
    assert.deepEqual(inbox.setSettings({ pinAdd: [['topic', 'search']] }).pins, [['topic', 'billing'], ['topic', 'search']]);
    assert.deepEqual(inbox.setSettings({ pinAdd: [['repo', 'acme/api']] }).pins, [['topic', 'billing'], ['topic', 'search'], ['repo', 'acme/api']]);
    assert.deepEqual(inbox.setSettings({ pinRemove: [['topic', 'billing']] }).pins, [['topic', 'search'], ['repo', 'acme/api']]);
    assert.deepEqual(inbox.setSettings({ pinAdd: [['repo', 'acme/api']] }).pins, [['topic', 'search'], ['repo', 'acme/api']], 'a pin already there stays once');
  });

  it('keeps an agent pin beside a tag pin, and takes either back out', () => {
    const inbox = oneCardInbox();
    assert.deepEqual(inbox.setSettings({ pins: [['topic', 'billing'], { agent: 's1' }] }).pins, [['topic', 'billing'], { agent: 's1' }]);
    assert.deepEqual(inbox.setSettings({ pinAdd: [{ agent: 's2' }] }).pins, [['topic', 'billing'], { agent: 's1' }, { agent: 's2' }]);
    assert.deepEqual(inbox.setSettings({ pinRemove: [{ agent: 's1' }] }).pins, [['topic', 'billing'], { agent: 's2' }]);
    // A tag pin stays a [key, value] pair, which is the shape an inbox stored before an agent could be pinned.
    assert.deepEqual(inbox.setSettings({ pinAdd: [['topic', 'search']] }).pins, [['topic', 'billing'], { agent: 's2' }, ['topic', 'search']]);
  });

  it('refuses a pin that names neither a tag key and value nor an agent', () => {
    const inbox = oneCardInbox();
    const long = 'x'.repeat(81);
    for (const pins of [[{ agent: '' }], [{ agent: 42 }], [{}], [null], [{ agent: ' ' }], [{ agent: long }], [{ agent: 's1' }, 'x'], ['agent']] as unknown as Pin[][]) {
      assert.throws(() => inbox.setSettings({ pins }), InboxError);
    }
    // An agent id is trimmed the way a tag side is.
    assert.deepEqual(inbox.setSettings({ pins: [{ agent: ' s1 ' }] }).pins, [{ agent: 's1' }]);
  });

  it('holds the limit across tag pins and agent pins together', () => {
    const inbox = oneCardInbox();
    const full = Array.from({ length: 20 }, (_, i): Pin => (i % 2 ? { agent: `s${i}` } : ['topic', `t${i}`]));
    inbox.setSettings({ pins: full });
    assert.equal(inbox.settings().pins?.length, 20);
    assert.throws(() => inbox.setSettings({ pinAdd: [{ agent: 'late' }] }), /at most 20/);
    // A pin already there stays once, so a device that pins what is already pinned spends no room.
    assert.equal(inbox.setSettings({ pinAdd: [{ agent: 's1' }] }).pins?.length, 20);
  });

  it('refuses a pin past the limit, rather than dropping it quietly', () => {
    const inbox = oneCardInbox();
    const full = Array.from({ length: 20 }, (_, i): [string, string] => ['topic', `t${i}`]);
    inbox.setSettings({ pins: full });
    assert.throws(() => inbox.setSettings({ pinAdd: [['topic', 'new']] }), /at most 20/);
  });

  it('takes only a known grouping, with any tag key', () => {
    const inbox = oneCardInbox();
    for (const groupBy of ['none', 'priority', 'agent', 'tag:repo']) assert.equal(inbox.setSettings({ groupBy }).groupBy, groupBy);
    assert.throws(() => inbox.setSettings({ groupBy: 'week' }), InboxError);
    assert.throws(() => inbox.setSettings({ groupBy: 'tag:' }), InboxError);
    assert.throws(() => inbox.setSettings({ groupBy: 42 as unknown as string }), InboxError);
  });

  it('takes pins as pairs of a tag key and its value, cut to the tag limits', () => {
    const inbox = oneCardInbox();
    const long = 'x'.repeat(200);
    assert.deepEqual(inbox.setSettings({ pins: [[' topic ', ' billing ']] }).pins, [['topic', 'billing']], 'each side is trimmed');
    for (const pins of ['billing', [['topic']], [['topic', 'billing', 'extra']], [['', 'billing']], [['topic', '']], [[long, 'billing']]] as unknown as [string, string][][]) {
      assert.throws(() => inbox.setSettings({ pins }), InboxError);
    }
    const many = Array.from({ length: 21 }, (_, i) => ['topic', `v${i}`] as [string, string]);
    assert.throws(() => inbox.setSettings({ pins: many }), InboxError);
  });
});
