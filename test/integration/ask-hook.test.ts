// The AskUserQuestion hooks: a card opens with the terminal dialog, and closes however the dialog ends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Card } from '../../src/core/types.ts';
import { ROOT, start, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

// The hook runs as its own process, as Claude Code runs it. The inbox is in this process, so the spawn must not block.
const hook = (mode: string, input: Record<string, unknown>): Promise<{ status: number | null }> => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-hook', mode], {
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken },
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  child.on('exit', (status) => resolve({ status }));
  child.stdin.end(JSON.stringify(input));
});
const ask = (session: string, question: string) => ({ session_id: session, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, header: 'Q', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } });
const card = async (session: string, title: string) => ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.agent === `claude:${session}` && c.title === title);

describe('the AskUserQuestion hooks', () => {
  it('close the card when the person cancels the dialog in the terminal', async () => {
    assert.equal((await hook('ask-pre', ask('s1', 'Cancel me?'))).status, 0);
    assert.equal((await card('s1', 'Cancel me?'))?.closed, undefined);
    assert.equal((await hook('ask-cancel', { session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'AskUserQuestion', is_interrupt: true })).status, 0);
    assert.equal((await card('s1', 'Cancel me?'))?.closed?.kind, 'resolved');
  });

  it('close a card still open when the next prompt arrives or the session ends', async () => {
    await hook('ask-pre', ask('s2', 'Left open?'));
    assert.equal((await hook('ask-cancel', { session_id: 's2', hook_event_name: 'UserPromptSubmit', prompt: 'never mind' })).status, 0);
    assert.equal((await card('s2', 'Left open?'))?.closed?.kind, 'resolved');
  });

  it('close the earlier card when a session asks again before it ended', async () => {
    await hook('ask-pre', ask('s3', 'First?'));
    await hook('ask-pre', ask('s3', 'Second?'));
    assert.equal((await card('s3', 'First?'))?.closed?.kind, 'resolved');
    assert.equal((await card('s3', 'Second?'))?.closed, undefined);
  });

  it('leave a card the person answered on the card', async () => {
    await hook('ask-pre', ask('s4', 'Answered here?'));
    const c = (await card('s4', 'Answered here?'))!;
    await h.owner('POST', `/v1/cards/${c.id}/answer`, { values: { q0: 'A' } });
    await hook('ask-cancel', { session_id: 's4', hook_event_name: 'PostToolUseFailure', tool_name: 'AskUserQuestion' });
    assert.equal((await card('s4', 'Answered here?'))?.closed, undefined);
  });
});
