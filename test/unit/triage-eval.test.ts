// The dry-run eval of the example triage agent: it checks cards with the same three checks, and counts what each would
// block or advise, without sending a verdict or keeping any state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePrivate } from '../../src/node/home.ts';
import { describe, it } from 'node:test';
import { DEFAULTS, type CommandResult, type RunCommand } from '../../examples/triage-agent/checks.ts';
import { evaluate, parseWhen, renderReport, summarize } from '../../examples/triage-agent/eval-report.ts';
import type { Card } from '../../src/core/types.ts';

const base = { agent: 's1', kind: 'ask' as const, priority: 'soon' as const, deliver: 'stream' as const, version: 1, createdAt: 1, updatedAt: 1, replies: [] };
const cards: Card[] = [
  { ...base, id: 'a', title: 'I think we retry' },
  { ...base, id: 'b', title: 'Bump the TTL?', tags: { pr: 'acme/api#7' } },
  { ...base, id: 'c', title: 'Merge the export fix?', tags: { pr: 'acme/api#8' } },
];

/** Answers each command by its program name and the card it reads, the way the real commands would. */
const run: RunCommand = async (argv, input): Promise<CommandResult> => {
  const out = (v: unknown, code = 0): CommandResult => ({ code, stdout: JSON.stringify(v), stderr: '' });
  if (argv[0] === 'vale') {
    return input.includes('I think')
      ? out({ 'stdin.md': [{ Line: 1, Check: 'Cards.FirstPerson', Message: 'Third person.', Severity: 'error', Match: 'I' }, { Line: 1, Check: 'Cards.Hedges', Message: 'Hedge.', Severity: 'warning' }] }, 1)
      : out({ 'stdin.md': [] });
  }
  if (argv[0] === 'classifier') {
    return input.includes('TTL')
      ? out({ verdict: 'MISSING_CONTEXT', rationale: 'No TTL today.', clarifyingQuestions: ['[1] What is the TTL today?', '[4] What does No do?'] })
      : out({ verdict: 'COMPLETE', rationale: 'Fine.', clarifyingQuestions: [] });
  }
  return argv.some((a) => a.endsWith('/7'))
    ? out({ verdict: 'PUSHBACK', confidence_accept: 0.2, items: [{ direction: 'toward_pushback', effect_label: 'strong', text: 'No tests.', action: 'Add a test.' }] }, 1)
    : out({ verdict: 'PUSHBACK', confidence_accept: 0.7, items: [] }, 1);
};
const cfg = { ...DEFAULTS, vale: ['vale'], classifier: ['classifier'], prVerdict: { command: ['verdict'], acceptVerdicts: ['ACCEPT'], timeoutMs: 1000 } };

describe('the triage eval', () => {
  it('reads a bare date as local midnight for --since and --before alike, and a time as given', () => {
    assert.equal(parseWhen('2026-11-18')?.getTime(), new Date(2026, 10, 18).getTime());
    assert.equal(parseWhen('2026-11-18T00:00:50Z')?.toISOString(), '2026-11-18T00:00:50.000Z');
    assert.equal(parseWhen('soon'), undefined);
    assert.equal(parseWhen(''), undefined, 'an empty value, as from an unset shell variable, is not a time');
  });

  it('refuses to finish a run that was stopped, so no report counts the cut-short cards as clean', async () => {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(evaluate(cards, cfg, { run, signal: stop.signal }), /stopped before every card was checked/);
  });

  it('counts what each check would block and advise, and how many cards would go back', async () => {
    const results = await evaluate(cards, cfg, { run, concurrency: 2 });
    const s = summarize(results);
    assert.equal(s.checked, 3);
    assert.equal(s.wouldReturn, 2);
    assert.deepEqual(s.byCheck['Vale'], { block: 1, advise: 1, skipped: 0 });
    assert.deepEqual(s.byCheck['Card classifier'], { block: 1, advise: 0, skipped: 0 });
    assert.deepEqual(s.byCheck['PR verdict'], { block: 1, advise: 1, skipped: 1 });
    assert.deepEqual(s.valeRules, [['Cards.FirstPerson', 1], ['Cards.Hedges', 1]]);
    assert.deepEqual(s.classifierChecks, [['1', 1], ['4', 1]]);
    assert.deepEqual(s.prVerdicts.map((p) => [p.pr, p.verdict, p.confidence]), [['acme/api#7', 'PUSHBACK', 0.2], ['acme/api#8', 'PUSHBACK', 0.7]]);
  });

  it('writes a report with the counts and one line per example card', async () => {
    const results = await evaluate(cards, cfg, { run, concurrency: 1 });
    const text = renderReport(results, { since: new Date(0), ms: 1234, usageUsd: 0.12 });
    for (const part of ['Cards checked: 3', 'Would go back: 2', 'Cards.FirstPerson', '[1]', 'acme/api#7', '20 in 100', '1.2 s', '$0.12', 'Bump the TTL?']) assert.ok(text.includes(part), part);
  });

  it('gives the quartiles of the PR-verdict confidences by nearest rank', async () => {
    const four = ['10', '20', '30', '90'].map((c, i): Card => ({ ...base, id: `p${i}`, title: `PR ${i}`, tags: { pr: `acme/api#${c}` } }));
    const at: RunCommand = async (argv) => {
      if (argv[0] !== 'verdict') return { code: 0, stdout: JSON.stringify(argv[0] === 'vale' ? { 'stdin.md': [] } : { verdict: 'COMPLETE' }), stderr: '' };
      const n = Number(argv.find((a) => a.includes('/pull/'))?.split('/').pop());
      return { code: 1, stdout: JSON.stringify({ verdict: 'PUSHBACK', confidence_accept: n / 100, items: [] }), stderr: '' };
    };
    const text = renderReport(await evaluate(four, cfg, { run: at }), { since: new Date(0), ms: 1 });
    assert.match(text, /min 10, quartiles 10 \/ 20 \/ 30, max 90/);
  });

  it('leaves the report readable by its owner only, even when the file existed before', { skip: process.platform === 'win32' ? 'Windows has no file modes' : false }, () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ya-eval-')), 'report.md');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    writePrivate(file, 'card text');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
