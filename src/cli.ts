// your-attention <command>. Run it with no command for the list.
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { discover } from './adapters/mdns.ts';
import { Client, describeAnswer, loadConfig } from './client.ts';
import type { Option, Priority } from './core/types.ts';
import { homeDir, writePrivate } from './node/home.ts';
import { serve } from './node/server.ts';
import { choosePin, httpPinApi, offerPin, terminal } from './node/pin-prompt.ts';
import { NOTICE, queryUsage, summarize } from './node/telemetry.ts';

const HELP = `your-attention: one inbox for the questions your coding agents ask you.

  serve [--port 4815] [--host ::] [--no-mdns]        run the inbox
  start [options for serve]                           run the inbox in the background
  stop                                                stop the inbox, or its service when one is installed
  open [--link]                                       open the inbox page signed in, or print a one-time sign-in link
  clear                                               clear the cards you answered or that closed; search still finds them
  reset --yes                                         remove every card, answer and file; tokens and templates stay
  login-url                                           print a sign-in link that works once, like open --link
  pin status|set|reset|clear                          read, set, reset or remove the PIN that each browser tab types
  discover [--seconds 3]                              list inboxes on the LAN
  pair <url> [--name NAME] [--role agent|owner]       pair this machine with an inbox
  post --agent ID --title TEXT [--text TEXT] [--option LABEL]... [--priority now|soon|later] [--wait]
                                                      post a card, and with --wait print the answer
  claude-channel                                      the MCP channel server for Claude Code
  claude-hook ask-pre|ask-post|ask-cancel             the AskUserQuestion hooks for Claude Code
  herdr-blocked                                       post a card for each herdr agent that is blocked
  opencode-plugin [--write]                           print or write the OpenCode plugin file that loads the card tools
  triage [--judge-cmd "claude -p" | --judge-url URL --judge-model M --judge-key-env VAR]
                                                      check each card before you see it (OpenRouter by default)
  triage login                                        sign in to OpenRouter for the default judge
  service serve|triage [--write]                      print or write a launchd or systemd unit
  bridge [--upstream URL] [--port 4815] [--mdns]      offer a remote inbox on this machine
  offer ssh <host> [--remote-port 4815]               offer this inbox on another machine over SSH
  relay [--port 4900] [--key-env VAR]                 run a relay that inboxes dial out to
  serve --relay URL [--relay-key-env VAR]             also offer this inbox through a relay
  telemetry status|on|off|show|reset-id               read or change the daily usage counts of this inbox
  telemetry report [--days 30] [--invites FILE]       for the operator: usage per invite, from Analytics Engine

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

function readServerInfo(): { url: string; pid: number } | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(homeDir(), 'server.json'), 'utf8')) as { url: string; pid: number }; } catch { return undefined; }
}

/** Whether an inbox answers at this address. */
const answers = (url: string): Promise<boolean> => fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(2000) })
  .then(async (r) => r.ok && ((await r.json()) as { name?: string } | null)?.name === 'your-attention')
  .catch(() => false);

/** The address of the inbox this machine runs, when one answers there. */
async function runningUrl(): Promise<string | undefined> {
  const info = readServerInfo();
  return info && (await answers(info.url)) ? info.url : undefined;
}

interface TelemetryStatus { enabled: boolean; notified: boolean; notice: boolean; blocked: string | null; destination: string; installId: string; next: unknown }

/** Read or change the usage setting of the inbox on this machine. */
async function telemetry(body?: { enabled?: boolean; notified?: boolean; resetId?: boolean }): Promise<TelemetryStatus> {
  const { url, owner } = localServer();
  const res = await fetch(`${url}/v1/telemetry`, { method: body ? 'PUT' : 'GET', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) fail(`The inbox answered ${res.status}: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? ''}`);
  return (await res.json()) as TelemetryStatus;
}

function describeTelemetry(t: TelemetryStatus): string {
  if (!t.enabled) return 'Usage counts are off. Turn them on with: your-attention telemetry on';
  if (t.blocked) return `Usage counts are on in this inbox, but ${t.blocked}, so this machine sends nothing.`;
  return `Usage counts are on. One report a day goes to ${t.destination}.\nInstall id: ${t.installId}\n\n${NOTICE}`;
}

/** A one-time link that signs a browser in, so the owner token stays out of the address bar and the browser history. */
async function signInLink(): Promise<string> {
  const { url, owner } = localServer();
  const res = await fetch(`${url}/v1/sign-in-codes`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json', 'x-your-attention': '1' }, body: '{}' }).catch(() => undefined);
  if (!res) fail('No inbox runs on this machine. Start one with `your-attention start`.');
  const { code, error } = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  if (!res.ok || !code) fail(`Could not make a sign-in code: ${error ?? res.status}`);
  return `${url}/#signin=${encodeURIComponent(code)}`;
}

