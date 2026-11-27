// The usage of each `your-attention` command, and the parser every command reads its arguments with. `your-attention help`
// and `your-attention <command> --help` both print from COMMANDS, so the list and a command's own help never disagree.
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

/** One line of `your-attention help`: the syntax, and what it does. A summary may run over several lines. */
export interface UsageLine { syntax: string; summary: string }

/** A command, its lines in the list, and one short sentence for each option it takes. */
export interface CommandUsage { name: string; lines: UsageLine[]; options: [flag: string, text: string][] }

const SERVE_OPTIONS: [string, string][] = [
  ['--port PORT', 'the port to listen on, 4815 by default'],
  ['--host HOST', 'the address to listen on, :: by default, which takes IPv4 and IPv6'],
  ['--no-mdns', 'do not advertise the inbox on the LAN'],
  ['--relay URL', 'also offer this inbox through the relay at this address'],
  ['--relay-key-env VAR', 'the variable that holds the relay key, YOUR_ATTENTION_RELAY_KEY by default'],
];

const WATCH_OPTIONS: [string, string][] = [
  ['--agent ID', 'the agent whose cards to watch'],
  ['--role agent|owner', 'watch with the agent token, the default, or as the owner'],
  ['--no-card', 'leave the card out of each line'],
  ['--select FIELD,...', 'keep only these card fields in each line'],
  ['--type TYPE,...', 'print only these event types'],
  ['--ack', 'mark each answer read as it prints, which an owner watcher cannot do'],
];

/** Every command, in the order `your-attention help` lists them. A command that shows on several lines, such as serve,
 * lists each line where it belongs in the list, and its own help prints them all. */
const LIST: [name: string, syntax: string, summary: string][] = [
  ['serve', 'serve [--port 4815] [--host ::] [--no-mdns]', 'run the inbox'],
  ['start', 'start [options for serve]', 'run the inbox in the background'],
  ['stop', 'stop', 'stop the inbox, or its service when one is installed'],
  ['status', 'status', "show the inbox, its files, and this machine's pairings"],
  ['footer', 'footer [--max 5] [--agent <id>]', 'print one status-line segment: how many cards wait for you, and a link to each of the first few'],
  ['open', 'open [--link]', 'open the inbox page signed in, or print a one-time sign-in link and its code'],
  ['tui', 'tui [--mono] [--ascii]', 'answer cards full screen in this terminal, with the keyboard and mouse'],
  ['clear', 'clear', 'clear the cards you answered or that closed; search still finds them'],
  ['reset', 'reset --yes', 'remove every card, answer and file; tokens and templates stay'],
  ['login-url', 'login-url', 'print a sign-in link that works once, like open --link'],
  ['pin', 'pin status|set|reset|clear', 'read, set, reset or remove the PIN that each browser tab types'],
  ['otp', 'otp list|enroll <label> [--allow ID]...|allow <label> ID...|disallow <label> ID...|remove <label>', 'keep authenticator keys in the inbox, so an approval on a card gives an agent a one-time code'],
  ['install', 'install [--from-source PATH]', "print the exact commands that connect this machine's harnesses, and ask nothing"],
  ['install', 'install --help <harness>', 'the full recipe for one harness, even when it is not installed'],
  ['discover', 'discover [--seconds 3]', 'list inboxes on the LAN'],
  ['pair', 'pair <url> [--name NAME] [--role agent|owner]', 'pair this machine with an inbox'],
  ['post', 'post --agent ID --title TEXT [--text TEXT] [--option LABEL]... [--priority now|soon|later] [--wait]', 'post a card, and with --wait print the answer'],
  ['ack', 'ack <card> [<card>...]', 'mark answers read, when a script took them out of band'],
  ['watch', 'watch [--agent ID] [--no-card] [--select FIELD,...] [--type TYPE,...] [--ack]', 'print each answer for that agent as a line of JSON; --ack marks each\nread, and without it the card waits in the outbox as unread'],
  ['watch', 'watch --role owner [--agent ID] [--no-card] [--select FIELD,...] [--type TYPE,...]', "print each change to every card, or to that agent's, as the owner"],
  ['subscribe', "subscribe --agent ID (--webhook URL | --webhook-file FILE) [--header 'NAME: VALUE']... [--header-file FILE|-]", "send each answer to that agent's cards to an https webhook, once you approve it"],
  ['unsubscribe', 'unsubscribe --agent ID', "stop sending that agent's answers to its webhook"],
  ['pi', 'pi [--tags repo=acme/api,topic=billing] -- [pi args]', 'run pi, and give every card it posts default tags\n(YOUR_ATTENTION_TAGS, read by the pi extension at session start)'],
  ['claude-channel', 'claude-channel', 'the MCP channel server for Claude Code'],
  ['claude-hook', 'claude-hook ask-pre|ask-post|ask-cancel|turn-end|secret-pre|secret-post', 'the Claude Code hooks: AskUserQuestion, and the turn end the channel times its asks for a card from'],
  ['herdr-blocked', 'herdr-blocked', 'post a card for each herdr agent that is blocked'],
  ['opencode-plugin', 'opencode-plugin [--write]', 'print or write the OpenCode plugin file that loads the card tools'],
  ['triage', 'triage [--judge-cmd "claude -p" | --judge-url URL --judge-model M --judge-key-env VAR]', 'check each card before you see it (OpenRouter by default)'],
  ['triage', 'triage login', 'sign in to OpenRouter for the default judge'],
  ['triage', 'triage feedback [--verdict any|agree|disagree|partly]', "as the owner: one line of JSON per card triage pushed back on, with\nthe reason, the agent's feedback and how the card ended"],
  ['bellwether', 'bellwether [--once] [--home DIR]', "as the owner: when Bellwether retires an agent, hand each of its cards to\nits nearest living ancestor, or to you when none is alive"],
  ['service', 'service serve|triage|bellwether [--write]', 'print or write a launchd or systemd unit'],
  ['bridge', 'bridge [--upstream URL] [--port 4815] [--mdns]', 'offer a remote inbox on this machine'],
  ['offer', 'offer ssh <host> [--remote-port 4815]', 'offer this inbox on another machine over SSH'],
  ['relay', 'relay [--port 4900] [--key-env VAR]', 'run a relay that inboxes dial out to'],
  ['serve', 'serve --relay URL [--relay-key-env VAR]', 'also offer this inbox through a relay'],
  ['secret', 'secret source list', 'list the secret sources of this computer, and whether each is ready'],
  ['secret', 'secret source add <file://folder> [--name NAME] [--form node|stdio] [--command CMD]', 'add a secret source from a folder on this computer'],
  ['secret', 'secret source remove <name>', 'remove a secret source; its folder stays as it is'],
  ['secret', 'secret age dir add|remove <dir>', 'choose the folders of *.age files the built-in age source reads'],
  ['secret', 'secret age passphrase <dir>', "keep a folder's passphrase, read on stdin, in an envelope that only\nthis computer's age identity opens"],
  ['telemetry', 'telemetry status|on|off|show|reset-id', 'read or change the anonymous usage counts, off unless you turn them on'],
  ['telemetry', 'telemetry report [--days 30] [--invites FILE]', 'for the operator: usage per invite, from Analytics Engine'],
];

