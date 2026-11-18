// The owner's export of triage feedback, through `your-attention triage feedback` against a real inbox and the triage
// service with a judge that sends every card without a recommendation back.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { Client } from '../../src/client.ts';
import { runTriage } from '../../src/extensions/triage.ts';
import { CLI_ARGS, serveForTest, until, type CliServer } from './harness.ts';

let server: CliServer;
const stop = new AbortController();
before(async () => {
  server = await serveForTest('ya-triage-feedback-');
  void runTriage({
    url: server.url, token: server.read('extension-token'), log: () => {},
    judge: async (prompt) => (prompt.includes('"recommendation": "') ? '{"verdict":"pass"}' : '{"verdict":"return","reason":"Say what you recommend."}'),
  }, stop.signal);
});
after(async () => { stop.abort(); await server.close(); });

const cli = (...args: string[]) =>
  promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', ...CLI_ARGS, ...args], { env: server.env, encoding: 'utf8' }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);

describe('your-attention triage feedback', () => {
  it('prints one line of JSON per card triage pushed back on, with the feedback and how the card ended', async () => {
    const agent = new Client({ url: server.url, token: server.read('agent-token') });
    await agent.post({ id: 'a', agent: 's1', title: 'Ship today?' });
    await agent.post({ id: 'b', agent: 's1', title: 'Rename the flag?' });
    const closed = async (id: string) => (await agent.get(id)).state === 'closed' || undefined;
    await until(() => closed('a'));
    await until(() => closed('b'));
    await agent.triageFeedback('a', { verdict: 'disagree', comment: 'The recommendation was in the text.' });
    await agent.post({ id: 'a', agent: 's1', title: 'Ship today?', recommendation: 'Yes, tests pass.' });
    await until(async () => (await agent.get('a')).state === 'open' || undefined);

    const all = await cli('triage', 'feedback');
    assert.equal(all.code, 0, all.stderr);
    const lines = all.stdout.trim().split('\n').map((l) => JSON.parse(l) as { card: string; agent: string; outcome: string; pushback: { by: string; reason: string; feedback: { verdict: string } | null }[] });
    assert.deepEqual(lines.map((l) => [l.card, l.outcome]), [['a', 'passed'], ['b', 'returned']]);
    assert.deepEqual(lines[0]!.pushback.map((p) => [p.by, p.reason, p.feedback?.verdict]), [['triage', 'Say what you recommend.', 'disagree']]);
    assert.equal(lines[1]!.pushback[0]!.feedback, null);

    const disputed = await cli('triage', 'feedback', '--verdict', 'disagree');
    assert.deepEqual(disputed.stdout.trim().split('\n').map((l) => (JSON.parse(l) as { card: string }).card), ['a']);
    assert.notEqual((await cli('triage', 'feedback', '--verdict', 'sometimes')).code, 0);
  });
});
