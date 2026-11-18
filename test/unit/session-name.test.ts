// The Claude Code session name, as the channel reads it again on each beat of its stream: a rename after the session
// connected shows, an unchanged transcript costs a stat, and a grown one costs only the bytes it gained.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { SessionName } from '../../src/integrations/claude/session-name.ts';

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** A projects folder holding one transcript, `sid-1.jsonl`, with these records. */
function transcript(lines: unknown[]): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-name-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '-Users-me-Source-app'));
  const file = path.join(root, '-Users-me-Source-app', 'sid-1.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
  return { root, file };
}

const append = (file: string, ...lines: unknown[]): void => fs.appendFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));

describe('the session name the channel reads again', () => {
  it('follows a rename the transcript gains after the first read', () => {
    const { root, file } = transcript([{ type: 'ai-title', aiTitle: 'Cross-platform agent card review tools' }]);
    const name = new SessionName('sid-1', root);
    assert.equal(name.read(), 'Cross-platform agent card review tools');
    append(file, { type: 'user', message: { content: 'go on' } }, { type: 'custom-title', customTitle: 'your-attention orchestrator' });
    assert.equal(name.read(), 'your-attention orchestrator');
    // A title Claude Code generates later never replaces the name the person gave.
    append(file, { type: 'ai-title', aiTitle: 'Something else' });
    assert.equal(name.read(), 'your-attention orchestrator');
  });

  it('reads nothing again from a transcript that did not change', () => {
    const { root } = transcript([{ type: 'ai-title', aiTitle: 'Fix login' }]);
    const name = new SessionName('sid-1', root);
    assert.equal(name.read(), 'Fix login');
    const read = name.bytesRead;
    assert.equal(name.read(), 'Fix login');
    assert.equal(name.bytesRead, read);
  });

  it('reads only what a large transcript gained since the last read', () => {
    const { root, file } = transcript([{ type: 'ai-title', aiTitle: 'Fix login' }]);
    // About 4 MB of conversation, the kind of size a long session reaches.
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(4000) } }) + '\n';
    fs.appendFileSync(file, filler.repeat(1000));
    const name = new SessionName('sid-1', root);
    assert.equal(name.read(), 'Fix login');
    const first = name.bytesRead;
    assert.ok(first >= fs.statSync(file).size, 'the first read covers the whole transcript');
    const record = JSON.stringify({ type: 'custom-title', customTitle: 'release prep' }) + '\n';
    fs.appendFileSync(file, record);
    assert.equal(name.read(), 'release prep');
    assert.equal(name.bytesRead - first, Buffer.byteLength(record));
  });

  it('waits for the rest of a record that is still being written', () => {
    const { root, file } = transcript([{ type: 'ai-title', aiTitle: 'Fix login' }]);
    const name = new SessionName('sid-1', root);
    assert.equal(name.read(), 'Fix login');
    const record = JSON.stringify({ type: 'custom-title', customTitle: 'release prep' }) + '\n';
    fs.appendFileSync(file, record.slice(0, 20));
    assert.equal(name.read(), 'Fix login');
    fs.appendFileSync(file, record.slice(20));
    assert.equal(name.read(), 'release prep');
  });

  it('reads the whole transcript again when it was replaced by a shorter one', () => {
    const { root, file } = transcript([{ type: 'ai-title', aiTitle: 'A long first title for this session' }]);
    const name = new SessionName('sid-1', root);
    assert.equal(name.read(), 'A long first title for this session');
    fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Short' }) + '\n');
    assert.equal(name.read(), 'Short');
  });

  it('finds a transcript that appears after the first read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-name-'));
    roots.push(root);
    const name = new SessionName('sid-1', root);
    assert.equal(name.read(), undefined);
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'dir', 'sid-1.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'late' }) + '\n');
    assert.equal(name.read(), 'late');
  });

  it('refuses a session id that could leave the projects folder', () => {
    const { root } = transcript([{ type: 'ai-title', aiTitle: 'Fix login' }]);
    assert.equal(new SessionName('../sid-1', root).read(), undefined);
  });
});