const OPTIONS: Record<string, [string, string][]> = {
  serve: SERVE_OPTIONS,
  start: SERVE_OPTIONS,
  stop: [],
  status: [],
  footer: [['--max N', 'how many card links to print after the count, 5 by default; 0 prints the count alone'], ['--agent ID', 'count only this agent\'s cards, such as claude:<session id>; every card in the inbox without it']],
  open: [['--link', 'print a sign-in link and a code to type, which work once, instead of opening the browser']],
  tui: [['--mono', 'draw without colors, like NO_COLOR=1'], ['--ascii', 'draw the borders and marks with ASCII characters only']],
  clear: [],
  reset: [['--yes', 'confirm the reset, which cannot be undone']],
  'login-url': [],
  pin: [
    ['status', 'say whether the inbox has a PIN, the default'],
    ['set', 'choose a PIN when the inbox has none'],
    ['reset', 'replace the PIN, or remove it, and lift a lockout'],
    ['clear', 'remove the PIN'],
  ],
  otp: [
    ['list', 'list the keys, the sessions each allows, and when each last gave a code, the default'],
    ['enroll <label>', 'read a key and a current code from the terminal without echo, or one per line from a pipe, and keep the key if the code matches'],
    ['--allow ID', 'with enroll: a session id that may ask for a code from the key; repeat it for each session'],
    ['allow <label> ID...', 'let more sessions ask for a code from the key'],
    ['disallow <label> ID...', 'stop sessions from asking for a code from the key'],
    ['remove <label>', 'delete the key from the inbox'],
  ],
  install: [
    ['--from-source PATH', 'name the checkout at PATH in the line that links the command with npm link'],
    ['--help HARNESS', 'print the full recipe for one harness, such as claude or pi'],
  ],
  discover: [['--seconds N', 'how long to listen for inboxes, 3 by default']],
  pair: [
    ['<url>', 'the address of the inbox, required'],
    ['--name NAME', 'the name the inbox shows for this machine, user@host by default'],
    ['--role agent|owner', 'pair for agents, the default, or as the owner in owner.json'],
  ],
  post: [
    ['--agent ID', 'the agent that asks, required'],
    ['--title TEXT', 'the question, required'],
    ['--text TEXT', 'the body of the card, in Markdown'],
    ['--option LABEL', 'one answer the person can pick; repeat it for more'],
    ['--priority now|soon|later', 'how soon the card needs an answer, soon by default'],
    ['--wait', 'wait for the answer and print it'],
  ],
  ack: [['<card>', 'the id of a card whose answer to mark read; give one or more']],
  watch: WATCH_OPTIONS,
  subscribe: [
    ['--agent ID', 'the agent whose answers go to the webhook, required'],
    ['--webhook URL', 'the https address that receives each answer'],
    ['--webhook-file FILE', 'read that address from a file, so it stays out of the process list'],
    ['--header \'NAME: VALUE\'', 'a header sent with each answer; repeat it for more'],
    ['--header-file FILE|-', 'read headers from a file, or from stdin with -, one per line'],
  ],
  unsubscribe: [['--agent ID', 'the agent whose webhook to remove, required']],
  pi: [
    ['--tags K=V,...', 'default tags for every card pi posts'],
    ['-- [pi args]', 'everything after -- goes to pi unchanged'],
  ],
  'claude-channel': [],
  'claude-hook': [
    ['ask-pre', 'before AskUserQuestion: post the question as a card'],
    ['ask-post', 'after AskUserQuestion: close the card the terminal answered'],
    ['ask-cancel', 'when the dialog ends without an answer: close the card the person did not answer'],
    ['turn-end', 'the Stop hook: record that the turn ended, so the channel asks for a card after 2, 5 and 10 minutes of inactivity'],
    ['secret-pre', 'before Bash: while the session holds a secret grant, read its variables into the command from the channel'],
    ['secret-post', 'after Bash: mask each secret value in the output before the model reads it'],
  ],
  'herdr-blocked': [],
  'opencode-plugin': [['--write', 'write the plugin file instead of printing it']],
  triage: [
    ['--judge-cmd CMD', 'judge each card with this command in print mode, such as "claude -p"'],
    ['--judge-url URL', 'judge each card with the chat completions endpoint at this address'],
    ['--judge-model M', 'the model to ask at --judge-url, required with it'],
    ['--judge-key-env VAR', 'the variable that holds the key for --judge-url'],
    ['--name NAME', 'the name of this extension, triage by default'],
    ['--screen-open', 'also check the open cards that have no verdict from this extension yet, once'],
    ['--verdict any|agree|disagree|partly', 'with feedback: only the cards with this verdict from the agent'],
  ],
  bellwether: [
    ['--once', 'read retire.log once, apply what it says, and exit'],
    ['--home DIR', "Bellwether's home, BELLWETHER_HOME or ~/.bellwether by default"],
  ],
  service: [
    ['serve|triage|bellwether', 'the command the unit runs; options after it go to that command'],
    ['--write', 'write the unit file instead of printing it'],
  ],
  bridge: [
    ['--upstream URL', 'the inbox to offer, the paired one by default'],
    ['--port PORT', 'the local port, 4815 by default'],
    ['--host HOST', 'the local address, 127.0.0.1 by default'],
    ['--mdns', 'advertise the bridge on the LAN'],
  ],
  offer: [
    ['ssh <host>', 'the machine to offer this inbox on'],
    ['--remote-port PORT', 'the port on that machine, 4815 by default'],
  ],
  relay: [
    ['--port PORT', 'the port to listen on, 4900 by default'],
    ['--host HOST', 'the address to listen on, 0.0.0.0 by default'],
    ['--key-env VAR', 'the variable that holds the relay key, YOUR_ATTENTION_RELAY_KEY by default'],
  ],
  secret: [
    ['--name NAME', 'with source add: the name of the source, the folder name by default'],
    ['--form node|stdio', 'with source add: a module to import, the default, or an executable to start'],
    ['--command CMD', 'with source add: the executable and its arguments, run in the folder'],
  ],
  telemetry: [
    ['status', 'say whether usage counts are on, the default'],
    ['on|off', 'turn the usage counts on or off'],
    ['show', 'print the next report as JSON'],
    ['reset-id', 'pick a new install id'],
    ['report', 'for the operator: usage per invite'],
    ['--days N', 'with report: how many days back, 30 by default'],
    ['--invites FILE', 'with report: a file of invite codes and their labels'],
  ],
};

