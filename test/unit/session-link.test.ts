import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSessionLink } from '../../src/core/session-link.ts';
import { focusSessionLink } from '../../src/integrations/herdr/focus.ts';

describe('session links', () => {
  it('reads a herdr link with or without the session fingerprint', () => {
    assert.deepEqual(parseSessionLink('https://herdr.invalid/v1/tab/w19:tF'), { kind: 'tab', id: 'w19:tF' });
    assert.deepEqual(parseSessionLink(`https://herdr.invalid/v1/${'a'.repeat(64)}/pane/w3:p1`), { kind: 'pane', id: 'w3:p1' });
    assert.deepEqual(parseSessionLink('https://herdr.invalid/v1/agent/cx-1'), { kind: 'agent', id: 'cx-1' });
    assert.deepEqual(parseSessionLink('https://herdr.invalid/v1/workspace/w3'), { kind: 'workspace', id: 'w3' });
  });

  it('refuses any other address, kind or id', () => {
    for (const href of ['https://example.com/v1/tab/w1:t1', 'https://herdr.invalid/v1/shell/w1', 'https://herdr.invalid/v1/tab/--help',
      'https://herdr.invalid/v1/tab/w1;rm', 'http://herdr.invalid/v1/tab/w1:t1', 'https://herdr.invalid/v1/tab/']) {
      assert.equal(parseSessionLink(href), undefined, href);
    }
  });

  it('focuses each kind with the herdr command for it', async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => { calls.push(args); return '{}'; };
    await focusSessionLink('https://herdr.invalid/v1/tab/w1:t2', herdr);
    await focusSessionLink('https://herdr.invalid/v1/workspace/w1', herdr);
    await focusSessionLink('https://herdr.invalid/v1/agent/w1:p3', herdr);
    assert.deepEqual(calls, [['tab', 'focus', 'w1:t2'], ['workspace', 'focus', 'w1'], ['agent', 'focus', 'w1:p3']]);
  });

  it('focuses a pane without an agent through its tab', async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === 'agent') throw new Error('not an agent');
      return JSON.stringify({ result: { pane: { tab_id: 'w1:t4', pane_id: 'w1:p9' } } });
    };
    await focusSessionLink('https://herdr.invalid/v1/pane/w1:p9', herdr);
    assert.deepEqual(calls, [['agent', 'focus', 'w1:p9'], ['pane', 'get', 'w1:p9'], ['tab', 'focus', 'w1:t4']]);
  });

  it('rejects an address that is not a session link', async () => {
    await assert.rejects(focusSessionLink('https://example.com/', async () => ''), /not a session link/);
  });
});
