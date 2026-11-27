import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandJudge, openRouterLogin, parseRuling, triagePrompt } from '../../src/extensions/triage.ts';
import type { Card } from '../../src/core/types.ts';

const card: Card = { id: 'c1', agent: 's1', kind: 'ask', title: 'Use SQLite?', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [] };

describe('triage', () => {
  it('reads a verdict from the judge, and passes anything it cannot read', () => {
    assert.deepEqual(parseRuling('Sure. {"verdict": "return", "reason": "No recommendation."}'), { verdict: 'return', reason: 'No recommendation.' });
    assert.equal(parseRuling('{"verdict":"pass"}').verdict, 'pass');
    assert.equal(parseRuling('I think it is fine').verdict, 'pass');
    assert.equal(parseRuling('{"verdict": "maybe"}').verdict, 'pass');
  });

  it('asks the judge about the four parts of a card and the earlier answers', () => {
    const p = triagePrompt(card, 'Be brief.', [{ title: 'Use Postgres?', answer: 'No, SQLite' }]);
    for (const part of ['goal', 'options the agent weighed', 'evidence', 'recommendation', 'Use Postgres?: No, SQLite', 'Be brief.']) assert.ok(p.includes(part), part);
  });

  it('sends the judge the card\'s tags, each key and value', () => {
    const p = triagePrompt({ ...card, tags: { repo: 'your-attention', topic: 'triage' } }, '', []);
    for (const part of ['"repo"', '"your-attention"', '"topic"', '"triage"']) assert.ok(p.includes(part), part);
  });

  it('sends "tags": {} for a card with no tags', () => {
    assert.ok(triagePrompt(card, '', []).includes('"tags": {}'));
  });

  it('runs a harness in print mode as the judge', async () => {
    const judge = commandJudge(process.platform === 'win32' ? 'more' : 'cat');
    assert.match(await judge('{"verdict":"pass"}'), /"verdict":"pass"/);
    await assert.rejects(commandJudge('exit 3')('x'), /exited with 3/);
  });

  it('signs in to OpenRouter with PKCE and keeps the key private', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-or-'));
    process.env['YOUR_ATTENTION_HOME'] = home;
    let sent: { code: string; code_verifier: string } | undefined;
    const fake = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ key: 'sk-or-example' }); }) as unknown as typeof fetch;
    const key = await openRouterLogin((u) => {
      const callback = new URL(decodeURIComponent(/callback_url=([^&]+)/.exec(u)![1]!));
      assert.match(u, /code_challenge_method=S256/);
      void fetch(`${callback}?code=abc123`);
    }, fake);
    assert.equal(key, 'sk-or-example');
    assert.equal(sent?.code, 'abc123');
    assert.ok((sent?.code_verifier.length ?? 0) >= 43);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'openrouter-key')).mode & 0o777, 0o600);
    delete process.env['YOUR_ATTENTION_HOME'];
    fs.rmSync(home, { recursive: true });
  });
});

describe('triage under load', () => {
  it('runs at most the limit of judge calls at once', async () => {
    const { limiter } = await import('../../src/extensions/triage.ts');
    const run = limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    })));
    assert.equal(peak, 2);
  });

  it('retries a busy judge with backoff, and gives up before the deadline', async () => {
    const { judgeWithRetry } = await import('../../src/extensions/triage.ts');
    let calls = 0;
    const flaky = async () => { calls++; if (calls < 3) throw new Error('judge answered 429'); return '{"verdict":"pass"}'; };
    const slept: number[] = [];
    assert.match(await judgeWithRetry(flaky, 'p', Date.now() + 60_000, async (ms) => { slept.push(ms); }), /pass/);
    assert.deepEqual(slept, [1000, 2000]);
    await assert.rejects(judgeWithRetry(async () => { throw new Error('judge answered 429'); }, 'p', Date.now() + 1500, async () => {}), /429/);
    await assert.rejects(judgeWithRetry(async () => { throw new Error('judge answered 400'); }, 'p', Date.now() + 60_000, async () => {}), /400/, 'only a busy judge is retried');
  });

  it('gives the judge the card\'s signal, and stops retrying once it aborts', async () => {
    const { judgeWithRetry } = await import('../../src/extensions/triage.ts');
    const stop = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const busy = async (_p: string, signal?: AbortSignal) => { seen.push(signal); throw new Error('judge answered 429'); };
    await assert.rejects(judgeWithRetry(busy, 'p', Date.now() + 60_000, async () => { stop.abort(); }, stop.signal), /aborted|429/);
    assert.equal(seen.length, 1, 'no retry after the abort');
    assert.equal(seen[0], stop.signal);
  });

  it('ends a chat judge\'s request when the card\'s signal aborts', async () => {
    const { chatJudge } = await import('../../src/extensions/triage.ts');
    const fetcher = ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('the request was aborted')), { once: true });
    })) as unknown as typeof fetch;
    const stop = new AbortController();
    const asked = chatJudge({ baseUrl: 'http://judge.test', apiKey: 'k', model: 'm', fetcher })('p', stop.signal);
    stop.abort();
    await assert.rejects(asked, /aborted/);
  });

  it('kills every process of a command judge on abort, not only its shell', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, async () => {
    const pidFile = path.join(os.tmpdir(), `judge-child-${process.pid}.pid`);
    const stop = new AbortController();
    const asked = commandJudge(`sleep 30 & echo $! > ${pidFile}; wait`)('p', stop.signal);
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    stop.abort();
    await assert.rejects(asked, /stopped/);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(child, 0), 'the command the shell started is gone too');
    fs.rmSync(pidFile, { force: true });
  });

  it('kills a command judge when the card\'s signal aborts', { skip: process.platform === 'win32' ? 'the test command is POSIX sleep' : false }, async () => {
    const stop = new AbortController();
    const started = Date.now();
    const asked = commandJudge('sleep 30')('p', stop.signal);
    setTimeout(() => stop.abort(), 100);
    await assert.rejects(asked, /stopped/);
    assert.ok(Date.now() - started < 5000);
  });
});

describe('triage prompts by card kind', () => {
  it('tells the judge that a card asking for a secret needs only a reason, and shows it an HTML card form', () => {
    const secret = triagePrompt({ ...card, secrets: ['DEMO_KEY'], text: 'To call the demo API.' }, '', []);
    assert.match(secret, /"secrets": \[\s*"DEMO_KEY"\s*\]/);
    assert.match(secret, /A card with `secrets` asks for those values.*pass it when the card says why/);
    const html = triagePrompt({ ...card, html: '<button>Ship it (recommended)</button>' }, '', []);
    assert.match(html, /Ship it \(recommended\)/);
  });

  it('carries `dialog` to the judge, and leaves it off a card the agent posted on its own', () => {
    assert.match(triagePrompt({ ...card, dialog: true }, '', []), /"dialog": true/);
    assert.doesNotMatch(triagePrompt(card, '', []), /"dialog"/);
  });

  it('judges a harness question on its own terms, without a separate recommendation', () => {
    const p = triagePrompt({ ...card, dialog: true }, '', []);
    // The dialog terms replace the general ones: a question that says what the agent needs, and distinct options.
    assert.match(p, /a question the harness also asks in the terminal/);
    assert.match(p, /It needs a question that says what the agent needs, and distinct options/);
    // Neither the evidence paragraph nor the recommendation belongs in a dialog the harness draws.
    assert.match(p, /Neither a separate evidence paragraph nor a recommendation/);
    // The rule that such a card always passes is gone: that is what let a weak question reach the person.
    assert.doesNotMatch(p, /blocks the agent always pass/);
  });
});