/** Every command with its lines and options, in the order of the list. */
export const COMMANDS: CommandUsage[] = [...new Set(LIST.map(([name]) => name))].map((name) => ({
  name,
  lines: LIST.filter(([n]) => n === name).map(([, syntax, summary]) => ({ syntax, summary })),
  options: OPTIONS[name] ?? [],
}));

export function commandUsage(name: string): CommandUsage | undefined {
  return COMMANDS.find((c) => c.name === name);
}

const COLUMN = 52;

/** One line of the list as `your-attention help` prints it: the summary in a column, or under the syntax when it is long. */
function listLine({ syntax, summary }: UsageLine): string {
  const [first = '', ...more] = summary.split('\n');
  const indent = ' '.repeat(COLUMN + 2);
  const head = syntax.length > COLUMN - 2 ? `  ${syntax}\n${indent}${first}` : `  ${syntax.padEnd(COLUMN - 2)}  ${first}`;
  return [head, ...more.map((m) => indent + m)].join('\n');
}

/** What `your-attention help` prints. */
export function helpText(home: string): string {
  return `your-attention: one inbox for the questions your coding agents ask you.

${LIST.map(([, syntax, summary]) => listLine({ syntax, summary })).join('\n')}

Files live in ${home} (set YOUR_ATTENTION_HOME to move them).`;
}

