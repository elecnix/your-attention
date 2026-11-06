// The inbox's owner settings: Group by and the pinned tag values live here, next to allowHtml, so every page and the
// terminal client share them. The owner changes them with PUT /v1/settings, and GET /v1/state returns them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InboxError } from '../../src/core/inbox.ts';
import { setup } from './fixture.ts';

describe('settings', () => {
  it('starts with allowHtml off and no grouping or pins', () => {
    assert.deepEqual(setup().settings(), { allowHtml: false });
  });

  it('round trips Group by and the pinned tag values', () => {
    const inbox = setup();
    const saved = inbox.setSettings({ groupBy: 'tag:repo', pins: [['topic', 'billing'], ['repo', 'acme/api']] });
    assert.equal(saved.groupBy, 'tag:repo');
    assert.deepEqual(saved.pins, [['topic', 'billing'], ['repo', 'acme/api']]);
    assert.deepEqual(inbox.settings(), saved);
  });

  it('keeps the other settings on a partial change', () => {
    const inbox = setup();
    inbox.setSettings({ allowHtml: true, groupBy: 'agent', pins: [['topic', 'billing']] });
    const next = inbox.setSettings({ pins: [] });
    assert.deepEqual(next, { allowHtml: true, groupBy: 'agent', pins: [] });
  });

  it('adds and removes one pin at a time, so a pin another device sets survives', () => {
    const inbox = setup();
    inbox.setSettings({ pins: [['topic', 'billing']] });
    // Two devices pin different values: each change names only its own.
    assert.deepEqual(inbox.setSettings({ pinAdd: [['topic', 'search']] }).pins, [['topic', 'billing'], ['topic', 'search']]);
    assert.deepEqual(inbox.setSettings({ pinAdd: [['repo', 'acme/api']] }).pins, [['topic', 'billing'], ['topic', 'search'], ['repo', 'acme/api']]);
    assert.deepEqual(inbox.setSettings({ pinRemove: [['topic', 'billing']] }).pins, [['topic', 'search'], ['repo', 'acme/api']]);
    assert.deepEqual(inbox.setSettings({ pinAdd: [['repo', 'acme/api']] }).pins, [['topic', 'search'], ['repo', 'acme/api']], 'a pin already there stays once');
  });

  it('takes only a known grouping, with any tag key', () => {
    const inbox = setup();
    for (const groupBy of ['none', 'priority', 'agent', 'tag:repo']) assert.equal(inbox.setSettings({ groupBy }).groupBy, groupBy);
    assert.throws(() => inbox.setSettings({ groupBy: 'week' }), InboxError);
    assert.throws(() => inbox.setSettings({ groupBy: 'tag:' }), InboxError);
    assert.throws(() => inbox.setSettings({ groupBy: 42 as unknown as string }), InboxError);
  });

  it('takes pins as pairs of a tag key and its value, cut to the tag limits', () => {
    const inbox = setup();
    const long = 'x'.repeat(200);
    assert.deepEqual(inbox.setSettings({ pins: [[' topic ', ' billing ']] }).pins, [['topic', 'billing']], 'each side is trimmed');
    for (const pins of ['billing', [['topic']], [['topic', 'billing', 'extra']], [['', 'billing']], [['topic', '']], [[long, 'billing']]] as unknown as [string, string][][]) {
      assert.throws(() => inbox.setSettings({ pins }), InboxError);
    }
    const many = Array.from({ length: 21 }, (_, i) => ['topic', `v${i}`] as [string, string]);
    assert.throws(() => inbox.setSettings({ pins: many }), InboxError);
  });
});
