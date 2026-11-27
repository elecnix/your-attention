// A one-time code end to end on a real `your-attention serve`: the owner enrolls the RFC 6238 test key through the CLI,
// a session posts an otp card with card_post, the owner approves it, the session redeems the ticket with card_otp, and
// a command gets the code in its environment. Then the digits are searched for in everything the inbox printed, every
// file under its home, the CLI's output, the agent stream, the owner's state, and what the model read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, describeAnswer } from '../../src/client.ts';
import { base32Encode, totp, verifyTotp, type OtpApproval } from '../../src/core/otp.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { runTool } from '../../src/integrations/run-tool.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { filesHolding } from '../files-holding.ts';
import { runCli, runCliWithInput, serveForTest, until, type CliServer } from './harness.ts';

// The RFC 6238 test key for SHA-1, not anyone's authenticator key.
const KEY = new TextEncoder().encode('12345678901234567890');
const KEY_TEXT = base32Encode(KEY);
const SESSION = 'otp-it-session';
const output: string[] = [];
let s: CliServer;

before(async () => { s = await serveForTest('ya-otp-', undefined, { output }); });
after(async () => { await s.close(); });

/** Run the CLI in this inbox's home, with lines on its standard input, as a pipe answers the hidden questions. */
const cliWithInput = (input: string, ...args: string[]) => runCliWithInput(s.env, input, ...args);

describe('a one-time code on your own inbox', () => {
  it('enrolls a key from a pipe, gives an approved session a fresh code in its commands, and the digits appear nowhere else', async () => {
    const cliOut: string[] = [];
    // A wrong code is refused, and nothing is stored.
    const now = await totp(KEY, Date.now());
    const refused = await cliWithInput(`${KEY_TEXT}\n${now === '000000' ? '000001' : '000000'}\n`, 'otp', 'enroll', 'npm', '--allow', SESSION);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /does not match the key/);
    const enrolled = await cliWithInput(`${KEY_TEXT}\n${await totp(KEY, Date.now())}\n`, 'otp', 'enroll', 'npm', '--allow', SESSION);
    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert.match(enrolled.stdout, /Enrolled npm\. The inbox checked your code against it\. Sessions that may ask for it: otp-it-session\./);
    cliOut.push(refused.stdout, refused.stderr, enrolled.stdout, enrolled.stderr);
    const keyFile = path.join(s.env['YOUR_ATTENTION_HOME']!, 'otp-keys.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);

    const client = new Client({ url: s.url, token: s.read('agent-token') });
    const events: AgentEvent[] = [];
    const ctl = new AbortController();
    const ended = client.stream(SESSION, (e) => { events.push(e); }, ctl.signal);
    try {
      const secrets = new SecretRequests();
      const ctx = { inbox: client, secrets, agent: SESSION, origin: async () => undefined, arrival: 'later' };
      const body = `root = Card([npm])\nnpm = widget otp ${JSON.stringify({ name: 'NPM_OTP', key: 'npm', purpose: 'npm stage publish your-attention@1.4.0' })}`;
      const posted = await runTool(ctx, 'card_post', { id: 'otp-card', title: 'Publish 1.4.0 to npm?', body });
      assert.match(posted, /Posted card otp-card/);
      // A session the key does not list is refused, with the command that adds it.
      await assert.rejects(runTool({ ...ctx, agent: 'stray' }, 'card_post', { id: 'stray-card', title: 'Publish?', body }), /`your-attention otp allow npm stray`/);

      const owner = s.read('owner-token');
      const res = await s.call(owner, 'POST', '/v1/cards/otp-card/answer', { values: { NPM_OTP: 'approve' }, version: 1 });
      assert.equal(res.status, 200, await res.clone().text());
      const ev = await until(() => events.find((e): e is Extract<AgentEvent, { type: 'answer' }> => e.type === 'answer' && e.card.id === 'otp-card'));
      const said = describeAnswer(ev.card, ev.answer);
      const ticket = (ev.answer.values['NPM_OTP'] as OtpApproval).ticket;
      const redeemed = await runTool(ctx, 'card_otp', { ticket });
      const code = secrets.env(SESSION)['NPM_OTP']!;
      assert.equal(await verifyTotp(KEY, code, Date.now()), true, 'the session holds a code that verifies now');
      // A command gets it in its environment, as npm would read --otp "$NPM_OTP".
      const cmd = spawnSync(process.execPath, ['-e', 'if (/^\\d{6}$/.test(process.env.NPM_OTP ?? "")) console.log("got a code of six digits")'], { env: { ...process.env, ...secrets.env(SESSION) }, encoding: 'utf8' });
      assert.equal(cmd.stdout.trim(), 'got a code of six digits');
      // The ticket gives one code.
      await assert.rejects(runTool(ctx, 'card_otp', { ticket }), /was used at .* UTC: a ticket gives one code/);

      const list = await runCli(s.env, 'otp', 'list');
      assert.match(list.stdout, /Keys kept by your own inbox on.*otp-keys\.json, which only its user reads:\n  npm: enrolled .* UTC, last code issued .* UTC\. Sessions that may ask for it: otp-it-session\./);
      cliOut.push(list.stdout, list.stderr);
      const state = await (await s.call(owner, 'GET', '/v1/state')).text();
      const asAgent = await (await s.call(s.read('agent-token'), 'GET', '/v1/cards/otp-card')).text();
      const places: Record<string, string> = {
        'what serve printed': output.join(''),
        'what the CLI printed': cliOut.join('\n'),
        'the agent stream': JSON.stringify(events),
        'the answer text for the model': said,
        'the card_otp result': redeemed,
        'the owner state': state,
        'the card as the agent reads it': asAgent,
      };
      for (const [where, text] of Object.entries(places)) assert.ok(!text.includes(code), `the code ${'*'.repeat(code.length)} appears in ${where}`);
      assert.deepEqual(filesHolding(s.home, code), [], 'no file under the home holds the code');
      // The key is in its own file and nowhere else: not in the database, nor in what anything printed.
      assert.deepEqual(filesHolding(s.home, KEY_TEXT), [keyFile]);
      for (const [where, text] of Object.entries(places)) assert.ok(!text.includes(KEY_TEXT), `the key appears in ${where}`);
    } finally {
      ctl.abort();
      await ended.catch(() => {});
    }
  });
});
