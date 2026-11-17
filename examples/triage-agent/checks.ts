// The checks of the example triage agent, in the order it runs them:
//   1. vale, on the card's prose, with the rules in ./vale. An error returns the card with each finding.
//   2. pr-context-classifier, with the card prompt in ./card-prompt.md. MISSING_CONTEXT returns the card with the
//      classifier's questions.
//   3. an optional PR-verdict command, named only in your local config, on a card tagged pr: owner/repo#number. A
//      verdict outside the accepted list returns the card with the reasons the command gives.
// The cheapest check runs first, and the first check that returns the card ends the run, so a card with a typo
// never costs a model call. Every check fails open: when a command is missing, exits with an error, runs out of
// time or prints something unreadable, that check passes the card, logs why, and the next check still runs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Card } from '../../src/core/types.ts';
import type { Ruling } from '../../src/extensions/card-hook.ts';

export const VALE_INI = path.join(import.meta.dirname, 'vale', '.vale.ini');
export const CARD_PROMPT = path.join(import.meta.dirname, 'card-prompt.md');
export const CARD_QUESTION = 'Can the person make the decision this card asks for from the card alone, without opening the agent\'s session, its code or its diff?';

export interface PrVerdictConfig {
  /** The command and its first arguments. The check appends the pull request's URL and --json. */
  command: string[];
  /** The verdicts that pass the card. Any other verdict returns it. */
  acceptVerdicts: string[];
  timeoutMs: number;
}

export interface ExampleConfig {
  /** Each command is a list: the program, then its arguments. The check appends its own arguments after them. */
  vale: string[];
  classifier: string[];
  valeTimeoutMs: number;
  classifierTimeoutMs: number;
  prVerdict?: PrVerdictConfig;
}

export const DEFAULTS: ExampleConfig = { vale: ['vale'], classifier: ['pr-context-classifier'], valeTimeoutMs: 30_000, classifierTimeoutMs: 150_000 };
const PR_VERDICT_DEFAULTS = { acceptVerdicts: ['ACCEPT'], timeoutMs: 300_000 };

export function defaultConfigPath(): string {
  return process.env['YOUR_ATTENTION_TRIAGE_EXAMPLE_CONFIG'] ?? path.join(os.homedir(), '.config', 'your-attention', 'triage-example.json');
}

/** The local config, over the defaults. A missing file gives the defaults, which have no PR-verdict command. */
export function loadConfig(file = defaultConfigPath()): ExampleConfig {
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  const bad = (what: string): never => { throw new Error(`${file}: ${what}`); };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return bad(`not readable JSON (${(e as Error).message})`);
  }
  const strings = (name: string, v: unknown): string[] =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string') ? v : bad(`${name} must be a list of strings, such as ["vale"]`);
  const ms = (name: string, v: unknown): number => typeof v === 'number' && v > 0 ? v : bad(`${name} must be a positive number of milliseconds`);
  const cfg: ExampleConfig = { ...DEFAULTS };
  if (raw['vale'] !== undefined) cfg.vale = strings('vale', raw['vale']);
  if (raw['classifier'] !== undefined) cfg.classifier = strings('classifier', raw['classifier']);
  if (raw['valeTimeoutMs'] !== undefined) cfg.valeTimeoutMs = ms('valeTimeoutMs', raw['valeTimeoutMs']);
  if (raw['classifierTimeoutMs'] !== undefined) cfg.classifierTimeoutMs = ms('classifierTimeoutMs', raw['classifierTimeoutMs']);
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

