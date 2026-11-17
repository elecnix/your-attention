// The example triage agent in examples/triage-agent. Every external command is a small Node script, so the tests run
// the real spawn path on Linux, macOS and Windows without vale, the classifier or a PR-verdict tool installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CARD_PROMPT, cardProse, cardText, checkCard, DEFAULTS, loadConfig, type ExampleConfig } from '../../examples/triage-agent/checks.ts';
import { runCardHook } from '../../src/extensions/card-hook.ts';
import type { Card } from '../../src/core/types.ts';

const card: Card = {
  id: 'c1', agent: 's1', kind: 'ask', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [],
  title: 'Retry the nightly export once before paging',
  text: 'The nightly export pages the on-call person on its first failure. This change retries it once after five minutes.',
  recommendation: 'Two of the last three pages cleared on their own within a minute.',
  options: [
    { label: 'Retry once', description: 'This agent adds the retry and opens a pull request.', recommended: true },
    { label: 'Keep paging', description: 'This agent closes the branch.' },
  ],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-triage-example-'));
let n = 0;
/** A command that records its arguments and stdin in `<name>.calls`, then runs `body`. */
function stub(name: string, body: string): { argv: string[]; calls: () => { argv: string[]; stdin: string }[] } {
  const file = path.join(dir, `${name}-${n++}.mjs`);
  const log = `${file}.calls`;
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    "const stdin = fs.readFileSync(0, 'utf8');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');`,
    body,
  ].join('\n'));
  return {
    argv: [process.execPath, file],
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : [],
  };
}
const print = (value: unknown, code = 0): string => `process.stdout.write(${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}); process.exit(${code});`;

const valeClean = (): ReturnType<typeof stub> => stub('vale', print({ 'stdin.md': [] }));
const complete = (): ReturnType<typeof stub> => stub('classifier', print({ verdict: 'COMPLETE', rationale: 'The card states the goal.', clarifyingQuestions: [] }));
const missing = '/nonexistent/command-for-this-test';

function config(over: Partial<ExampleConfig>): ExampleConfig {
  return { ...DEFAULTS, vale: valeClean().argv, classifier: complete().argv, ...over };
}
function logger(): { log: (...a: unknown[]) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (...a) => lines.push(a.map(String).join(' ')), lines };
}

describe('the example triage agent renders a card', () => {
  it('puts each prose field of the card in the document vale reads, and remembers which field each line came from', () => {
    const { doc, fieldAt } = cardProse({ ...card, questions: [{ question: 'Which branch?', options: [{ label: 'main', description: 'The default branch.' }] }] });
    for (const part of [card.title, card.text!, card.recommendation!, 'Retry once', 'This agent adds the retry', 'Which branch?', 'The default branch.']) assert.ok(doc.includes(part), part);
    const lines = doc.split('\n');
    assert.equal(fieldAt(lines.indexOf(card.title) + 1), 'title');
    assert.equal(fieldAt(lines.findIndex((l) => l.includes('Keep paging')) + 1), 'option 2 label');
    assert.equal(fieldAt(lines.indexOf('Which branch?') + 1), 'question 1 text');
  });

  it('writes the card as text for the classifier, with each option, what it does and the recommended one', () => {
    const text = cardText({ ...card, tags: { pr: 'acme/api#7' } });
    for (const part of [`Title: ${card.title}`, 'Retry once (recommended): This agent adds the retry', 'Keep paging: This agent closes the branch.', `Recommendation: ${card.recommendation}`, 'pr=acme/api#7']) assert.ok(text.includes(part), part);
  });
});

