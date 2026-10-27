// your-attention <command>. Run it with no command for the list.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { discover } from './adapters/mdns.ts';
import { Client, describeAnswer, loadConfig } from './client.ts';
import type { Option, Priority } from './core/types.ts';
import { homeDir, writePrivate } from './node/home.ts';
import { serve } from './node/server.ts';

const HELP = `your-attention: one inbox for the questions your coding agents ask you.

  serve [--port 4815] [--host 0.0.0.0] [--no-mdns]   run the inbox
  open                                                open the inbox page in a browser
  login-url                                           print the page address with its sign-in token
  discover [--seconds 3]                              list inboxes on the LAN
  pair <url> [--name NAME] [--role agent|owner]       pair this machine with an inbox
  post --agent ID --title TEXT [--text TEXT] [--option LABEL]... [--priority now|soon|later] [--wait]
                                                      post a card, and with --wait print the answer
  claude-channel                                      the MCP channel server for Claude Code
  claude-hook ask-pre|ask-post                        the AskUserQuestion hooks for Claude Code
  herdr-blocked                                       post a card for each herdr agent that is blocked

Files live in ${homeDir()} (set YOUR_ATTENTION_HOME to move them).`;

const [command, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function client(): Client {
  const config = loadConfig();
  if (!config) fail('No inbox found. Start one with `your-attention serve`, or pair with `your-attention pair <url>`.');
  return new Client(config);
}

function localServer(): { url: string; owner: string } {
  try {
    const { url } = JSON.parse(fs.readFileSync(path.join(homeDir(), 'server.json'), 'utf8')) as { url: string };
    return { url, owner: fs.readFileSync(path.join(homeDir(), 'owner-token'), 'utf8').trim() };
  } catch {
    fail('No inbox runs on this machine. Start one with `your-attention serve`.');
  }
}

switch (command) {
  case 'serve': {
    const { values } = parseArgs({ args: rest, options: { port: { type: 'string', default: '4815' }, host: { type: 'string', default: '0.0.0.0' }, 'no-mdns': { type: 'boolean', default: false } } });
    const server = await serve({ port: Number(values.port), host: String(values.host), mdns: !values['no-mdns'] });
    const stop = async (): Promise<void> => { await server.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    break;
  }
  case 'login-url': {
    const { url, owner } = localServer();
    console.log(`${url}/#token=${owner}`);
    break;
  }
  case 'open': {
    const { url, owner } = localServer();
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [`${url}/#token=${owner}`]);
    break;
  }
  case 'discover': {
    const { values } = parseArgs({ args: rest, options: { seconds: { type: 'string', default: '3' } } });
    const found = await discover(Number(values.seconds) * 1000);
    if (!found.length) console.log('No inbox found on this network.');
    for (const f of found) console.log(`${f.name}\thttp://${f.addresses.find((a) => !a.includes(':')) ?? f.host}:${f.port}\tid=${f.txt['id'] ?? '?'}`);
    break;
  }
  case 'pair': {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string', default: `${os.userInfo().username}@${os.hostname()}` }, role: { type: 'string', default: 'agent' } } });
    const url = (positionals[0] ?? fail('Usage: your-attention pair <url>')).replace(/\/$/, '');
    const res = await fetch(`${url}/v1/pair`, { method: 'POST', body: JSON.stringify({ name: values.name, role: values.role }) });
    const req = (await res.json()) as { id?: string; code?: string; error?: string };
    if (!res.ok || !req.id) fail(`Pairing refused: ${req.error ?? res.status}`);
    console.log(`Pairing code: ${req.code}. Approve the card with this code in your inbox.`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = (await (await fetch(`${url}/v1/pair/${req.id}`)).json()) as { status: string; token?: string };
      if (s.status === 'denied') fail('The pairing was denied.');
      if (s.token) {
        writePrivate(path.join(homeDir(), 'client.json'), JSON.stringify({ url, token: s.token }));
        console.log(`Paired. The token is in ${path.join(homeDir(), 'client.json')}.`);
        break;
      }
    }
    break;
  }
  case 'post': {
    const { values } = parseArgs({ args: rest, options: { agent: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, option: { type: 'string', multiple: true }, priority: { type: 'string', default: 'soon' }, wait: { type: 'boolean', default: false } } });
    if (!values.agent || !values.title) fail('Usage: your-attention post --agent ID --title TEXT');
    const c = client();
    const options: Option[] | undefined = values.option?.map((label, i) => ({ id: `o${i + 1}`, label }));
    const card = await c.post({ agent: values.agent, title: values.title, text: values.text, options, priority: values.priority as Priority, origin: { harness: 'cli', host: os.hostname(), cwd: process.cwd() } });
    console.log(card.id);
    if (!values.wait) break;
    const stop = new AbortController();
    await c.stream(values.agent, async (ev) => {
      if (ev.type !== 'answer' || ev.card.id !== card.id) return;
      console.log(describeAnswer(ev.card, ev.answer));
      await c.ack(card.id);
      stop.abort();
    }, stop.signal);
    break;
  }
  case 'claude-channel':
    await import('./integrations/claude/channel.ts');
    break;
  case 'claude-hook':
    await (await import('./integrations/claude/ask-hook.ts')).main(rest[0] ?? '');
    break;
  case 'herdr-blocked':
    await (await import('./integrations/herdr/blocked.ts')).main();
    break;
  default:
    console.log(HELP);
    if (command && command !== 'help' && command !== '--help') process.exit(1);
}
