// The checks of the example triage agent. It runs all three on every card, at the same time, and gives every finding
// in one notice, so an agent fixes everything in one more turn:
//   1. vale, on the card's prose, with the rules in ./vale;
//   2. pr-context-classifier, with the card prompt in ./card-prompt.md;
//   3. an optional PR-verdict command, named only in your local config, on a card tagged pr: owner/repo#number.
// The local policy says which findings block the card (it goes back to its agent) and which are advice (the card goes
// to the person, and the agent gets the advice). After `maxReturns` returns of one card, the next attempt passes,
// with its findings as advice. Every return notice carries a code that lets one card of that agent skip triage once.
// Every check fails open: when a command is missing, exits with an error, runs out of time or prints something
// unreadable, that check has no findings, and the agent logs why.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScreenMode } from '../../src/core/hooks.ts';
import type { Card } from '../../src/core/types.ts';
import type { Ruling } from '../../src/extensions/card-hook.ts';
import { logRuling, type LoggedCheck, type RulingLine } from './log.ts';
import { TriageState } from './state.ts';

export const VALE_INI = path.join(import.meta.dirname, 'vale', '.vale.ini');
export const CARD_PROMPT = path.join(import.meta.dirname, 'card-prompt.md');
export const CARD_QUESTION = 'Can the person make the decision this card asks for from the card alone, without opening the agent\'s session, its code or its diff?';

export interface PrVerdictConfig {
  /** The command and its first arguments. The check appends the pull request's URL and --json. */
  command: string[];
  /** The verdicts that pass the card. Any other verdict blocks it or gives advice, by the policy's threshold. */
  acceptVerdicts: string[];
  timeoutMs: number;
}

/** What a finding does: `block` sends the card back, `advise` lets it through and tells the agent, `ignore` drops it. */
export type Level = 'block' | 'advise' | 'ignore';

export interface Policy {
  valeErrors: Level;
  valeWarnings: Level;
  classifierMissingContext: Level;
  /** A verdict the PR-verdict command does not accept blocks the card below this confidence, and is advice from it up. */
  prVerdictBlockBelow: number;
}

export interface ExampleConfig {
  /** Each command is a list: the program, then its arguments. The check appends its own arguments after them. */
  vale: string[];
  classifier: string[];
  valeTimeoutMs: number;
  classifierTimeoutMs: number;
  prVerdict?: PrVerdictConfig;
  policy: Policy;
  /** How many times one card goes back before its next attempt passes with the findings as advice. */
  maxReturns: number;
  /** Where the agent keeps the return counts and the bypass codes. */
  stateFile: string;
  /** Which cards a connection screens: `new` checks the cards that arrive while it is connected, and `open` also
   * takes the open cards that have no triage verdict yet, once, when it connects. */
  screen: ScreenMode;
  /** Where the agent appends one JSON line per ruling, for the operator to look back at. */
  logFile: string;
}

export const DEFAULTS: ExampleConfig = {
  vale: ['vale'], classifier: ['pr-context-classifier'], valeTimeoutMs: 30_000, classifierTimeoutMs: 150_000,
  policy: { valeErrors: 'block', valeWarnings: 'advise', classifierMissingContext: 'block', prVerdictBlockBelow: 0.5 },
  maxReturns: 3,
  stateFile: path.join(os.homedir(), '.local', 'state', 'your-attention', 'triage-example.json'),
  screen: 'new',
  logFile: path.join(os.homedir(), '.local', 'state', 'your-attention', 'triage.jsonl'),
};
/** The tag an agent sets, to the code a return notice gave it, to let one urgent card skip triage. */
export const BYPASS_TAG = 'triage-bypass';
const PR_VERDICT_DEFAULTS = { acceptVerdicts: ['ACCEPT'], timeoutMs: 300_000 };

export function defaultConfigPath(): string {
  return process.env['YOUR_ATTENTION_TRIAGE_EXAMPLE_CONFIG'] ?? path.join(os.homedir(), '.config', 'your-attention', 'triage-example.json');
}