/** The usage lines of one command, as `Usage: your-attention ...`. */
export function usageLines(c: CommandUsage): string {
  return c.lines.map((l, i) => `${i ? '       ' : 'Usage: '}your-attention ${l.syntax}`).join('\n');
}

/** What `your-attention <command> --help` prints: its usage, what each line does, and each option. */
export function commandHelp(c: CommandUsage): string {
  const lines = c.lines.flatMap((l) => [`  your-attention ${l.syntax}`, ...l.summary.split('\n').map((s) => `      ${s}`)]);
  const options: [string, string][] = [...c.options, ['-h, --help', 'print this help']];
  const width = Math.max(...options.map(([f]) => f.length));
  return ['Usage:', ...lines, '', 'Options:', ...options.map(([f, t]) => `  ${f.padEnd(width)}  ${t}`)].join('\n');
}

/** Print a usage mistake as one line, then the command's usage, to stderr, and exit 2. */
export function usageError(command: string, problem: string): never {
  const c = commandUsage(command);
  process.stderr.write(`your-attention ${command}: ${problem}\n${c ? `${usageLines(c)}\nRun \`your-attention ${command} --help\` for its options.\n` : ''}`);
  process.exit(2);
}

/** Whether these arguments ask for help: -h anywhere before `--`, or --help, unless the command takes --help with a value
 * of its own (install --help claude) and one follows. */
export function wantsHelp(args: readonly string[], ownHelp = false): boolean {
  const end = args.indexOf('--');
  const own = end < 0 ? args : args.slice(0, end);
  return own.some((a, i) => a === '-h' || (a === '--help' && !(ownHelp && own[i + 1] !== undefined && !own[i + 1]!.startsWith('-'))));
}

/** The one short line for a mistake parseArgs found, or undefined when the error is not a usage mistake. */
export function parseProblem(e: unknown): string | undefined {
  const err = e as { code?: string; message?: string };
  const quoted = /'([^']+)'/.exec(err.message ?? '')?.[1] ?? '';
  switch (err.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION': return `unknown option ${quoted}`;
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': return `unexpected argument ${quoted}`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE': {
      const option = quoted.split(' ')[0] ?? quoted;
      if (/argument missing/.test(err.message ?? '')) return `${option} needs a value`;
      if (/does not take an argument/.test(err.message ?? '')) return `${option} takes no value`;
      // Another Node version may word a new case differently, so its own words are the safest line to print.
      return err.message ?? 'an invalid option value';
    }
    default: return undefined;
  }
}

/** parseArgs for one command. `--help` or `-h` prints the command's help and exits 0. A mistake in the arguments prints
 * one line and the usage, and exits 2. Any other error is a crash, and keeps its stack. */
export function parseCommand<T extends ParseArgsConfig>(command: string, config: T): ReturnType<typeof parseArgs<T>> {
  const c = commandUsage(command);
  if (c && wantsHelp(config.args ?? [], config.options?.['help'] !== undefined)) {
    process.stdout.write(`${commandHelp(c)}\n`);
    process.exit(0);
  }
  try {
    return parseArgs(config);
  } catch (e) {
    const problem = parseProblem(e);
    if (problem) usageError(command, problem);
    throw e;
  }
}
