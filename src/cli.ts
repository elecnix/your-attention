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
  triage [--judge-cmd "claude -p" | --judge-url URL --judge-model M --judge-key-env VAR]
                                                      check each card before you see it (OpenRouter by default)
  triage login                                        sign in to OpenRouter for the default judge
  service serve|triage [--write]                      print or write a launchd or systemd unit
  bridge [--upstream URL] [--port 4815] [--mdns]      offer a remote inbox on this machine
  offer ssh <host> [--remote-port 4815]               offer this inbox on another machine over SSH
  relay [--port 4900] [--key-env VAR]                 run a relay that inboxes dial out to
  serve --relay URL [--relay-key-env VAR]             also offer this inbox through a relay

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
    const { values } = parseArgs({ args: rest, options: { port: { type: 'string', default: '4815' }, host: { type: 'string', default: '0.0.0.0' }, 'no-mdns': { type: 'boolean', default: false }, relay: { type: 'string' }, 'relay-key-env': { type: 'string', default: 'YOUR_ATTENTION_RELAY_KEY' } } });
    const relayKey = values.relay ? process.env[String(values['relay-key-env'])] ?? fail(`--relay needs the relay key in $${values['relay-key-env']}`) : '';
    const server = await serve({ port: Number(values.port), host: String(values.host), mdns: !values['no-mdns'], relay: values.relay ? { url: values.relay, key: relayKey } : undefined });
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
        const info = (await (await fetch(`${url}/v1/info`)).json()) as { id?: string };
        writePrivate(path.join(homeDir(), 'client.json'), JSON.stringify({ url, token: s.token, id: info.id }));
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
  case 'triage': {
    const triage = await import('./extensions/triage.ts');
    if (rest[0] === 'login') {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      await triage.openRouterLogin((u) => { console.log(`Opening ${u}`); execFile(opener, [u]); });
      console.log(`Signed in. The key is in ${triage.OPENROUTER_KEY_FILE()}.`);
      break;
    }
    const { values } = parseArgs({ args: rest, options: { 'judge-cmd': { type: 'string' }, 'judge-url': { type: 'string' }, 'judge-model': { type: 'string' }, 'judge-key-env': { type: 'string' }, name: { type: 'string', default: 'triage' } } });
    const { loadExtensionConfig } = await import('./client.ts');
    const config = loadExtensionConfig() ?? fail('No inbox found: start one, or set YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN to an extension token.');
    const judge = values['judge-cmd'] ? triage.commandJudge(values['judge-cmd'])
      : values['judge-url'] ? triage.chatJudge({ baseUrl: values['judge-url'], model: values['judge-model'] ?? fail('--judge-model is required with --judge-url'), apiKey: process.env[values['judge-key-env'] ?? ''] ?? '' })
      : triage.defaultJudge(values['judge-model']);
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    await triage.runTriage({ ...config, judge, name: values.name }, stop.signal);
    break;
  }
  case 'service': {
    // The options after the name go to the service as they were typed, without --write.
    const [name, ...given] = rest;
    const write = given.includes('--write');
    const args = given.filter((a) => a !== '--write');
    if (name !== 'serve' && name !== 'triage') fail('Usage: your-attention service serve|triage [--write] [options for the command]');
    const { serviceFile } = await import('./node/service.ts');
    const unit = serviceFile(name, [name, ...args]);
    if (!write) { console.log(`# ${unit.path}\n${unit.content}\n# then: ${unit.start}`); break; }
    fs.mkdirSync(path.dirname(unit.path), { recursive: true });
    fs.writeFileSync(unit.path, unit.content);
    console.log(`Wrote ${unit.path}. Start it with: ${unit.start}`);
    break;
  }
  case 'bridge': {
    const { values } = parseArgs({ args: rest, options: { upstream: { type: 'string' }, port: { type: 'string', default: '4815' }, host: { type: 'string', default: '127.0.0.1' }, mdns: { type: 'boolean', default: false } } });
    const upstream = values.upstream ?? loadConfig()?.url ?? fail('Give the inbox with --upstream <url>, or pair this machine first.');
    const b = await (await import('./node/links.ts')).bridge({ upstream, port: Number(values.port), host: values.host, mdns: values.mdns });
    console.error(`[bridge] ${b.url} leads to ${upstream}`);
    break;
  }
  case 'offer': {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'remote-port': { type: 'string', default: '4815' } } });
    if (positionals[0] !== 'ssh' || !positionals[1]) fail('Usage: your-attention offer ssh <host> [--remote-port 4815]');
    const { url } = localServer();
    (await import('./node/links.ts')).offerOverSsh({ host: positionals[1], localPort: Number(new URL(url).port), remotePort: Number(values['remote-port']) });
    break;
  }
  case 'relay': {
    const { values } = parseArgs({ args: rest, options: { port: { type: 'string', default: '4900' }, host: { type: 'string', default: '0.0.0.0' }, 'key-env': { type: 'string', default: 'YOUR_ATTENTION_RELAY_KEY' } } });
    const key = process.env[String(values['key-env'])] ?? fail(`The relay needs its key in $${values['key-env']}.`);
    const r = await (await import('./node/links.ts')).relayServer({ port: Number(values.port), host: values.host, key });
    console.error(`[relay] listening on ${r.url}; inboxes are at /i/<inbox id>/`);
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