/** How long the inbox waits for this agent: every check at its full timeout, and ten seconds to spare. */
export function hookTimeoutMs(cfg: ExampleConfig): number {
  return Math.min(cfg.valeTimeoutMs + cfg.classifierTimeoutMs + (cfg.prVerdict?.timeoutMs ?? 0) + 10_000, 600_000);
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

/** Run a command with `input` on stdin. Rejects when it cannot start, runs past `timeoutMs`, or `signal` aborts, and
 * kills the command in the last two cases, so a stopping agent leaves no check running. */
export const runCommand: RunCommand = (argv, input, timeoutMs, signal) => new Promise((resolve, reject) => {
  const [program, ...args] = argv;
  if (!program) { reject(new Error('the command is empty')); return; }
  if (signal?.aborted) { reject(new Error(STOPPED)); return; }
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const stop = (why: string): void => { child.kill(); done(); reject(new Error(why)); };
  const onAbort = (): void => stop(STOPPED);
  const timer = setTimeout(() => stop(`took longer than ${timeoutMs} ms`), timeoutMs);
  const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.on('error', (e) => { done(); reject(new Error(`could not run (${e.message})`)); });
  child.on('close', (code) => { done(); resolve({ code, stdout, stderr }); });
  // A command that exits without reading its input closes the pipe: its exit code is the answer, not EPIPE.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

/** What one check decided: a verdict, or nothing because it could not run. */
type CheckOutcome = Ruling | { skipped: string };

/** Run one command and read its output. Anything that goes wrong becomes a reason to skip the check. */
async function ask<T>(label: string, argv: string[], input: string, timeoutMs: number, okCodes: number[], read: (stdout: string) => T | undefined, run: RunCommand, signal?: AbortSignal): Promise<T | { skipped: string }> {
  let res: CommandResult;
  try {
    res = await run(argv, input, timeoutMs, signal);
  } catch (e) {
    return { skipped: `${label} ${(e as Error).message}` };
  }
  if (res.code === null || !okCodes.includes(res.code)) return { skipped: `${label} exited with ${res.code}: ${res.stderr.trim().slice(0, 300)}` };
  let value: T | undefined;
  try {
    value = read(res.stdout);
  } catch {
    value = undefined;
  }
  return value === undefined ? { skipped: `${label} gave output it could not read: ${res.stdout.trim().slice(0, 200)}` } : value;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

interface ValeAlert { Line: number; Check: string; Message: string; Severity: string; Match?: string }

export async function valeCheck(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckOutcome> {
  const { doc, fieldAt } = cardProse(card);
  // Vale exits 1 when it finds an error, and still prints its JSON.
  const alerts = await ask('vale', [...cfg.vale, '--no-global', '--config', VALE_INI, '--output=JSON', '--ext=.md'], doc, cfg.valeTimeoutMs, [0, 1], (out) => {
    const parsed = JSON.parse(out) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return Object.values(parsed as Record<string, ValeAlert[]>).flat();
  }, run, signal);
  if ('skipped' in alerts) return alerts;
  const errors = alerts.filter((a) => a.Severity === 'error');
  if (!errors.length) return { verdict: 'pass', reason: 'vale found no error.' };
  const lines = doc.split('\n');
  const findings = errors.map((a) => {
    const field = fieldAt(a.Line);
    const first = lines.findIndex((_, i) => fieldAt(i + 1) === field) + 1;
    return `- ${field}, line ${a.Line - first + 1}: ${a.Check}: ${a.Message}${a.Match ? ` ("${a.Match}")` : ''}`;
  });
  return { verdict: 'return', reason: `vale found ${errors.length === 1 ? 'an error' : `${errors.length} errors`} in the card's prose. Fix each one and post the card again:\n${findings.join('\n')}` };
}

interface Classification { verdict: string; rationale?: string; clarifyingQuestions?: string[] }

export async function classifierCheck(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckOutcome> {
  const result = await ask('classifier', [...cfg.classifier, '-p', CARD_PROMPT, '-q', CARD_QUESTION, '-'], cardText(card), cfg.classifierTimeoutMs, [0], (out) => {
    const c = JSON.parse(out) as Classification;
    if (c.verdict !== 'COMPLETE' && c.verdict !== 'MISSING_CONTEXT') return undefined;
    if (c.rationale !== undefined && typeof c.rationale !== 'string') return undefined;
    if (c.clarifyingQuestions !== undefined && !isStrings(c.clarifyingQuestions)) return undefined;
    return c;
  }, run, signal);
  if ('skipped' in result) return result;
  if (result.verdict === 'COMPLETE') return { verdict: 'pass', reason: result.rationale ?? 'The classifier found the card complete.' };
  const questions = (result.clarifyingQuestions ?? []).map((q) => `- ${q}`);
  return { verdict: 'return', reason: [`The card lacks context the person needs: ${result.rationale ?? ''}`.trim(), ...(questions.length ? ['Answer these on the card:', ...questions] : [])].join('\n') };
}

const PR_TAG = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

interface PrVerdict { verdict: string; confidence_accept?: number; items?: { direction?: string; effect_label?: string; text?: string; action?: string | null }[] }

export async function prVerdictCheck(card: Card, cfg: ExampleConfig, run: RunCommand = runCommand, signal?: AbortSignal): Promise<CheckOutcome> {
  if (!cfg.prVerdict) return { skipped: 'PR verdict is off: the local config names no command' };
  const m = PR_TAG.exec(card.tags?.['pr'] ?? '');
  if (!m) return { skipped: 'PR verdict did not run: the card has no pr tag of the form owner/repo#number' };
  const [, owner, repo, number] = m;
  const { command, acceptVerdicts, timeoutMs } = cfg.prVerdict;
  const result = await ask('PR verdict', [...command, `https://github.com/${owner}/${repo}/pull/${number}`, '--json'], '', timeoutMs, [0], (out) => {
    const v = JSON.parse(out) as PrVerdict;
    if (typeof v.verdict !== 'string') return undefined;
    if (v.confidence_accept !== undefined && typeof v.confidence_accept !== 'number') return undefined;
    if (v.items !== undefined && !(Array.isArray(v.items) && v.items.every((i) => typeof i === 'object' && i !== null))) return undefined;
    return v;
  }, run, signal);
  if ('skipped' in result) return result;
  if (acceptVerdicts.includes(result.verdict)) return { verdict: 'pass', reason: `The PR-verdict command answered ${result.verdict}.` };
  const confidence = typeof result.confidence_accept === 'number' ? `${Math.round(result.confidence_accept * 100)} in 100` : 'unknown';
  const reasons = (result.items ?? []).filter((i) => i.direction === 'toward_pushback')
    .map((i) => `- ${i.action ?? i.text ?? ''}${i.effect_label ? ` (${i.effect_label})` : ''}`);
  return {
    verdict: 'return',
    reason: [`The PR-verdict command answered ${result.verdict} for ${owner}/${repo}#${number}, not ${acceptVerdicts.join(' or ')}. Its confidence that the pull request merges as it stands is ${confidence}.`,
      ...(reasons.length ? ['Address these before you ask the person to merge:', ...reasons] : [])].join('\n'),
  };
}

/** Run the checks in order. The first one that returns the card decides, and a check that cannot run passes. */
export async function checkCard(card: Card, cfg: ExampleConfig, log: (...a: unknown[]) => void, signal?: AbortSignal, run: RunCommand = runCommand): Promise<Ruling> {
  const passed: string[] = [];
  for (const check of [valeCheck, classifierCheck, prVerdictCheck]) {
    if (signal?.aborted) break;
    const outcome = await check(card, cfg, run, signal);
    if ('skipped' in outcome) {
      log(card.id, `${outcome.skipped}, so this check passed the card.`);
      continue;
    }
    if (outcome.verdict === 'return') return outcome;
    passed.push(outcome.reason);
  }
  return { verdict: 'pass', reason: passed.join(' ') || 'No check could run, so the card went through.' };
}
