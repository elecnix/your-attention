// `your-attention install`: what an agent runs to learn the exact commands that connect its harness to the inbox.
//
// The reader is an agent, not a person at a keyboard, so nothing here waits for an answer: the report is a list of
// lines, and every line an agent has to run appears as one command it can copy whole.
import fs from 'node:fs';
import path from 'node:path';

/** One harness the inbox knows how to connect. */
export interface Harness {
  /** The word `install --help` takes. */
  name: string;
  /** The program whose presence means the harness runs on this machine. */
  binary: string;
  /** What the harness gets from the plugin, in one line. */
  what: string;
  /** The exact command, or undefined for a harness that talks to the inbox through the CLI alone. */
  command?: string;
  /** The rest of the recipe for `install --help <name>`. */
  steps: string[];
}

export const HARNESSES: Harness[] = [
  {
    name: 'claude',
    binary: 'claude',
    what: 'the MCP channel server, which gives every session the card tools and pushes each answer into it',
    command: 'claude mcp add -s user your-attention -- your-attention claude-channel',
    steps: [
      'The registration covers every Claude Code session of this user.',
      'Start each session with the channel option, spelled in full: --dangerously-load-development-channels=server:your-attention',
      'Keep the = form: the option takes a list, and a space would make Claude Code read the next word as a second server.',
    ],
  },
  {
    name: 'pi',
    binary: 'pi',
    what: 'the pi extension, which gives every session the card tools and delivers each answer as a user message',
    command: 'pi install git:github.com/elecnix/your-attention',
    steps: [
      'pi loads the extension at the start of every session.',
      'A session started before the install keeps the tool list it read at startup, so restart it.',
    ],
  },
  {
    name: 'opencode',
    binary: 'opencode',
    what: 'the plugin file, which gives every session the card tools and sends each answer into its session',
    command: 'your-attention opencode-plugin --write',
    steps: [
      'The plugin file goes into the OpenCode config folder.',
      'OpenCode loads it at its next start, so restart the session you have open.',
    ],
  },
  {
    name: 'codex',
    binary: 'codex',
    what: 'Codex reaches the inbox through the your-attention command alone',
    steps: [
      'Codex has no plugin. Post and answer cards with the CLI: your-attention post, your-attention watch.',
      'Run your-attention --help for the commands a script uses.',
    ],
  },
  {
    name: 'cline',
    binary: 'cline',
    what: 'Cline reaches the inbox through the your-attention command alone',
    steps: [
      'Cline has no plugin. Post and answer cards with the CLI: your-attention post, your-attention watch.',
      'Run your-attention --help for the commands a script uses.',
    ],
  },
];

/** The facts the report needs, so a test can supply them without a machine. */
export interface InstallFacts {
  /** The command a PATH lookup found for each harness binary, absent when this shell has it nowhere. */
  found: Record<string, string | undefined>;
  /** Whether `brew` answers on this PATH. */
  brew: boolean;
  /** The your-attention binary this shell resolved, absent when it resolves none. */
  self: string | undefined;
  /** The checkout the person named with --from-source. */
  fromSource?: string;
}

/** The first file on this PATH with that name, or undefined when this shell has it nowhere. */
export function which(binary: string, pathEnv: string | undefined, exists: (file: string) => boolean = (f) => fs.existsSync(f)): string | undefined {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, binary);
    if (exists(file)) return file;
  }
  return undefined;
}

/** The harness whose binary answers on this PATH, by name. */
export function detect(pathEnv: string | undefined, exists: (file: string) => boolean = (f) => fs.existsSync(f)): Record<string, string | undefined> {
  const found: Record<string, string | undefined> = {};
  for (const h of HARNESSES) found[h.name] = which(h.binary, pathEnv, exists);
  return found;
}

