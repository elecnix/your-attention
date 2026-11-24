// The AskUserQuestion hooks: a card opens with the terminal dialog, and closes however the dialog ends. A weak
// question is denied before the dialog opens, so the agent revises it instead of the person seeing it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Card } from '../../src/core/types.ts';
import { ROOT, start, until, type Harness } from './harness.ts';

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

// The hook runs as its own process, as Claude Code runs it. The inbox is in this process, so the spawn must not block.
const hook = (mode: string, input: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ status: number | null; out: string }> => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), 'claude-hook', mode], {
    env: { ...process.env, YOUR_ATTENTION_HOME: h.home, YOUR_ATTENTION_URL: h.server.url, YOUR_ATTENTION_TOKEN: h.agentToken, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  // `close` follows the exit and the closed stdio streams, so the last `data` chunk of the deny is in `out`.
  child.on('close', (status) => resolve({ status, out }));
  child.stdin.end(JSON.stringify(input));
});

/** A card.created extension that holds its stream open, so the next question is screened rather than skipped. Its
 * `verdict` sends the answer for the card the hook posts, while the hook is still waiting for it. Each test connects
 * under its own name, so a call another test left pending is not resent to this one. */
async function triage(name: string): Promise<{ verdict(verdict: 'pass' | 'return' | 'hold', reason: string): Promise<void>; close(): void }> {
  const token = fs.readFileSync(path.join(h.home, 'extension-token'), 'utf8').trim();
  const ctl = new AbortController();
  const res = await fetch(`${h.server.url}/v1/extensions/stream?name=${name}&hooks=card.created&policy=fail-open&timeoutMs=120000&screen=new`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async (): Promise<{ request: string; card: Card }> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the extension stream ended');
      buf += dec.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(end + 2);
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as { type: string; hook?: string; id?: string; card?: Card };
        if (ev.type === 'hook' && ev.hook === 'card.created') return { request: ev.id!, card: ev.card! };
      }
    }
  };
  return {
    async verdict(v, reason) {
      const ev = await next();
      const r = await fetch(`${h.server.url}/v1/hooks/${ev.request}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ verdict: v, reason }) });
      assert.equal(r.status, 200);
    },
    close: () => ctl.abort(),
  };
}

const pending = (sid: string): string | undefined => {
  try { return fs.readFileSync(path.join(h.home, 'claude', `${sid}.pending`), 'utf8').trim(); } catch { return undefined; }
};
const deny = (out: string): { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } | undefined =>
  (JSON.parse(out) as { hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;

/** Ask a question while an extension holds the stream, send one verdict, and give the hook's result. The extension
 * closes once the hook has finished, so a pass or a deny both end in the same place. */
async function screened(sid: string, question: string, verdict: 'pass' | 'return' | 'hold', reason: string): Promise<{ status: number | null; out: string }> {
  const t = await triage(`triage-${sid}`);
  try {
    const running = hook('ask-pre', ask(sid, question), { YOUR_ATTENTION_ASK_WAIT_MS: '5000' });
    await t.verdict(verdict, reason);
    return await running;
  } finally { t.close(); }
}
const ask = (session: string, question: string) => ({ session_id: session, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, header: 'Q', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } });
const card = async (session: string, title: string) => ((await h.stored()) as { cards: Card[] }).cards.find((c) => c.agent === `claude:${session}` && c.questions?.[0]?.question === title);

describe('the AskUserQuestion hooks', () => {
  it('close the card when the person cancels the dialog in the terminal', async () => {
    assert.equal((await hook('ask-pre', ask('s1', 'Cancel me?'))).status, 0);
    assert.equal((await card('s1', 'Cancel me?'))?.closed, undefined);
    // The card says its questions are open in the terminal too, so an answer on the card closes that dialog.
    assert.equal((await card('s1', 'Cancel me?'))?.dialog, true);
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

  it('title the card with the questions\' short labels, so the question text shows once, in its section', async () => {
    const two = { session_id: 's5', tool_name: 'AskUserQuestion', tool_input: { questions: [
      { question: 'Where should the Mac setting go?', header: 'Mac dotfiles', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
      { question: 'Commit the legacy repo?', header: 'Legacy commit', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    ] } };
    await hook('ask-pre', two);
    assert.equal((await card('s5', 'Where should the Mac setting go?'))?.title, 'Mac dotfiles · Legacy commit');
    const bare = { session_id: 's6', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'No label?', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } };
    await hook('ask-pre', bare);
    assert.equal((await card('s6', 'No label?'))?.title, 'A question from the agent');
  });

  it('leave a card the person answered on the card', async () => {
    await hook('ask-pre', ask('s4', 'Answered here?'));
    const c = (await card('s4', 'Answered here?'))!;
    await h.owner('POST', `/v1/cards/${c.id}/answer`, { values: { q0: 'A' } });
    await hook('ask-cancel', { session_id: 's4', hook_event_name: 'PostToolUseFailure', tool_name: 'AskUserQuestion' });
    assert.equal((await card('s4', 'Answered here?'))?.closed, undefined);
  });
});

describe('a question under triage', () => {
  it('is denied with its reason before the dialog opens when triage returns it, and its pending file goes', async () => {
    const r = await screened('s7', 'Weak question?', 'return', 'State the options you weighed, and recommend one.');
    assert.equal(r.status, 0);
    assert.equal(deny(r.out)?.hookEventName, 'PreToolUse');
    assert.equal(deny(r.out)?.permissionDecision, 'deny');
    assert.match(deny(r.out)!.permissionDecisionReason, /State the options you weighed, and recommend one\./);
    assert.ok(pending('s7') === undefined, 'a deny fires PermissionDenied, so its ask-cancel must find no pending file');
    assert.equal((await card('s7', 'Weak question?'))?.closed?.kind, 'returned');
  });

  it('is denied when triage holds it, so the dialog never opens', async () => {
    const r = await screened('s8', 'Held question?', 'hold', 'Hold it until the goal is stated.');
    assert.equal(deny(r.out)?.permissionDecision, 'deny');
    assert.match(deny(r.out)!.permissionDecisionReason, /Hold it until the goal is stated\./);
    assert.equal(pending('s8'), undefined);
    // The hook closes the held card, because its dialog will not open. A held card would keep the herdr sidecar off
    // the pane and hide a later block there.
    assert.equal((await card('s8', 'Held question?'))?.closed?.kind, 'resolved');
  });

  it('leaves a card held when the hold arrives after the wait, since its dialog is already open', async () => {
    const t = await triage('triage-s12');
    try {
      const r = await hook('ask-pre', ask('s12', 'Late hold?'), { YOUR_ATTENTION_ASK_WAIT_MS: '400' });
      assert.equal(r.status, 0);
      assert.equal(r.out, '', 'the dialog opened before the hold arrived');
      await t.verdict('hold', 'Too late.');
      await until(async () => (await card('s12', 'Late hold?'))?.triage?.state === 'held' || undefined);
      assert.equal((await card('s12', 'Late hold?'))?.closed, undefined, 'a late hold leaves the card held for the owner');
      assert.ok(pending('s12'), 'the pending file stays, so ask-post or ask-cancel closes the card the dialog opened');
    } finally { t.close(); }
  });

  it('keeps the returned close when Claude Code fires PermissionDenied after the deny', async () => {
    const r = await screened('s11', 'Returned then denied?', 'return', 'Too vague.');
    assert.equal(deny(r.out)?.permissionDecision, 'deny');
    // Claude Code fires PermissionDenied for the denied call, which hooks.json maps to ask-cancel.
    assert.equal((await hook('ask-cancel', { session_id: 's11', hook_event_name: 'PermissionDenied', tool_name: 'AskUserQuestion' })).status, 0);
    assert.equal((await card('s11', 'Returned then denied?'))?.closed?.kind, 'returned', 'ask-cancel must not overwrite the return');
  });

  it('lets the dialog open when triage passes the question', async () => {
    const r = await screened('s10', 'Good question?', 'pass', 'Fine.');
    assert.equal(r.status, 0);
    assert.equal(r.out, '', 'a pass prints no decision, so the dialog opens');
    assert.ok(pending('s10'), 'the pending file stays for ask-post or ask-cancel');
  });

  it('lets the dialog open when triage does not answer in time, and keeps the pending file', async () => {
    const t = await triage('triage-s9');
    try {
      const started = Date.now();
      const r = await hook('ask-pre', ask('s9', 'Slow triage?'), { YOUR_ATTENTION_ASK_WAIT_MS: '400' });
      assert.equal(r.status, 0);
      assert.equal(r.out, '', 'a slow triage must never deny a good question');
      assert.ok(Date.now() - started < 5000, 'the wait is bounded');
      assert.ok(pending('s9'), 'the pending file stays, so the dialog the hook lets open has a card to close');
      assert.equal((await card('s9', 'Slow triage?'))?.triage?.state, 'pending');
    } finally { t.close(); }
  });
});

