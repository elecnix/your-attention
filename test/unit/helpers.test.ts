import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SqliteStorage } from '../../src/adapters/sqlite.ts';
import { describeAnswer } from '../../src/client.ts';
import type { Answer, Card } from '../../src/core/types.ts';
import { terminalOutcome } from '../../src/integrations/claude/ask-hook.ts';
import { trimScreen } from '../../src/integrations/herdr/blocked.ts';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1', agent: 's1', kind: 'ask', title: 'q', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [], ...over,
});
const answer = (over: Partial<Answer> = {}): Answer => ({
  card: 'c1', version: 1, values: {}, comment: '', delivery: 'default', savedAt: 1, deliveredAt: null, readAt: null, forcedAt: null, previous: [], ...over,
});

describe('describeAnswer', () => {
  it('names the options the person picked', () => {
    const c = card({ options: [{ id: 'o1', label: 'Ship it' }, { id: 'o2', label: 'Wait' }] });
    assert.equal(describeAnswer(c, answer({ values: { choice: 'o1' }, comment: 'today' })), 'choice: Ship it\nComment: today');
  });

  it('pairs each AskUserQuestion with its picks', () => {
    const c = card({ questions: [{ question: 'Which port?' }, { question: 'Which host?' }] });
    assert.equal(describeAnswer(c, answer({ values: { q0: ['4815'] } })), 'Which port? 4815\nWhich host? (no option picked)');
  });

  it('says so when the answer is empty', () => {
    assert.match(describeAnswer(card(), answer()), /empty answer/);
  });
});

describe('terminalOutcome', () => {
  it('reads the answers Claude Code reports', () => {
    assert.equal(terminalOutcome({ answers: { 'Which port?': '4815' } }), 'Which port? 4815');
    assert.equal(terminalOutcome(undefined), 'Answered in the terminal.');
  });
});

describe('trimScreen', () => {
  it('drops blank lines and shortens full-width rules', () => {
    const out = trimScreen(`top\n\n${'─'.repeat(200)}\nDebug mode enabled\n  Allow this?  \n`);
    assert.equal(out, `top\n${'─'.repeat(40)}\n  Allow this?`);
  });
});

describe('SqliteStorage', () => {
  it('stores documents and finds text with FTS5, safe from query syntax', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-'));
    const s = new SqliteStorage(path.join(dir, 'x.sqlite'));
    s.put('cards', 'a', { n: 1 });
    s.put('cards', 'a', { n: 2 });
    assert.deepEqual(s.get('cards', 'a'), { n: 2 });
    assert.equal(s.list('cards').length, 1);
    s.index('a', 'Durable Objects hibernate when idle');
    s.index('a', 'SQLite on the laptop');
    assert.equal(s.search('lapt', 5)[0]?.card, 'a');
    assert.equal(s.search('hibernate', 5).length, 0, 'indexing again replaces the text');
    assert.deepEqual(s.search('") OR (', 5), []);
    s.delete('cards', 'a');
    assert.equal(s.get('cards', 'a'), undefined);
    s.close();
    fs.rmSync(dir, { recursive: true });
  });
});