/** How the command itself gets onto PATH, which is what an agent started from a non-interactive shell needs first. */
export function installRoutes(facts: InstallFacts): string[] {
  if (facts.fromSource) {
    return [
      `Install the command from the checkout you named:`,
      `  cd ${facts.fromSource} && npm ci && npm link`,
    ];
  }
  if (facts.brew) {
    return [
      'Install the command with Homebrew, which answers on this PATH:',
      '  brew install elecnix/tap/your-attention',
      'Without Homebrew, install from a checkout:',
      '  your-attention install --from-source /path/to/your-attention',
    ];
  }
  return [
    'Install the command from a checkout, since brew answers nowhere on this PATH:',
    '  your-attention install --from-source /path/to/your-attention',
    'That runs: cd /path/to/your-attention && npm ci && npm link',
    'With Homebrew installed: brew install elecnix/tap/your-attention',
  ];
}

/** The whole report, one line per string, in the order an agent reads it. */
export function installReport(facts: InstallFacts): string[] {
  const lines: string[] = [];
  lines.push('your-attention install: the exact commands that connect this machine\'s harnesses to the inbox.');
  lines.push('It reads nothing, runs nothing and asks no question. Run the commands yourself.');
  lines.push('');

  // The command itself comes first: an agent that has no your-attention cannot run any line below it.
  if (facts.self) {
    lines.push(`command: ${facts.self}`);
  } else {
    // A fact about this shell, not about the machine: an agent's PATH is short, so a command installed for a person
    // is often invisible here. Saying so stops an agent from concluding the command is missing everywhere.
    lines.push('command: not on this PATH');
    lines.push('That is a fact about this shell, not about the machine: a non-interactive PATH is often shorter than a login one.');
  }
  lines.push(...installRoutes(facts));
  lines.push('');

  for (const h of HARNESSES) {
    const at = facts.found[h.name];
    if (!at) {
      // A harness this shell cannot see gets its name and the way to its recipe, and nothing to run.
      lines.push(`${h.name}: not found on this PATH`);
      lines.push(`  your-attention install --help ${h.name}`);
      continue;
    }
    lines.push(`${h.name}: ${at}`);
    if (!h.command) {
      lines.push(`  no plugin: ${h.what}.`);
      lines.push(`  your-attention install --help ${h.name}`);
      continue;
    }
    lines.push(`  ${h.command}`);
  }
  lines.push('');

  lines.push('Restart every harness you configure. An agent keeps the tool list it read at startup, so a running');
  lines.push('session does not see the new tools until it starts again.');
  lines.push('For Claude Code, start each session with this option, spelled in full:');
  lines.push('  --dangerously-load-development-channels=server:your-attention');
  lines.push('');

  // The reasoning comes last, because an agent that only needs the commands can stop reading at the blank line above.
  lines.push('Why the plugins are worth installing: an agent that has one receives your answers directly, as a message');
  lines.push('in its session, instead of asking the inbox again and again for something new. The plugin also gives the');
  lines.push('agent native tools, so it posts and answers cards without a shell command. The your-attention CLI stays');
  lines.push('usable on its own, as the compatibility layer every harness speaks: a script posts a card with');
  lines.push('your-attention post and reads the answer with your-attention watch. The plugin speaks the native protocol');
  lines.push('over a WebSocket, which the inbox keeps open so a cloud inbox can sleep between answers.');
  return lines;
}

/** The full recipe for one harness, printed by `install --help <harness>`. It works whether or not the tool is here. */
export function installHelp(name: string, facts: InstallFacts): string[] | undefined {
  const h = HARNESSES.find((x) => x.name === name);
  if (!h) return undefined;
  const lines: string[] = [];
  lines.push(`your-attention install --help ${h.name}`);
  lines.push('');
  lines.push(`What it gives an agent: ${h.what}.`);
  const at = facts.found[h.name];
  lines.push(at ? `On this PATH: ${at}` : `On this PATH: nothing. The recipe below works on a machine where ${h.binary} answers.`);
  lines.push('');
  if (h.command) {
    lines.push('Run this command once, and only once:');
    lines.push(`  ${h.command}`);
  } else {
    lines.push('Run nothing: this harness needs no plugin.');
  }
  lines.push('');
  for (const step of h.steps) lines.push(step);
  lines.push('');
  lines.push('Then restart the harness. An agent keeps the tool list it read at startup.');
  if (h.name === 'claude') {
    lines.push('Start it with the channel option, spelled in full:');
    lines.push('  --dangerously-load-development-channels=server:your-attention');
  }
  return lines;
}