/** The local config, over the defaults. A missing file gives the defaults, which have no PR-verdict command. A field
 * that an earlier version read and this one doesn't, such as knownNames, gets one line in `log`, and the config loads. */
export function loadConfig(file = defaultConfigPath(), log: (line: string) => void = (line) => console.error(line)): ExampleConfig {
  // An empty path, such as --config "$CFG" with CFG unset, would otherwise run the default policy without a word.
  if (!file) throw new Error('--config needs a file path, and it was empty');
  if (!fs.existsSync(file)) return { ...DEFAULTS, policy: { ...DEFAULTS.policy } };
  const bad = (what: string): never => { throw new Error(`${file}: ${what}`); };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return bad(`not readable JSON (${(e as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('the config must be a JSON object, such as {"vale": ["vale"]}');
  const strings = (name: string, v: unknown): string[] =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string') ? v : bad(`${name} must be a list of strings, such as ["vale"]`);
  // The inbox waits at most ten minutes for a verdict, and the agent keeps ten seconds of that to answer.
  const ms = (name: string, v: unknown): number => typeof v !== 'number' || v <= 0 ? bad(`${name} must be a positive number of milliseconds`)
    : v > 590_000 ? bad(`${name} must be at most 590000 ms, since the inbox waits at most 600000 ms for a verdict`) : v;
  const level = (name: string, v: unknown): Level => v === 'block' || v === 'advise' || v === 'ignore' ? v : bad(`${name} must be block, advise or ignore`);
  const cfg: ExampleConfig = { ...DEFAULTS, policy: { ...DEFAULTS.policy } };
  if (raw['vale'] !== undefined) cfg.vale = strings('vale', raw['vale']);
  if (raw['classifier'] !== undefined) cfg.classifier = strings('classifier', raw['classifier']);
  if (raw['valeTimeoutMs'] !== undefined) cfg.valeTimeoutMs = ms('valeTimeoutMs', raw['valeTimeoutMs']);
  if (raw['classifierTimeoutMs'] !== undefined) cfg.classifierTimeoutMs = ms('classifierTimeoutMs', raw['classifierTimeoutMs']);
  const policy = (raw['policy'] ?? {}) as Record<string, unknown>;
  for (const k of ['valeErrors', 'valeWarnings', 'classifierMissingContext'] as const) if (policy[k] !== undefined) cfg.policy[k] = level(`policy.${k}`, policy[k]);
  if (policy['prVerdictBlockBelow'] !== undefined) {
    const t = policy['prVerdictBlockBelow'];
    cfg.policy.prVerdictBlockBelow = typeof t === 'number' && t >= 0 && t <= 1 ? t : bad('policy.prVerdictBlockBelow must be a number from 0 to 1');
  }
  if (raw['maxReturns'] !== undefined) {
    const m = raw['maxReturns'];
    cfg.maxReturns = Number.isInteger(m) && (m as number) >= 0 ? m as number : bad('maxReturns must be a whole number, 0 or more');
  }
  if (raw['screen'] !== undefined) {
    const v = raw['screen'];
    cfg.screen = v === 'new' || v === 'open' ? v : bad('screen must be "new" or "open"');
  }
  /** A path field, with a leading `~/` expanded to the home directory, as stateFile and logFile both are. */
  const pathField = (name: string): string | undefined => {
    if (raw[name] === undefined) return undefined;
    const f = typeof raw[name] === 'string' ? raw[name] : bad(`${name} must be a path`);
    return f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : f;
  };
  const stateFile = pathField('stateFile');
  if (stateFile !== undefined) cfg.stateFile = stateFile;
  const logFile = pathField('logFile');
  if (logFile !== undefined) cfg.logFile = logFile;
  // The card prompt had a step that asked the card to explain names, with these two fields. The step is gone, and a
  // config written for it still loads.
  const retired = [raw['knownNames'] !== undefined && 'knownNames', policy['classifierNames'] !== undefined && 'policy.classifierNames'].filter((f) => f !== false);
  if (retired.length) log(`${file}: ${retired.join(' and ')} ${retired.length > 1 ? 'are' : 'is'} no longer used, so the agent ignores ${retired.length > 1 ? 'them' : 'it'}`);
  const pr = raw['prVerdict'] as Record<string, unknown> | undefined;
  if (pr !== undefined && pr !== null) {
    cfg.prVerdict = {
      command: strings('prVerdict.command', pr['command']),
      acceptVerdicts: pr['acceptVerdicts'] === undefined ? PR_VERDICT_DEFAULTS.acceptVerdicts : strings('prVerdict.acceptVerdicts', pr['acceptVerdicts']),
      timeoutMs: pr['timeoutMs'] === undefined ? PR_VERDICT_DEFAULTS.timeoutMs : ms('prVerdict.timeoutMs', pr['timeoutMs']),
    };
  }
  return cfg;
}

/** How long the inbox waits for this agent: the slowest check at its full timeout, since they run at once, and ten
 * seconds to spare. */
export function hookTimeoutMs(cfg: ExampleConfig): number {
  return Math.min(Math.max(cfg.valeTimeoutMs, cfg.classifierTimeoutMs, cfg.prVerdict?.timeoutMs ?? 0) + 10_000, 600_000);
}

/** The card's prose as Markdown for vale, one paragraph per field, and the field each line of it came from. */
export function cardProse(card: Card): { doc: string; fieldAt: (line: number) => string } {
  const fields: [string, string | undefined][] = [['title', card.title], ['text', card.text], ['recommendation', card.recommendation]];
  card.options?.forEach((o, i) => fields.push([`option ${i + 1} label`, o.label], [`option ${i + 1} description`, o.description]));
  card.questions?.forEach((q, i) => {
    fields.push([`question ${i + 1} text`, q.question], [`question ${i + 1} context`, q.text]);
    q.options?.forEach((o, j) => fields.push([`question ${i + 1} option ${j + 1} label`, o.label], [`question ${i + 1} option ${j + 1} description`, o.description]));
  });
  const owner: string[] = [];
  const parts: string[] = [];
  for (const [name, value] of fields) {
    const text = value?.trim();
    if (!text) continue;
    if (parts.length) { parts.push(''); owner.push(''); }
    for (const line of text.split('\n')) { parts.push(line); owner.push(name); }
  }
  return { doc: `${parts.join('\n')}\n`, fieldAt: (line) => owner[line - 1] || 'card' };
}

/** The card as plain text for the classifier: every field a person reads, in the order the page draws them. */
export function cardText(card: Card): string {
  const option = (o: { label: string; description?: string; recommended?: boolean }): string =>
    `- ${o.label}${o.recommended ? ' (recommended)' : ''}${o.description ? `: ${o.description}` : ''}`;
  const lines = [`Kind: ${card.kind}`, `Title: ${card.title}`];
  if (card.text) lines.push('', 'Text:', card.text);
  if (card.options?.length) lines.push('', `Options${card.multiple ? ' (pick any)' : ''}:`, ...card.options.map(option));
  if (card.recommendation) lines.push('', `Recommendation: ${card.recommendation}`);
  card.questions?.forEach((q, i) => {
    lines.push('', `Question ${i + 1}: ${q.question}`);
    if (q.text) lines.push(q.text);
    if (q.options?.length) lines.push(...q.options.map(option));
    else lines.push('(free-text answer)');
  });
  if (card.approvals?.length) lines.push('', 'Approvals:', ...card.approvals.map((a) => `- ${a.label ?? 'Approve'}: "${a.text}"`));
  if (card.secrets?.length) lines.push('', `Secret fields: ${card.secrets.join(', ')}`);
  if (card.body) lines.push('', 'Body (OpenUI):', card.body.slice(0, 4000));
  if (card.html) lines.push('', 'HTML:', card.html.slice(0, 4000));
  const tags = Object.entries(card.tags ?? {});
  if (tags.length) lines.push('', `Tags: ${tags.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines.join('\n');
}

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export type RunCommand = (argv: string[], input: string, timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;

const STOPPED = 'stopped because the agent is shutting down';
/** The most output the agent keeps from one stream of a command. A command that prints more is stopped, so a runaway
 * command can't fill the agent's memory. A classifier's or a PR-verdict command's answer is a few kilobytes. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Run a command with `input` on stdin. Rejects when it cannot start, runs past `timeoutMs`, or `signal` aborts. In
 * the last two cases it stops the command's whole process group: SIGTERM, then SIGKILL two seconds later, so neither
 * a wrapper's child nor a command that ignores SIGTERM keeps running. It does the same when the command prints more
 * than MAX_OUTPUT_BYTES on stdout or stderr. Windows has no process groups, so there it ends
 * the command alone. */
export const runCommand: RunCommand = (argv, input, timeoutMs, signal) => new Promise((resolve, reject) => {
  const [program, ...args] = argv;
  if (!program) { reject(new Error('the command is empty')); return; }
  if (signal?.aborted) { reject(new Error(STOPPED)); return; }
  const groups = process.platform !== 'win32';
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: groups });
  const out = { stdout: '', stderr: '' };
  const signalAll = (sig: NodeJS.Signals): void => {
    try {
      if (groups && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* the command already ended */ }
  };
  const stop = (why: string): void => {
    signalAll('SIGTERM');
    setTimeout(() => signalAll('SIGKILL'), 2000).unref();
    child.stdout.destroy();
    child.stderr.destroy();
    done();
    reject(new Error(why));
  };
  const onAbort = (): void => stop(STOPPED);
  const timer = setTimeout(() => stop(`took longer than ${timeoutMs} ms`), timeoutMs);
  const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  signal?.addEventListener('abort', onAbort, { once: true });
  for (const name of ['stdout', 'stderr'] as const) {
    let bytes = 0;
    child[name].on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT_BYTES) stop(`printed more than ${MAX_OUTPUT_BYTES} bytes`);
      else out[name] += String(d);
    });
  }
  child.on('error', (e) => { done(); reject(new Error(`could not run (${e.message})`)); });
  child.on('close', (code) => { done(); resolve({ code, ...out }); });
  // A command that exits without reading its input closes the pipe: its exit code is the answer, not EPIPE.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});


/** Run one command and read its output. Anything that goes wrong becomes a reason the check could not run. A command
 * whose exit code carries its verdict, as a PR-verdict tool's often does, sets `anyExit`: its output decides. */
async function ask<T>(label: string, argv: string[], input: string, timeoutMs: number, okCodes: number[] | 'any', read: (stdout: string) => T | undefined, run: RunCommand, signal?: AbortSignal): Promise<T | { skipped: string }> {
  let res: CommandResult;
  try {
    res = await run(argv, input, timeoutMs, signal);
  } catch (e) {
    return { skipped: `${label} ${(e as Error).message}` };
  }
  const exitedBadly = res.code === null || (okCodes !== 'any' && !okCodes.includes(res.code));
  let value: T | undefined;
  try {
    value = exitedBadly ? undefined : read(res.stdout);
  } catch {
    value = undefined;
  }
  if (value !== undefined) return value;
  // An exit code the command doesn't use for success explains the failure better than its unreadable output.
  if (exitedBadly || (okCodes === 'any' && res.code !== 0)) return { skipped: `${label} exited with ${res.code}: ${res.stderr.trim().slice(0, 300)}` };
  return { skipped: `${label} gave output it could not read: ${res.stdout.trim().slice(0, 200)}` };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

export type CheckName = 'Vale' | 'Card classifier' | 'PR verdict';

/** Findings of one check at one level, as lines of the notice. */
export interface Section { check: CheckName; level: 'block' | 'advise'; lines: string[] }

/** What one check found, or why it could not run. `detail` keeps the check's own output for the eval. */
export interface CheckReport {
  check: CheckName;
  sections: Section[];
  skipped?: string;
  detail?: { vale?: { rule: string; severity: string }[]; classifier?: { verdict: string; rationale: string; questions: string[] }; prVerdict?: { pr: string; verdict: string; confidence?: number } };
}

/** The most findings one section lists, so the whole notice fits what the inbox keeps. */
const MAX_LINES = 12;

function section(check: CheckName, level: Level, lines: string[]): Section[] {
  if (level === 'ignore' || !lines.length) return [];
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`] : lines;
  return [{ check, level, lines: shown }];
}

interface ValeAlert { Line: number; Check: string; Message: string; Severity: string; Match?: string }

export async function valeCheck(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckReport> {
  const { doc, fieldAt } = cardProse(card);
  // Vale exits 1 when it finds an error, and still prints its JSON.
  const found = await ask('vale', [...cfg.vale, '--no-global', '--config', VALE_INI, '--output=JSON', '--ext=.md'], doc, cfg.valeTimeoutMs, [0, 1], (out) => {
    const parsed = JSON.parse(out) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const lists = Object.values(parsed as Record<string, unknown>);
    if (!lists.every(Array.isArray)) return undefined;
    const all = (lists as unknown[][]).flat();
    const isAlert = (a: unknown): a is ValeAlert => typeof a === 'object' && a !== null
      && typeof (a as ValeAlert).Line === 'number' && typeof (a as ValeAlert).Check === 'string' && typeof (a as ValeAlert).Message === 'string' && typeof (a as ValeAlert).Severity === 'string';
    return all.every(isAlert) ? all : undefined;
  }, run, signal);
  if ('skipped' in found) return { check: 'Vale', sections: [], skipped: found.skipped };
  // An option label is the person's answer, so it speaks in the person's voice, and "I" is right there.
  const alerts = found.filter((a) => !(a.Check === 'Cards.FirstPerson' && / label$/.test(fieldAt(a.Line))));
  const lines = doc.split('\n');
  const describe = (a: ValeAlert): string => {
    const field = fieldAt(a.Line);
    const first = lines.findIndex((_, i) => fieldAt(i + 1) === field) + 1;
    return `- ${field}, line ${a.Line - first + 1}: ${a.Check}: ${a.Message}${a.Match ? ` ("${a.Match}")` : ''}`;
  };
  return {
    check: 'Vale',
    sections: [
      ...section('Vale', cfg.policy.valeErrors, alerts.filter((a) => a.Severity === 'error').map(describe)),
      ...section('Vale', cfg.policy.valeWarnings, alerts.filter((a) => a.Severity !== 'error').map(describe)),
    ],
    detail: { vale: alerts.map((a) => ({ rule: a.Check, severity: a.Severity })) },
  };
}

interface Classification { verdict: string; rationale?: string; clarifyingQuestions?: string[] }

export async function classifierCheck(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckReport> {
  const result = await ask('classifier', [...cfg.classifier, '-p', CARD_PROMPT, '-q', CARD_QUESTION, '-'], cardText(card), cfg.classifierTimeoutMs, [0], (out) => {
    const c = JSON.parse(out) as Classification;
    if (c.verdict !== 'COMPLETE' && c.verdict !== 'MISSING_CONTEXT') return undefined;
    if (c.rationale !== undefined && typeof c.rationale !== 'string') return undefined;
    if (c.clarifyingQuestions !== undefined && !isStrings(c.clarifyingQuestions)) return undefined;
    return c;
  }, run, signal);
  if ('skipped' in result) return { check: 'Card classifier', sections: [], skipped: result.skipped };
  const questions = result.clarifyingQuestions ?? [];
  const detail = { classifier: { verdict: result.verdict, rationale: result.rationale ?? '', questions } };
  if (result.verdict === 'COMPLETE') return { check: 'Card classifier', sections: [], detail };
  const why = `The card lacks context the person needs: ${result.rationale ?? ''}`.trim();
  return { check: 'Card classifier', sections: section('Card classifier', cfg.policy.classifierMissingContext, [why, ...questions.map((q) => `- ${q}`)]), detail };
}

const PR_TAG = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

interface PrVerdict { verdict: string; confidence_accept?: number; items?: { direction?: string; effect_label?: string; text?: string; action?: string | null }[] }

export async function prVerdictCheck(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckReport> {
  if (!cfg.prVerdict) return { check: 'PR verdict', sections: [], skipped: 'PR verdict is off: the local config names no command' };
  const m = PR_TAG.exec(card.tags?.['pr'] ?? '');
  if (!m) return { check: 'PR verdict', sections: [], skipped: 'PR verdict did not run: the card has no pr tag of the form owner/repo#number' };
  const [, owner, repo, number] = m;
  const pr = `${owner}/${repo}#${number}`;
  const { command, acceptVerdicts, timeoutMs } = cfg.prVerdict;
  const result = await ask('PR verdict', [...command, `https://github.com/${owner}/${repo}/pull/${number}`, '--json'], '', timeoutMs, 'any', (out) => {
    const v = JSON.parse(out) as PrVerdict;
    if (typeof v.verdict !== 'string') return undefined;
    if (v.confidence_accept !== undefined && typeof v.confidence_accept !== 'number') return undefined;
    if (v.items !== undefined && !(Array.isArray(v.items) && v.items.every((i) => typeof i === 'object' && i !== null))) return undefined;
    return v;
  }, run, signal);
  if ('skipped' in result) return { check: 'PR verdict', sections: [], skipped: result.skipped };
  const confidence = result.confidence_accept;
  const detail = { prVerdict: { pr, verdict: result.verdict, ...(confidence === undefined ? {} : { confidence }) } };
  if (acceptVerdicts.includes(result.verdict)) return { check: 'PR verdict', sections: [], detail };
  const level: Level = confidence === undefined || confidence < cfg.policy.prVerdictBlockBelow ? 'block' : 'advise';
  const lines = [
    `The PR-verdict command answered ${result.verdict} for ${pr}, not ${acceptVerdicts.join(' or ')}. Its confidence that the pull request merges as it stands is ${confidence === undefined ? 'unknown' : `${Math.round(confidence * 100)} in 100`}.`,
    ...(result.items ?? []).filter((i) => i.direction === 'toward_pushback').map((i) => `- ${i.action ?? i.text ?? ''}${i.effect_label ? ` (${i.effect_label})` : ''}`),
  ];
  return { check: 'PR verdict', sections: section('PR verdict', level, lines), detail };
}

/** Run all three checks at once. A check that cannot run, or that throws, reports why and finds nothing, and the
 * other two keep their findings. */
export async function runChecks(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckReport[]> {
  const guard = (check: CheckName, report: Promise<CheckReport>): Promise<CheckReport> =>
    report.catch((e: Error) => ({ check, sections: [], skipped: `${check} failed (${e.message})` }));
  return Promise.all([
    guard('Vale', valeCheck(card, cfg, run, signal)),
    guard('Card classifier', classifierCheck(card, cfg, run, signal)),
    guard('PR verdict', prVerdictCheck(card, cfg, run, signal)),
  ]);
}

/** The text of every section, check by check, the blocking findings of a check before its advice. */
function sectionsText(sections: Section[], as?: 'advise'): string {
  return sections.map((s) => `${s.check}, ${(as ?? s.level) === 'block' ? 'must fix' : 'advice'}:\n${s.lines.join('\n')}`).join('\n\n');
}

/** Cut the middle of a notice so its head and its tail fit what the inbox keeps. */
function fit(head: string, body: string, tail: string, max = 3900): string {
  const room = max - head.length - tail.length - 8;
  const cut = body.length > room ? `${body.slice(0, Math.max(0, room - 2))}\n…` : body;
  return [head, cut, tail].filter(Boolean).join('\n\n');
}

export interface CheckOptions { signal?: AbortSignal; run?: RunCommand; state?: TriageState }

/** Check a card and decide: return it with every finding, pass it with advice, or pass it. */
export async function checkCard(card: Card, cfg: ExampleConfig, log: (...a: unknown[]) => void, opts: CheckOptions = {}): Promise<Ruling> {
  const state = opts.state ?? new TriageState(undefined);
  // A state file it cannot write leaves the verdict alone, and the log says why the counts live in memory.
  const logWriteError = (): void => { const why = state.takeWriteError(); if (why) log(card.id, why); };
  let checks: LoggedCheck[] = [];
  let checksMs = 0;
  let bypass: RulingLine['bypass'];
  let note = '';
  // Every ruling goes out through `answer`, which appends its line first, so the line and the ruling cannot drift apart.
  const answer = (ruling: Ruling): Ruling => {
    const pr = card.tags?.['pr'];
    logRuling(cfg.logFile, {
      at: new Date().toISOString(),
      card: { id: card.id, agent: card.agent, title: card.title, tags: card.tags ?? {} },
      ...(pr !== undefined ? { pr } : {}),
      checks,
      verdict: ruling.verdict,
      reason: ruling.reason,
      ...(ruling.advice !== undefined ? { advice: ruling.advice } : {}),
      returns: { count: state.returnsOf(card), max: cfg.maxReturns },
      ...(bypass !== undefined ? { bypass } : {}),
      ms: checksMs,
    }, log);
    return ruling;
  };
  const code = card.tags?.[BYPASS_TAG];
  if (code) {
    const used = state.useBypass(code, card.agent, card.id);
    logWriteError();
    bypass = used.ok ? { used: true, issuedFor: used.issuedFor } : { used: false, why: used.why };
    if (used.ok) {
      log(card.id, `bypass used by agent ${card.agent} on card ${card.id}, with the code from card ${used.issuedFor}`);
      return answer({ verdict: 'pass', reason: 'Passed without checks: the agent used a triage bypass code for an urgent card.' });
    }
    log(card.id, `bypass refused for agent ${card.agent} on card ${card.id}: ${used.why}`);
    note = `The ${BYPASS_TAG} code on this card is not valid: ${used.why}, so triage checked the card.`;
  }
  const checksStarted = Date.now();
  const reports = await runChecks(card, cfg, opts.run ?? runCommand, opts.signal);
  checksMs = Date.now() - checksStarted;
  checks = reports.map((r) => ({
    name: r.check,
    sections: r.sections.map((s) => ({ level: s.level, lines: s.lines })),
    ...(r.skipped !== undefined ? { skipped: r.skipped } : {}),
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  }));
  for (const r of reports) if (r.skipped) log(card.id, `${r.skipped}, so this check found nothing.`);
  const sections = reports.flatMap((r) => r.sections);
  const blocking = sections.some((s) => s.level === 'block');
  if (opts.signal?.aborted) return answer({ verdict: 'pass', reason: 'The triage agent stopped, so the card went through.' });
  if (!sections.length) return answer({ verdict: 'pass', reason: note || 'Every check that ran passed the card.' });
  const chain = state.chainOf(card);
  if (blocking && state.returns(chain) < cfg.maxReturns) {
    const { returns, code: next } = state.recordReturn(chain, card);
    logWriteError();
    const head = [note, 'Triage sent this card back. Fix everything below in one revision, then post the card again.'].filter(Boolean).join('\n');
    const tail = [
      `This is return ${returns} of ${cfg.maxReturns}. After that, triage lets the card through and sends these findings as advice.`,
      `If the card is urgent, post it again with the tag \`${BYPASS_TAG}: ${next}\` to skip triage once.`,
    ].join('\n');
    return answer({ verdict: 'return', reason: fit(head, sectionsText(sections), tail) });
  }
  const advice = fit('Triage let this card through to the person, with this advice for it and the next cards:', sectionsText(sections, 'advise'), '');
  const reason = blocking ? `Passed after ${state.returns(chain)} returns, the most triage makes, with its findings as advice.` : 'Passed with advice for the agent.';
  return answer({ verdict: 'pass', reason: [note, reason].filter(Boolean).join(' '), advice });
}
