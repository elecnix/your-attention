// The Stop hook: it records when a turn ended, and never blocks the stop. The channel asks for a card later.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ROOT, start, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

// The hook runs as its own process, as Claude Code runs it. The inbox is in this process, so the spawn must not block.
const hook = (input: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-hook', 'turn-end'], {
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken, ...env },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (status) => resolve({ status, stderr }));
  child.stdin.end(JSON.stringify(input));
});

const stretch = (session: string): unknown => {
  try { return JSON.parse(fs.readFileSync(path.join(h.home, 'claude', `${session}.card-ask`), 'utf8')); } catch { return undefined; }
};

// The prompt hook runs `claude-hook ask-cancel` on UserPromptSubmit and on SessionEnd, which is where a stretch ends.
const promptHook = (input: Record<string, unknown>): Promise<{ status: number | null }> => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-hook', 'ask-cancel'], {
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('exit', (status) => resolve({ status }));
  child.stdin.end(JSON.stringify(input));
});

describe('the Stop hook', () => {
  it('never blocks the stop, even for a session the rule asks for a card', async () => {
    const r = await hook({ session_id: 'stop-1', stop_hook_active: false }, { YOUR_ATTENTION_REQUIRE_CARD: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '', 'no request reaches the model from the hook');
  });

  it('starts a stretch of inactivity, which the channel times its asks from', async () => {
    const before = Date.now();
    await hook({ session_id: 'stop-2' });
    const s = stretch('stop-2') as { since: number; asks: number };
    assert.equal(s.asks, 0);
    assert.ok(s.since >= before && s.since <= Date.now(), 'the stretch starts when the turn ended');
    // Another turn that no ask started, then its stop: the stretch starts again from that stop.
    await new Promise((r) => setTimeout(r, 20));
    await hook({ session_id: 'stop-2' });
    assert.ok((stretch('stop-2') as { since: number }).since > s.since);
  });

  it('keeps the stretch after the turn an ask started, so the next ask lands at its minute', async () => {
    fs.mkdirSync(path.join(h.home, 'claude'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'claude', 'stop-3.card-ask'), JSON.stringify({ since: 1000, asks: 1, ours: true }));
    await hook({ session_id: 'stop-3' });
    assert.deepEqual(stretch('stop-3'), { since: 1000, asks: 1 });
  });

  it('ends the stretch when the person types a prompt, and when the session ends', async () => {
    await hook({ session_id: 'stop-4' });
    assert.ok(stretch('stop-4'));
    await promptHook({ session_id: 'stop-4', hook_event_name: 'UserPromptSubmit', prompt: 'still there?' });
    assert.equal(stretch('stop-4'), undefined);
    await hook({ session_id: 'stop-4' });
    await promptHook({ session_id: 'stop-4', hook_event_name: 'SessionEnd', reason: 'exit' });
    assert.equal(stretch('stop-4'), undefined, 'a resumed session starts with no stretch long over');
  });
});