describe('the example triage agent checks a card', () => {
  it('passes a card when vale finds no error and the classifier says COMPLETE', async () => {
    const classifier = complete();
    const ruling = await checkCard(card, config({ classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'pass');
    const [call] = classifier.calls();
    assert.deepEqual(call?.argv.slice(0, 2), ['-p', CARD_PROMPT]);
    assert.equal(call?.argv.at(-1), '-');
    assert.ok(call?.stdin.includes(`Title: ${card.title}`));
  });

  it('returns a card with each vale error, its field and its rule, and ignores warnings', async () => {
    const vale = stub('vale', print({ 'stdin.md': [
      { Line: 1, Span: [1, 1], Check: 'Cards.FirstPerson', Message: "Write about this agent in the third person, not 'I'.", Severity: 'error', Match: 'I' },
      { Line: 3, Span: [5, 9], Check: 'Cards.Hedges', Message: "Say what you know instead of 'maybe'.", Severity: 'warning', Match: 'maybe' },
    ] }, 1));
    const classifier = complete();
    const ruling = await checkCard({ ...card, title: 'I retry the export' }, config({ vale: vale.argv, classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
    assert.match(ruling.reason, /title, line 1: Cards\.FirstPerson: Write about this agent in the third person, not 'I'\. \("I"\)/);
    assert.doesNotMatch(ruling.reason, /maybe/);
    assert.equal(classifier.calls().length, 0, 'a vale error returns the card before the classifier runs');
  });

  it('runs the classifier when vale reports only warnings', async () => {
    const vale = stub('vale', print({ 'stdin.md': [{ Line: 1, Span: [1, 5], Check: 'Cards.Hedges', Message: 'Hedge.', Severity: 'warning', Match: 'maybe' }] }));
    const classifier = complete();
    assert.equal((await checkCard(card, config({ vale: vale.argv, classifier: classifier.argv }), logger().log)).verdict, 'pass');
    assert.equal(classifier.calls().length, 1);
  });

  it('returns a card the classifier finds MISSING_CONTEXT, with its questions', async () => {
    const classifier = stub('classifier', print({
      verdict: 'MISSING_CONTEXT', rationale: 'The card never says what the export does today.',
      clarifyingQuestions: ['What does the nightly export do when it fails today?', 'What happens if the person picks Keep paging?'],
    }));
    const ruling = await checkCard(card, config({ classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
    for (const part of ['The card never says what the export does today.', '- What does the nightly export do when it fails today?', '- What happens if the person picks Keep paging?']) assert.ok(ruling.reason.includes(part), part);
  });
});

describe('the example triage agent fails open', () => {
  const cases: [string, () => Partial<ExampleConfig>, RegExp][] = [
    ['vale is not installed', () => ({ vale: [missing] }), /vale could not run/],
    ['vale prints something other than JSON', () => ({ vale: stub('vale', print('vale crashed')).argv }), /vale gave output it could not read/],
    ['vale exits with a runtime error', () => ({ vale: stub('vale', print('E100 no config', 2)).argv }), /vale exited with 2/],
    ['the classifier is not installed', () => ({ classifier: [missing] }), /classifier could not run/],
    ['the classifier finds no key', () => ({ classifier: stub('classifier', "process.stderr.write('error: config file not found'); process.exit(1);").argv }), /classifier exited with 1: error: config file not found/],
    ['the classifier takes too long', () => ({ classifier: stub('classifier', 'setTimeout(() => {}, 10_000);').argv, classifierTimeoutMs: 300 }), /classifier took longer than 300 ms/],
    ['the classifier prints something other than its JSON', () => ({ classifier: stub('classifier', print('VERDICT: maybe')).argv }), /classifier gave output it could not read/],
  ];
  for (const [what, over, why] of cases) {
    it(`passes the card and logs why when ${what}`, async () => {
      const { log, lines } = logger();
      const ruling = await checkCard(card, config(over()), log);
      assert.equal(ruling.verdict, 'pass');
      assert.match(lines.join('\n'), why);
    });
  }

  it('still runs the classifier when vale cannot run', async () => {
    const classifier = stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] }));
    const ruling = await checkCard(card, config({ vale: [missing], classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
  });
});

describe('the example triage agent asks a PR-verdict command about a pull request card', () => {
  const pr: Card = { ...card, tags: { pr: 'acme/api#42' } };
  const accept = { verdict: 'ACCEPT', confidence_accept: 0.81, items: [{ direction: 'toward_accept', effect: 0.2, effect_label: 'strong', text: 'Tests cover the change.', action: null }] };
  const pushback = {
    verdict: 'PUSHBACK', confidence_accept: 0.34,
    items: [
      { direction: 'toward_pushback', effect: -0.3, effect_label: 'strong', text: 'The body never says why.', action: 'Say why the retry is once and not three times.' },
      { direction: 'toward_pushback', effect: -0.1, effect_label: 'weak', text: 'CI is red on Windows.', action: null },
      { direction: 'toward_accept', effect: 0.2, effect_label: 'strong', text: 'Tests cover the change.', action: null },
    ],
  };
  const withVerdict = (argv: string[], over: Partial<NonNullable<ExampleConfig['prVerdict']>> = {}): Partial<ExampleConfig> => ({ prVerdict: { command: argv, acceptVerdicts: ['ACCEPT'], timeoutMs: 5_000, ...over } });

  it('skips the check when the local config names no command', async () => {
    const { log, lines } = logger();
    assert.equal((await checkCard(pr, config({}), log)).verdict, 'pass');
    assert.match(lines.join('\n'), /no PR-verdict command/);
  });

  it('skips the check on a card without a pr tag, and never runs the command', async () => {
    const verdict = stub('verdict', print(pushback));
    const { log, lines } = logger();
    assert.equal((await checkCard({ ...card, tags: { pr: 'not a pull request' } }, config(withVerdict(verdict.argv)), log)).verdict, 'pass');
    assert.equal(verdict.calls().length, 0);
    assert.match(lines.join('\n'), /no pr tag of the form owner\/repo#number/);
  });

  it('passes a card whose pull request the command calls ACCEPT, and asks with the URL and --json', async () => {
    const verdict = stub('verdict', print(accept));
    assert.equal((await checkCard(pr, config(withVerdict(verdict.argv)), logger().log)).verdict, 'pass');
    assert.deepEqual(verdict.calls()[0]?.argv, ['https://github.com/acme/api/pull/42', '--json']);
  });

  it('returns the card with the confidence and every reason that pushes back, each with its action or its text', async () => {
    const verdict = stub('verdict', print(pushback));
    const ruling = await checkCard(pr, config(withVerdict(verdict.argv)), logger().log);
    assert.equal(ruling.verdict, 'return');
    for (const part of ['PUSHBACK', '34 in 100', '- Say why the retry is once and not three times. (strong)', '- CI is red on Windows. (weak)']) assert.ok(ruling.reason.includes(part), part);
    assert.doesNotMatch(ruling.reason, /Tests cover the change/);
  });

  it('passes any verdict the local config lists as accepted', async () => {
    const verdict = stub('verdict', print({ ...pushback, verdict: 'LEAN_ACCEPT' }));
    assert.equal((await checkCard(pr, config(withVerdict(verdict.argv, { acceptVerdicts: ['ACCEPT', 'LEAN_ACCEPT'] })), logger().log)).verdict, 'pass');
  });

  it('runs after vale and the classifier, and only when both pass', async () => {
    const verdict = stub('verdict', print(pushback));
    const classifier = stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] }));
    const ruling = await checkCard(pr, config({ ...withVerdict(verdict.argv), classifier: classifier.argv }), logger().log);
    assert.match(ruling.reason, /What is the goal\?/);
    assert.equal(verdict.calls().length, 0);
  });

  const failures: [string, () => string[], RegExp, number?][] = [
    ['the command is not installed', () => [missing], /PR verdict could not run/],
    ['the command exits non-zero', () => stub('verdict', "process.stderr.write('GitHub answered 502'); process.exit(3);").argv, /PR verdict exited with 3: GitHub answered 502/],
    ['the command takes too long', () => stub('verdict', 'setTimeout(() => {}, 10_000);').argv, /PR verdict took longer than 300 ms/, 300],
    ['the command prints JSON without a verdict', () => stub('verdict', print({ items: [] })).argv, /PR verdict gave output it could not read/],
    ['the command prints something other than JSON', () => stub('verdict', print('Likely to merge')).argv, /PR verdict gave output it could not read/],
  ];
  for (const [what, argv, why, timeoutMs] of failures) {
    it(`passes the card and logs why when ${what}`, async () => {
      const { log, lines } = logger();
      assert.equal((await checkCard(pr, config(withVerdict(argv(), timeoutMs ? { timeoutMs } : {})), log)).verdict, 'pass');
      assert.match(lines.join('\n'), why);
    });
  }
});

describe('the example triage agent reads its local config', () => {
  it('uses the defaults, with no PR-verdict command, when the file does not exist', () => {
    const cfg = loadConfig(path.join(dir, 'absent.json'));
    assert.deepEqual(cfg.vale, ['vale']);
    assert.deepEqual(cfg.classifier, ['pr-context-classifier']);
    assert.equal(cfg.prVerdict, undefined);
  });

  it('reads a PR-verdict command and fills in the accepted verdicts and the timeout', () => {
    const file = path.join(dir, 'triage-example.json');
    fs.writeFileSync(file, JSON.stringify({ prVerdict: { command: ['/opt/verdict', 'predict'] } }));
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.prVerdict, { command: ['/opt/verdict', 'predict'], acceptVerdicts: ['ACCEPT'], timeoutMs: 300_000 });
  });

  it('refuses a config whose commands are not lists of strings, and names the file', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ vale: 'vale --config x' }));
    assert.throws(() => loadConfig(file), (e: Error) => e.message.includes(file) && /vale must be a list of strings/.test(e.message));
  });

  it('ships a sample config that loads, with a placeholder command', () => {
    const cfg = loadConfig(path.join(import.meta.dirname, '../../examples/triage-agent/triage-example.sample.json'));
    assert.match(cfg.prVerdict?.command[0] ?? '', /^\/path\/to\//);
  });

  it('ships a card prompt with a text fence that asks for the classifier\'s reply format', () => {
    const fence = /```text\n([\s\S]*?)\n```/.exec(fs.readFileSync(CARD_PROMPT, 'utf8'))?.[1] ?? '';
    for (const part of ['VERDICT: COMPLETE | MISSING_CONTEXT', 'RATIONALE:', 'CLARIFYING_QUESTIONS:', 'recommendation', 'what this agent does']) assert.ok(fence.includes(part), part);
  });
});

