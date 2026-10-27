import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SqliteStorage } from '../../src/adapters/sqlite.ts';
import { describeAnswer } from '../../src/client.ts';
import type { Answer, Card } from '../../src/core/types.ts';
import { terminalOutcome } from '../../src/integrations/claude/ask-hook.ts';
import { claudeSessionName } from '../../src/integrations/claude/session-name.ts';
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

describe('FileBlobs', () => {
  it('keeps bytes and type per key, with a colon in the key', async () => {
    const { FileBlobs } = await import('../../src/adapters/files.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-blobs-'));
    const blobs = new FileBlobs(dir);
    await blobs.put('claude:s1.0.ab', new Uint8Array([1, 2, 3]), 'application/pdf');
    const got = await blobs.get('claude:s1.0.ab');
    assert.deepEqual([...(got?.bytes ?? [])], [1, 2, 3]);
    assert.equal(got?.type, 'application/pdf');
    await blobs.delete('claude:s1.0.ab');
    assert.equal(await blobs.get('claude:s1.0.ab'), undefined);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('card tools', () => {
  it('reports an argument the tool does not take', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const ctx = { inbox: {} as never, secrets: {} as never, agent: 's1', origin: undefined, arrival: 'as a test' };
    await assert.rejects(runTool(ctx, 'card_guidance', { text: 'x' }), /card_guidance does not take text\. It takes propose/);
  });
});

describe('the Claude Code session name', () => {
  const transcript = (lines: unknown[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-cc-'));
    fs.mkdirSync(path.join(root, '-Users-me-Source-app'));
    fs.writeFileSync(path.join(root, '-Users-me-Source-app', 'sid-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return root;
  };

  it('is the latest title Claude Code generated for the session', () => {
    const root = transcript([{ type: 'user', message: { content: 'hi' } }, { type: 'ai-title', aiTitle: 'Fix login' }, { type: 'ai-title', aiTitle: 'Fix login redirect loop' }]);
    assert.equal(claudeSessionName('sid-1', root), 'Fix login redirect loop');
  });

  it('is the name the person gave it, ahead of any generated title', () => {
    const root = transcript([{ type: 'custom-title', customTitle: 'release prep' }, { type: 'ai-title', aiTitle: 'Bump versions' }]);
    assert.equal(claudeSessionName('sid-1', root), 'release prep');
  });

  it('is unknown when the session has no transcript or no title yet', () => {
    const root = transcript([{ type: 'user', message: { content: 'hi' } }]);
    assert.equal(claudeSessionName('sid-1', root), undefined);
    assert.equal(claudeSessionName('sid-2', root), undefined);
    assert.equal(claudeSessionName('../sid-1', root), undefined);
  });
});
