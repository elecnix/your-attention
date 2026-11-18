// The dry run behind eval.ts: check cards with the same three checks the agent runs, and count what each check would
// block or advise. It sends no verdict and keeps no state, so it never changes the inbox or the agent's return counts.
import type { Card } from '../../src/core/types.ts';
import { limiter } from '../../src/extensions/card-hook.ts';
import { runChecks, runCommand, type CheckName, type CheckReport, type ExampleConfig, type RunCommand } from './checks.ts';

const CHECKS: CheckName[] = ['Vale', 'Card classifier', 'PR verdict'];

/** A time for --since or --before: a date alone means its midnight in local time, and anything else goes to Date. */
export function parseWhen(value: string): Date | undefined {
  const when = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(when.getTime()) ? undefined : when;
}

export interface CardResult { card: Card; ms: number; reports: CheckReport[]; blockedBy: CheckName[]; advisedBy: CheckName[] }

export async function evaluate(cards: Card[], cfg: ExampleConfig, opts: { run?: RunCommand; concurrency?: number; signal?: AbortSignal } = {}): Promise<CardResult[]> {
  const limit = limiter(opts.concurrency ?? 3);
  return Promise.all(cards.map((card) => limit(async () => {
    const started = Date.now();
    const reports = await runChecks(card, cfg, opts.run ?? runCommand, opts.signal);
    const by = (level: 'block' | 'advise'): CheckName[] => CHECKS.filter((c) => reports.some((r) => r.check === c && r.sections.some((s) => s.level === level)));
    return { card, ms: Date.now() - started, reports, blockedBy: by('block'), advisedBy: by('advise') };
  })));
}

const tally = (items: string[]): [string, number][] => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

export function summarize(results: CardResult[]) {
  const report = (r: CardResult, c: CheckName): CheckReport | undefined => r.reports.find((x) => x.check === c);
  const byCheck = Object.fromEntries(CHECKS.map((c) => [c, {
    block: results.filter((r) => r.blockedBy.includes(c)).length,
    advise: results.filter((r) => r.advisedBy.includes(c)).length,
    skipped: results.filter((r) => report(r, c)?.skipped).length,
  }])) as Record<CheckName, { block: number; advise: number; skipped: number }>;
  const details = results.flatMap((r) => r.reports.map((x) => x.detail ?? {}));
  return {
    checked: results.length,
    wouldReturn: results.filter((r) => r.blockedBy.length).length,
    byCheck,
    skippedReasons: tally(results.flatMap((r) => r.reports.filter((x) => x.skipped).map((x) => (x.skipped ?? '').replace(/:.*$/s, '')))),
    valeRules: tally(details.flatMap((d) => (d.vale ?? []).map((a) => a.rule))),
    classifierVerdicts: tally(details.flatMap((d) => d.classifier ? [d.classifier.verdict] : [])),
    // The card prompt asks the classifier to start each question with the number of the check it failed, as [4].
    classifierChecks: tally(details.flatMap((d) => (d.classifier?.questions ?? []).map((q) => /^\[(\d+)\]/.exec(q.trim())?.[1] ?? 'none'))),
    prVerdicts: details.flatMap((d) => d.prVerdict ? [d.prVerdict] : []),
  };
}

/** The line a person reads first about why a card would go back. */
function oneLine(r: CardResult): string {
  const first = r.reports.flatMap((x) => x.sections).sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1))[0];
  return (first?.lines[0] ?? '').replace(/^- /, '').replace(/\s+/g, ' ').slice(0, 200);
}

const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : '-');

export function renderReport(results: CardResult[], meta: { since: Date; ms: number; usageUsd?: number }): string {
  const s = summarize(results);
  const confidences = s.prVerdicts.map((p) => p.confidence).filter((c): c is number => c !== undefined).sort((a, b) => a - b);
  // Nearest rank: the smallest value with at least q of the values at or below it.
  const at = (q: number): string => confidences.length ? `${Math.round((confidences[Math.max(0, Math.ceil(q * confidences.length) - 1)] ?? 0) * 100)}` : '-';
  const examples = [...results.filter((r) => r.blockedBy.length), ...results.filter((r) => !r.blockedBy.length && r.advisedBy.length)].slice(0, 15);
  return [
    `# Triage eval of the cards posted since ${meta.since.toISOString()}`,
    '',
    `Cards checked: ${s.checked}. Would go back: ${s.wouldReturn} (${pct(s.wouldReturn, s.checked)}). Run time: ${(meta.ms / 1000).toFixed(1)} s. ` +
      `OpenRouter spend: ${meta.usageUsd === undefined ? 'not measured' : `$${meta.usageUsd.toFixed(2)}`}.`,
    '',
    '| Check | Would block | Would advise | Could not run |',
    '| -- | -- | -- | -- |',
    ...CHECKS.map((c) => `| ${c} | ${s.byCheck[c].block} | ${s.byCheck[c].advise} | ${s.byCheck[c].skipped} |`),
    '',
    '## Why a check could not run',
    ...(s.skippedReasons.length ? s.skippedReasons.map(([why, n]) => `- ${n} × ${why}`) : ['- every check ran']),
    '',
    '## Vale rules',
    ...(s.valeRules.length ? s.valeRules.map(([rule, n]) => `- ${rule}: ${n}`) : ['- none']),
    '',
    '## Card classifier',
    `Verdicts: ${s.classifierVerdicts.map(([v, n]) => `${v} ${n}`).join(', ') || 'none'}.`,
    'Questions by the card prompt check they come from:',
    ...(s.classifierChecks.length ? s.classifierChecks.map(([check, n]) => `- [${check}]: ${n}`) : ['- none']),
    '',
    '## PR verdict',
    ...(s.prVerdicts.length ? s.prVerdicts.map((p) => `- ${p.pr}: ${p.verdict}, confidence ${p.confidence === undefined ? 'unknown' : `${Math.round(p.confidence * 100)} in 100`}`) : ['- no card with a pr tag got a verdict']),
    `Confidence spread, in 100: min ${at(0)}, quartiles ${at(0.25)} / ${at(0.5)} / ${at(0.75)}, max ${at(1)}.`,
    '',
    '## Examples',
    '| Card | Title | Blocked by | Advised by | First finding | False rejection? |',
    '| -- | -- | -- | -- | -- | -- |',
    ...examples.map((r) => `| ${r.card.id} | ${r.card.title.replace(/\|/g, '/')} | ${r.blockedBy.join(', ') || '-'} | ${r.advisedBy.join(', ') || '-'} | ${oneLine(r).replace(/\|/g, '/')} | |`),
    '',
  ].join('\n');
}
