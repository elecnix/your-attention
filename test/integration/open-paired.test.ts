// On a machine that runs no inbox but paired with one, such as a cloud inbox, `open --link` and `login-url` sign a
// browser in to the paired inbox when the pairing is an owner's, and say how to get one when it is an agent's.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ROOT, until } from './harness.ts';

const CLI = ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts')];
const envFor = (home: string) => ({ ...process.env, HOME: home, USERPROFILE: home, YOUR_ATTENTION_HOME: path.join(home, '.your-attention'), YOUR_ATTENTION_URL: '', YOUR_ATTENTION_TOKEN: '' });

describe('your-attention open on a paired machine', () => {
  const inboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-paired-inbox-'));
  const inboxEnv = envFor(inboxHome);
  let serve: ReturnType<typeof spawn>;
  let url = '';
  let owner = '';
  let agent = '';

  before(async () => {
    serve = spawn(process.execPath, [...CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--no-mdns'], { env: inboxEnv, stdio: 'ignore' });
    url = (await until(() => (fs.existsSync(path.join(inboxEnv.YOUR_ATTENTION_HOME, 'server.json')) ? JSON.parse(fs.readFileSync(path.join(inboxEnv.YOUR_ATTENTION_HOME, 'server.json'), 'utf8')) as { url: string } : undefined))).url;
    owner = fs.readFileSync(path.join(inboxEnv.YOUR_ATTENTION_HOME, 'owner-token'), 'utf8').trim();
    agent = fs.readFileSync(path.join(inboxEnv.YOUR_ATTENTION_HOME, 'agent-token'), 'utf8').trim();
  });
  after(() => {
    serve.kill();
    fs.rmSync(inboxHome, { recursive: true, force: true });
  });

  /** A machine with no inbox of its own, paired with the inbox above with `token`, or not paired when it is undefined. */
  const machine = (pairings: { owner?: string; client?: string } = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-paired-'));
    const env = envFor(home);
    fs.mkdirSync(env.YOUR_ATTENTION_HOME, { recursive: true });
    if (pairings.owner) fs.writeFileSync(path.join(env.YOUR_ATTENTION_HOME, 'owner.json'), JSON.stringify({ url, token: pairings.owner }));
    if (pairings.client) fs.writeFileSync(path.join(env.YOUR_ATTENTION_HOME, 'client.json'), JSON.stringify({ url, token: pairings.client }));
    return { env, run: (...args: string[]) => spawnSync(process.execPath, [...CLI, ...args], { env, encoding: 'utf8' }), done: () => fs.rmSync(home, { recursive: true, force: true }) };
  };

  it('prints a one-time sign-in link to the inbox it paired with as owner, for open --link and login-url, beside an agent pairing', async () => {
    const m = machine({ owner, client: agent });
    try {
      for (const args of [['open', '--link'], ['login-url']]) {
        const run = m.run(...args);
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout.includes(owner), false);
        const link = /(http\S+#signin=(\S+))/.exec(run.stdout);
        assert.ok(link, run.stdout);
        assert.equal(link[1]!.startsWith(`${url}/`), true);
        const login = () => fetch(`${url}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: decodeURIComponent(link[2]!) }) });
        assert.equal((await login()).ok, true);
        assert.equal((await login()).ok, false);
      }
    } finally {
      m.done();
    }
  });

  it('still signs in with an owner pairing an older version saved in client.json', () => {
    const m = machine({ client: owner });
    try {
      const run = m.run('login-url');
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /#signin=/);
    } finally {
      m.done();
    }
  });

  it('says how to sign a browser in when the machine paired as an agent only', () => {
    const m = machine({ client: agent });
    try {
      const run = m.run('open', '--link');
      assert.notEqual(run.status, 0);
      assert.equal(run.stderr.includes(agent), false);
      assert.match(run.stderr, new RegExp(`paired with ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} as an agent`));
      assert.match(run.stderr, /your-attention pair \S+ --role owner/);
      assert.doesNotMatch(run.stderr, /No inbox runs on this machine/);
    } finally {
      m.done();
    }
  });

  it('says no inbox runs only when the machine runs none and paired with none', () => {
    const m = machine();
    try {
      const run = m.run('open', '--link');
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /No inbox runs on this machine/);
      assert.match(run.stderr, /your-attention pair <url> --role owner/);
    } finally {
      m.done();
    }
  });

  it('saves an owner pairing in owner.json and leaves the agent pairing in client.json', async () => {
    const m = machine({ client: agent });
    try {
      const pair = spawn(process.execPath, [...CLI, 'pair', url, '--role', 'owner', '--name', 'desk'], { env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      pair.stdout.on('data', (d) => { out += d; });
      const auth = { authorization: `Bearer ${owner}`, 'content-type': 'application/json' };
      const card = await until(async () => ((await (await fetch(`${url}/v1/state`, { headers: auth })).json()) as { cards: { id: string; title: string }[] }).cards.find((c) => c.id.startsWith('pair-') && c.title.includes('desk')));
      assert.equal((await fetch(`${url}/v1/cards/${card.id}/answer`, { method: 'POST', headers: auth, body: JSON.stringify({ values: { choice: 'approve' } }) })).ok, true);
      await new Promise((r) => pair.on('exit', r));
      assert.match(out, /owner\.json/);
      const home = m.env.YOUR_ATTENTION_HOME;
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'client.json'), 'utf8')).token, agent);
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'owner.json'), 'utf8')) as { url: string; token: string };
      assert.equal(saved.url, url);
      assert.notEqual(saved.token, agent);
      const run = m.run('login-url');
      assert.equal(run.status, 0, run.stderr);
    } finally {
      m.done();
    }
  });
});