/** The inbox the PIN commands change: the one this machine runs, or else the one this machine paired with as owner. */
function pinTarget(): { url: string; token: string } {
  try {
    const { url } = JSON.parse(fs.readFileSync(path.join(homeDir(), 'server.json'), 'utf8')) as { url: string };
    return { url, token: fs.readFileSync(path.join(homeDir(), 'owner-token'), 'utf8').trim() };
  } catch {
    const paired = loadConfig();
    if (!paired) fail('No inbox runs on this machine. Start one with `your-attention serve`, or pair as owner with `your-attention pair <url> --role owner`.');
    return paired;
  }
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
    const { values } = parseArgs({ args: rest, options: { port: { type: 'string', default: '4815' }, host: { type: 'string', default: '::' }, 'no-mdns': { type: 'boolean', default: false }, relay: { type: 'string' }, 'relay-key-env': { type: 'string', default: 'YOUR_ATTENTION_RELAY_KEY' } } });
    const relayKey = values.relay ? process.env[String(values['relay-key-env'])] ?? fail(`--relay needs the relay key in $${values['relay-key-env']}`) : '';
    const stop = async (): Promise<void> => { await server.close(); process.exit(0); };
    const server = await serve({ port: Number(values.port), host: String(values.host), mdns: !values['no-mdns'], relay: values.relay ? { url: values.relay, key: relayKey } : undefined, onShutdown: () => void stop(), terminal: process.stderr.isTTY === true });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // In a terminal, the inbox asks for a PIN until it has one or the person says never. A service has no terminal and never waits here.
    if (process.stdin.isTTY && process.stderr.isTTY) {
      const pin = server.inbox.pin;
      const t = terminal();
      await offerPin(t, { status: async () => pin.status(), set: (p) => pin.set(p), clear: async () => pin.clear(), neverAsk: async () => pin.setNeverAsk(true) });
      t.close();
    }
    break;
  }
  case 'start': {
    // `serve` in the background, with the same options. The shell gets its prompt back once the inbox answers.
    const home = homeDir();
    const already = await runningUrl();
    if (already) { console.log(`The inbox already runs on ${already}.`); break; }
    const log = path.join(home, 'serve.log');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const out = fs.openSync(log, 'a', 0o600);
    const from = fs.statSync(log).size;
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? '', 'serve', ...rest], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    const end = Date.now() + 15_000;
    for (;;) {
      const info = readServerInfo();
      if (info && info.pid === child.pid && (await answers(info.url))) {
        console.log(`Started the inbox on ${info.url}. Its log is ${log}. Stop it with: your-attention stop`);
        // The first start in a terminal tells the person about usage counts, before the inbox sends any.
        if (process.stdout.isTTY) {
          const t = await telemetry();
          if (t.notice) { console.log(`\n${describeTelemetry(t)}`); await telemetry({ notified: true }); }
        }
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const t = terminal(process.stdin, process.stdout);
          await offerPin(t, httpPinApi(info.url, localServer().owner));
          t.close();
        }
        break;
      }
      const tail = () => fs.readFileSync(log, 'utf8').slice(from).trim().split('\n').slice(-10).join('\n');
      if (child.exitCode !== null || child.signalCode !== null) fail(`The inbox did not start:\n${tail()}`);
      if (Date.now() > end) fail(`The inbox did not answer within 15 seconds. Its log is ${log}:\n${tail()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    process.exit(0);
  }
  case 'stop': {
    // A service restarts the inbox when it exits, so stop the service itself when there is one.
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { serviceFile } = await import('./node/service.ts');
      const unit = serviceFile('serve', []);
      const sh = (cmd: string) => spawnSync('sh', ['-c', cmd], { stdio: 'ignore' }).status === 0;
      if (fs.existsSync(unit.path) && sh(unit.running)) {
        if (!sh(unit.stop)) fail(`The inbox service runs, and \`${unit.stop}\` did not stop it.`);
        console.log(`Stopped the inbox service. It starts again at login, or now with: ${unit.start}`);
        break;
      }
    }
    const { url, owner } = localServer();
    const res = await fetch(`${url}/v1/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${owner}` } }).catch(() => undefined);
    if (!res) {
      fs.rmSync(path.join(homeDir(), 'server.json'), { force: true });
      fail('No inbox runs on this machine. Start one with `your-attention serve`.');
    }
    if (res.status !== 202) fail(`The inbox on ${url} refused to stop: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
    // The inbox stops answering before it closes its database, and removes its address file after.
    const before = readServerInfo()?.pid;
    const end = Date.now() + 10_000;
    while ((await answers(url)) || (before !== undefined && readServerInfo()?.pid === before)) {
      if (Date.now() > end) fail(`The inbox on ${url} is still running after 10 seconds.`);
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`Stopped the inbox on ${url}.`);
    break;
  }
  case 'login-url':
    console.log(await signInLink());
    break;
  case 'pin': {
    const [sub = 'status'] = rest;
    const { url, token } = pinTarget();
    const api = httpPinApi(url, token);
    const s = await api.status().catch((e: Error) => fail(`Could not read the PIN of the inbox on ${url}: ${e.message}`));
    const t = terminal(process.stdin, process.stdout);
    try {
      if (sub === 'status') {
        console.log(s.set ? 'This inbox has a PIN. Each new browser tab types it before it opens the inbox.' : s.neverAsk ? 'This inbox has no PIN, and it does not ask for one. Set one with: your-attention pin set' : 'This inbox has no PIN. Set one with: your-attention pin set');
        if (s.lockedUntil) console.log(`Wrong PINs locked the page until ${new Date(s.lockedUntil).toLocaleTimeString()}. \`your-attention pin reset\` lifts it.`);
      } else if (sub === 'set' || sub === 'reset') {
        if (sub === 'set' && s.set) fail('This inbox has a PIN. Replace it with `your-attention pin reset`, which needs no current PIN.');
        const pin = await choosePin(t);
        if (!pin && sub === 'set') fail('No PIN set.');
        if (pin) await api.set(pin); else await api.clear();
        console.log(pin ? `PIN ${sub === 'set' ? 'set' : 'reset'}. Every open tab types it again.` : 'The PIN is gone, and so is the lockout. The page asks for a new PIN when it opens.');
      } else if (sub === 'clear') {
        await api.clear();
        console.log('The PIN is gone. The inbox page opens without one.');
      } else {
        fail('Usage: your-attention pin status|set|reset|clear');
      }
    } catch (e) {
      fail(`The inbox refused: ${(e as Error).message}`);
    } finally {
      t.close();
    }
    break;
  }
  case 'clear':
  case 'reset': {
    if (command === 'reset' && !rest.includes('--yes')) fail('reset removes every card, answer and file, and cannot be undone. Run `your-attention reset --yes` to confirm, or `your-attention clear` to clear only the cards you dealt with.');
    const { url, owner } = localServer();
    const res = await fetch(`${url}/v1/${command === 'clear' ? 'archive' : 'reset'}`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify(command === 'reset' ? { confirm: 'reset' } : {}) }).catch(() => undefined);
    if (!res) fail('No inbox runs on this machine. Start one with `your-attention start`.');
    const body = (await res.json().catch(() => ({}))) as { archived?: number; removed?: number; error?: string };
    if (!res.ok) fail(`The inbox refused: ${body.error ?? res.status}`);
    console.log(command === 'clear' ? `Cleared ${body.archived} cards. Search still finds them.` : `Removed ${body.removed} cards and their answers.`);
    break;
  }
  case 'open': {
    const { values } = parseArgs({ args: rest, options: { link: { type: 'boolean', default: false } } });
    const link = await signInLink();
    if (values.link) {
      console.log(`Open this link in the browser to sign in. It works once, within 5 minutes:\n${link}`);
      break;
    }
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [link]);
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
  case 'opencode-plugin': {
    const { values } = parseArgs({ args: rest, options: { write: { type: 'boolean', default: false } } });
    const { pluginFile, pluginSource } = await import('./integrations/opencode/install.ts');
    const file = pluginFile();
    if (!values.write) { console.log(`# ${file}\n${pluginSource()}`); break; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pluginSource());
    console.log(`Wrote ${file}. OpenCode loads it at its next start.`);
    break;
  }
  case 'herdr-blocked':
    await (await import('./integrations/herdr/blocked.ts')).main();
    break;
  case 'telemetry': {
    const [sub, ...args] = rest;
    if (sub === 'report') {
      // For the operator of the hosted service. Invite codes stay in the file: the report prints the label beside each one.
      const { values } = parseArgs({ args, options: { days: { type: 'string', default: '30' }, invites: { type: 'string' } } });
      const account = process.env['CLOUDFLARE_ACCOUNT_ID'];
      const token = process.env['CLOUDFLARE_API_TOKEN'];
      if (!account || !token) fail('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, a token with Account Analytics Read.');
      const labels = new Map<string, string>();
      if (values.invites) {
        const { inviteId } = await import('./core/telemetry.ts');
        const lines = fs.readFileSync(values.invites, 'utf8').split(/\r?\n/);
        for (const [i, line] of lines.entries()) {
          const [code, ...label] = line.trim().split(/\s+/);
          if (code && !code.startsWith('#')) labels.set(await inviteId(code), label.join(' ') || `line ${i + 1}`);
        }
      }
      const rows = summarize(await queryUsage(account, token, Number(values.days)), labels);
      if (!rows.length) { console.log(`No usage reports in the last ${values.days} days.`); break; }
      const cols = ['invite', 'inboxes', 'days', 'cards', 'answers', 'pairings', 'pages', 'peakAgents', 'peakInstances', 'peakTokens', 'flag'] as const;
      const table = [cols.map(String), ...rows.map((r) => cols.map((c) => String(r[c])))];
      const widths = cols.map((_, i) => Math.max(...table.map((row) => (row[i] ?? '').length)));
      for (const row of table) console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
      break;
    }
    if (sub === undefined || sub === 'status') {
      const t = await telemetry();
      console.log(describeTelemetry(t));
      if (t.notice) await telemetry({ notified: true });
      break;
    }
    if (sub === 'on' || sub === 'off') {
      const t = await telemetry({ enabled: sub === 'on' });
      console.log(sub === 'on' ? describeTelemetry(t) : 'Usage counts are off. This inbox counts nothing and sends nothing.');
      break;
    }
    if (sub === 'show') { console.log(JSON.stringify((await telemetry()).next, null, 2)); break; }
    if (sub === 'reset-id') { console.log(`New install id: ${(await telemetry({ resetId: true })).installId}`); break; }
    fail('Usage: your-attention telemetry status|on|off|show|reset-id, or telemetry report for the operator.');
  }
  default:
    console.log(HELP);
    if (command && command !== 'help' && command !== '--help') process.exit(1);
}
