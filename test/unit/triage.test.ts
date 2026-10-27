import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandJudge, openRouterLogin, parseRuling, triagePrompt } from '../../src/extensions/triage.ts';
import { serviceFile } from '../../src/node/service.ts';
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

describe('services', () => {
  it('writes a launchd agent on macOS and a systemd unit on Linux, both restarting on failure', () => {
    const mac = serviceFile('triage', ['triage', '--judge-cmd', 'claude -p'], 'darwin', '/opt/ya/bin/your-attention.js');
    assert.match(mac.path, /LaunchAgents\/dev\.your-attention\.triage\.plist$/);
    assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/);
    assert.match(mac.content, /<string>claude -p<\/string>/);
    const linux = serviceFile('serve', ['serve'], 'linux', '/opt/ya/bin/your-attention.js');
    assert.match(linux.path, /systemd\/user\/your-attention-serve\.service$/);
    assert.match(linux.content, /Restart=always/);
    assert.match(linux.content, /ExecStart=.* \/opt\/ya\/bin\/your-attention\.js serve/);
  });
});