describe('the example vale config', () => {
  const hasVale = ((): boolean => { try { execFileSync('vale', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it('returns a card whose prose breaks a rule, with the vale on this machine and no styles to download', { skip: hasVale ? false : 'vale is not installed' }, async () => {
    const ruling = await checkCard({ ...card, title: 'I think we should retry the export', text: 'TODO: explain the the failure.' }, { ...DEFAULTS, classifier: [missing] }, logger().log);
    assert.equal(ruling.verdict, 'return');
    for (const part of ['Cards.FirstPerson', 'Cards.Placeholders', 'Cards.Repetition']) assert.ok(ruling.reason.includes(part), part);
  });
});

describe('the card.created hook runner', () => {
  it('sends the check\'s verdict for each card, and passes the card when the check throws', async () => {
    const event = (id: string): string => `data: ${JSON.stringify({ type: 'hook', version: 1, id, hook: 'card.created', card, deadline: Date.now() + 60_000, person: { pages: 0, visible: false, activeAt: null } })}\n\n`;
    const verdicts: { route: string; body: unknown }[] = [];
    const stop = new AbortController();
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const route = new URL(String(url)).pathname;
      if (route === '/v1/extensions/stream') {
        assert.match(String(url), /name=triage-example/);
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event('h1') + event('h2'))); } }));
      }
      verdicts.push({ route, body: JSON.parse(String(init?.body)) });
      if (verdicts.length === 2) stop.abort();
      return Response.json({ ok: true });
    }) as typeof fetch;
    let calls = 0;
    await runCardHook({ url: 'http://inbox.test', token: 't', name: 'triage-example', fetcher, log: () => {} }, async () => {
      if (++calls === 2) throw new Error('boom');
      return { verdict: 'return', reason: 'No goal.' };
    }, stop.signal);
    assert.deepEqual(verdicts.find((v) => v.route === '/v1/hooks/h1')?.body, { verdict: 'return', reason: 'No goal.' });
    assert.match((verdicts.find((v) => v.route === '/v1/hooks/h2')?.body as { reason: string }).reason, /failed \(boom\), so the card went through/);
  });
});
