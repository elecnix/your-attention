// The Stop hook: a session that opts in is asked for a card when it stops with none open.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { callAt, ROOT, start, type Harness } from './harness.ts';

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

const post = (session: string) => callAt(h.server.url, h.agentToken, 'POST', '/v1/cards', { agent: `claude:${session}`, title: 'Open question' });

// The prompt hook runs `claude-hook ask-cancel` on UserPromptSubmit, which is where the count of asks resets.
const promptHook = (session: string, prompt: string): Promise<{ status: number | null }> => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-hook', 'ask-cancel'], {
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('exit', (status) => resolve({ status }));
  child.stdin.end(JSON.stringify({ session_id: session, prompt }));
});

describe('the Stop hook', () => {
  it('asks a session with no open card to post one, and blocks the stop', async () => {
    const r = await hook({ session_id: 'stop-1', stop_hook_active: false }, { YOUR_ATTENTION_REQUIRE_CARD: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /card_post/);
  });

  it('leaves a session with an open card alone', async () => {
    await post('stop-2');
    const r = await hook({ session_id: 'stop-2', stop_hook_active: false }, { YOUR_ATTENTION_REQUIRE_CARD: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
  });

  it('does nothing on the stop that its own request caused', async () => {
    const r = await hook({ session_id: 'stop-3', stop_hook_active: true }, { YOUR_ATTENTION_REQUIRE_CARD: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
  });

  it('asks three times at most, then leaves the session alone', async () => {
    const ask = () => hook({ session_id: 'stop-5', stop_hook_active: false }, { YOUR_ATTENTION_REQUIRE_CARD: '1' });
    assert.equal((await ask()).status, 2);
    assert.equal((await ask()).status, 2);
    assert.equal((await ask()).status, 2);
    const capped = await ask();
    assert.equal(capped.status, 0, 'the fourth stop says nothing');
    assert.equal(capped.stderr.trim(), '');
    // A prompt the person types starts a turn: the next stop asks again.
    await promptHook('stop-5', 'still there?');
    const afterPrompt = await ask();
    assert.equal(afterPrompt.status, 2);
    assert.match(afterPrompt.stderr, /card_post/);
  });

  it('resets the count when a card of its own is open', async () => {
    const ask = () => hook({ session_id: 'stop-6', stop_hook_active: false }, { YOUR_ATTENTION_REQUIRE_CARD: '1' });
    await ask();
    await ask();
    await ask();
    assert.equal((await ask()).status, 0, 'capped');
    await post('stop-6');
    assert.equal((await ask()).status, 0, 'a card of its own says nothing');
  });

  it('does nothing unless the person opted in', async () => {
    const r = await hook({ session_id: 'stop-4' });
    assert.equal(r.status, 0);
  });
});
