// The example triage agent in examples/triage-agent. Every external command is a small Node script, so the tests run
// the real spawn path on Linux, macOS and Windows without vale, the classifier or a PR-verdict tool installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BYPASS_TAG, CARD_PROMPT, CARD_QUESTION, cardProse, cardText, checkCard, DEFAULTS, loadConfig, runCommand, type ExampleConfig, type RunCommand } from '../../examples/triage-agent/checks.ts';
import { TriageState } from '../../examples/triage-agent/state.ts';
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

/** A test that `card` passes, and that the log says `why`, when the config from `over` breaks a check. */
function itFailsOpen(what: string, card: Card, over: () => Partial<ExampleConfig>, why: RegExp): void {
  it(`passes the card and logs why when ${what}`, async () => {
    const { log, lines } = logger();
    assert.equal((await checkCard(card, config(over()), log)).verdict, 'pass');
    assert.match(lines.join('\n'), why);
  });
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

  it('writes the card\'s approvals for the classifier, each with its label and the words it sends', () => {
    const text = cardText({ ...card, approvals: [{ pane: 'w1:p2', label: 'Restart the watcher', text: 'Restart the watcher with the bot on.' }] });
    assert.ok(text.includes('Approvals:\n- Restart the watcher: "Restart the watcher with the bot on."'), text);
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

  it('returns a card with each vale error, its field and its rule, and gives warnings as advice in the same notice', async () => {
    const vale = stub('vale', print({ 'stdin.md': [
      { Line: 1, Span: [1, 1], Check: 'Cards.FirstPerson', Message: "Write about this agent in the third person, not 'I'.", Severity: 'error', Match: 'I' },
      { Line: 3, Span: [5, 9], Check: 'Cards.Hedges', Message: "Say what you know instead of 'maybe'.", Severity: 'warning', Match: 'maybe' },
    ] }, 1));
    const classifier = complete();
    const ruling = await checkCard({ ...card, title: 'I retry the export' }, config({ vale: vale.argv, classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
    assert.match(ruling.reason, /title, line 1: Cards\.FirstPerson: Write about this agent in the third person, not 'I'\. \("I"\)/);
    assert.match(ruling.reason, /Vale, advice:\n- text, line 1: Cards\.Hedges/);
    assert.equal(classifier.calls().length, 1, 'a vale error does not stop the classifier');
  });

  it('drops a first-person finding in an option label, which speaks in the person\'s voice, and keeps it elsewhere', async () => {
    const two = { ...card, title: 'Retry the export', text: 'We retry it once.', options: [{ label: "I'll handle it", description: 'This agent stops.' }, { label: 'Retry', description: 'I retry.' }] };
    const { doc, fieldAt } = cardProse(two);
    const lines = doc.split('\n');
    const at = (field: string): number => lines.findIndex((_, i) => fieldAt(i + 1) === field) + 1;
    const vale = stub('vale', print({ 'stdin.md': [
      { Line: at('text'), Span: [1, 2], Check: 'Cards.FirstPerson', Message: "Not 'We'.", Severity: 'error', Match: 'We' },
      { Line: at('option 1 label'), Span: [1, 1], Check: 'Cards.FirstPerson', Message: "Not 'I'll'.", Severity: 'error', Match: "I'll" },
      { Line: at('option 2 description'), Span: [1, 1], Check: 'Cards.FirstPerson', Message: "Not 'I'.", Severity: 'error', Match: 'I' },
    ] }, 1));
    const ruling = await checkCard(two, config({ vale: vale.argv }), logger().log);
    assert.match(ruling.reason, /- text, line 1: Cards\.FirstPerson/);
    assert.match(ruling.reason, /- option 2 description, line 1: Cards\.FirstPerson/);
    assert.doesNotMatch(ruling.reason, /option 1 label/);
  });

  it('passes a card with only vale warnings, and sends the warnings to the agent as advice', async () => {
    const vale = stub('vale', print({ 'stdin.md': [{ Line: 1, Span: [1, 5], Check: 'Cards.Hedges', Message: 'Hedge.', Severity: 'warning', Match: 'maybe' }] }));
    const ruling = await checkCard(card, config({ vale: vale.argv }), logger().log);
    assert.equal(ruling.verdict, 'pass');
    assert.match(ruling.advice ?? '', /Vale, advice:\n- title, line 1: Cards\.Hedges: Hedge\./);
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
    ['vale lists an alert that is not an object', () => ({ vale: stub('vale', print({ 'stdin.md': [null] }, 1)).argv }), /vale gave output it could not read/],
    ['the classifier is not installed', () => ({ classifier: [missing] }), /classifier could not run/],
    ['the classifier finds no key', () => ({ classifier: stub('classifier', "process.stderr.write('error: config file not found'); process.exit(1);").argv }), /classifier exited with 1: error: config file not found/],
    ['the classifier takes too long', () => ({ classifier: stub('classifier', 'setTimeout(() => {}, 10_000);').argv, classifierTimeoutMs: 300 }), /classifier took longer than 300 ms/],
    ['the classifier prints something other than its JSON', () => ({ classifier: stub('classifier', print('VERDICT: maybe')).argv }), /classifier gave output it could not read/],
    ['the classifier prints without end', () => ({ classifier: stub('classifier', "const s = 'x'.repeat(65536); const w = () => process.stdout.write(s, w); w();").argv, classifierTimeoutMs: 20_000 }), /classifier printed more than \d+ bytes/],
    ['the classifier gives its questions as a string',() => ({ classifier: stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: 'Which branch?' })).argv }), /classifier gave output it could not read/],
  ];
  for (const [what, over, why] of cases) itFailsOpen(what, card, over, why);

  it('keeps the other checks\' findings when one check throws', async () => {
    const classifier = stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] }));
    const run: RunCommand = async (argv, input, timeoutMs, signal) => {
      if (argv[0] === 'vale-that-throws') throw Object.assign(new Error('boom'), { thrownByTest: true });
      return runCommand(argv, input, timeoutMs, signal);
    };
    const { log, lines } = logger();
    const ruling = await checkCard(card, config({ vale: ['vale-that-throws'], classifier: classifier.argv }), log, { run });
    assert.equal(ruling.verdict, 'return');
    assert.match(lines.join('\n'), /vale/);
  });

  it('still runs the classifier when vale cannot run', async () => {
    const classifier = stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] }));
    const ruling = await checkCard(card, config({ vale: [missing], classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
  });
});

describe('the example triage agent stops', () => {
  it('kills a running command when the agent stops, and passes the card without waiting for the timeout', async () => {
    const stop = new AbortController();
    const classifier = stub('classifier', 'setTimeout(() => {}, 30_000);');
    const { log, lines } = logger();
    const started = Date.now();
    setTimeout(() => stop.abort(), 200);
    const ruling = await checkCard(card, config({ classifier: classifier.argv, classifierTimeoutMs: 30_000 }), log, { signal: stop.signal });
    assert.equal(ruling.verdict, 'pass');
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.match(lines.join('\n'), /classifier stopped because the agent is shutting down/);
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
    assert.match(lines.join('\n'), /PR verdict is off: the local config names no command/);
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

  it('returns the card, below the confidence threshold, with the confidence and every reason that pushes back', async () => {
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

  it('passes the card with the reasons as advice when the confidence is at or above the threshold', async () => {
    const verdict = stub('verdict', print({ ...pushback, confidence_accept: 0.6 }));
    const ruling = await checkCard(pr, config(withVerdict(verdict.argv)), logger().log);
    assert.equal(ruling.verdict, 'pass');
    assert.match(ruling.advice ?? '', /PR verdict, advice:[\s\S]*60 in 100[\s\S]*Say why the retry is once/);
  });

  it('reads a pushback the command reports with exit code 1', async () => {
    const verdict = stub('verdict', print(pushback, 1));
    assert.equal((await checkCard(pr, config(withVerdict(verdict.argv)), logger().log)).verdict, 'return');
  });

  it('runs every check, and puts the findings of all three in one notice', async () => {
    const verdict = stub('verdict', print(pushback));
    const vale = stub('vale', print({ 'stdin.md': [{ Line: 1, Span: [1, 1], Check: 'Cards.FirstPerson', Message: 'Third person.', Severity: 'error', Match: 'I' }] }, 1));
    const classifier = stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] }));
    const ruling = await checkCard(pr, config({ ...withVerdict(verdict.argv), vale: vale.argv, classifier: classifier.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
    assert.equal(verdict.calls().length, 1);
    const at = (part: string): number => ruling.reason.indexOf(part);
    for (const part of ['Vale, must fix:', 'Card classifier, must fix:', 'PR verdict, must fix:']) assert.ok(at(part) >= 0, part);
    assert.ok(at('Vale, must fix:') < at('Card classifier, must fix:') && at('Card classifier, must fix:') < at('PR verdict, must fix:'));
  });

  const failures: [string, () => string[], RegExp, number?][] = [
    ['the command is not installed', () => [missing], /PR verdict could not run/],
    ['the command exits non-zero', () => stub('verdict', "process.stderr.write('GitHub answered 502'); process.exit(3);").argv, /PR verdict exited with 3: GitHub answered 502/],
    ['the command takes too long', () => stub('verdict', 'setTimeout(() => {}, 10_000);').argv, /PR verdict took longer than 300 ms/, 300],
    ['the command prints JSON without a verdict', () => stub('verdict', print({ items: [] })).argv, /PR verdict gave output it could not read/],
    ['the command prints something other than JSON', () => stub('verdict', print('Likely to merge')).argv, /PR verdict gave output it could not read/],
    ['the command gives items that are not a list', () => stub('verdict', print({ verdict: 'PUSHBACK', items: 'CI is red.' })).argv, /PR verdict gave output it could not read/],
  ];
  for (const [what, argv, why, timeoutMs] of failures) itFailsOpen(what, pr, () => withVerdict(argv(), timeoutMs ? { timeoutMs } : {}), why);
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

  it('reads the policy, and fills in the parts it leaves out', () => {
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ policy: { classifierMissingContext: 'advise', prVerdictBlockBelow: 0.3 }, maxReturns: 5 }));
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.policy, { valeErrors: 'block', valeWarnings: 'advise', classifierMissingContext: 'advise', prVerdictBlockBelow: 0.3 });
    assert.equal(cfg.maxReturns, 5);
  });

  it('refuses an empty config path, such as --config "$CFG" with CFG unset', () => {
    assert.throws(() => loadConfig(''), /--config needs a file path/);
  });

  it('refuses a config file that is JSON but not an object, and names the file', () => {
    const file = path.join(dir, 'null.json');
    fs.writeFileSync(file, 'null');
    assert.throws(() => loadConfig(file), (e: Error) => e.message.includes(file) && /must be a JSON object/.test(e.message));
  });

  it('refuses a check timeout the inbox would not wait for', () => {
    const file = path.join(dir, 'long-timeout.json');
    fs.writeFileSync(file, JSON.stringify({ classifierTimeoutMs: 900_000 }));
    assert.throws(() => loadConfig(file), /classifierTimeoutMs must be at most 590000/);
  });

  it('refuses a policy level other than block, advise or ignore', () => {
    const file = path.join(dir, 'bad-policy.json');
    fs.writeFileSync(file, JSON.stringify({ policy: { valeErrors: 'warn' } }));
    assert.throws(() => loadConfig(file), /policy\.valeErrors must be block, advise or ignore/);
  });

  it('refuses a config whose commands are not lists of strings, and names the file', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ vale: 'vale --config x' }));
    assert.throws(() => loadConfig(file), (e: Error) => e.message.includes(file) && /vale must be a list of strings/.test(e.message));
  });

  it('reads the names the reader already knows, each with a short definition, and refuses a list of another shape', () => {
    const file = path.join(dir, 'names.json');
    fs.writeFileSync(file, JSON.stringify({ knownNames: { 'Acme API': ' the company\'s public REST service ', Bolt: 'the deploy tool' } }));
    assert.deepEqual(loadConfig(file).knownNames, { 'Acme API': 'the company\'s public REST service', Bolt: 'the deploy tool' });
    assert.deepEqual(loadConfig(path.join(dir, 'absent.json')).knownNames, {});
    for (const [names, why] of [[['Acme'], /knownNames must map each name to a short definition/], [{ Acme: 3 }, /knownNames\.Acme must be a definition/], [{ Acme: 'x'.repeat(121) }, /knownNames\.Acme must be at most 120 characters/], [{ ' ': 'blank' }, /knownNames has an empty name/]] as const) {
      fs.writeFileSync(file, JSON.stringify({ knownNames: names }));
      assert.throws(() => loadConfig(file), (e: Error) => e.message.includes(file) && why.test(e.message), JSON.stringify(names));
    }
  });

  it('gives the classifier the known names in its reader question, outside the card it judges', async () => {
    const classifier = complete();
    await checkCard(card, config({ classifier: classifier.argv, knownNames: { 'Acme API': 'the company\'s public REST service' } }), logger().log);
    const call = classifier.calls()[0]!;
    const question = call.argv[call.argv.indexOf('-q') + 1];
    assert.equal(question, `${CARD_QUESTION}\n\nNames the reader already knows, from the operator and not from the card:\n- Acme API: the company's public REST service`);
    assert.doesNotMatch(call.stdin, /Acme API/);
    const plain = complete();
    await checkCard(card, config({ classifier: plain.argv }), logger().log);
    assert.equal(plain.calls()[0]!.argv[plain.calls()[0]!.argv.indexOf('-q') + 1], CARD_QUESTION);
  });

  it('ships a sample config that loads, with a placeholder command', () => {
    const cfg = loadConfig(path.join(import.meta.dirname, '../../examples/triage-agent/triage-example.sample.json'));
    assert.match(cfg.prVerdict?.command[0] ?? '', /^\/path\/to\//);
    assert.deepEqual(cfg.classifier, ['pr-context-classifier', '-m', 'openai/gpt-oss-120b'], 'the sample runs the classifier on the model the eval favored');
    assert.deepEqual(Object.keys(cfg.knownNames), ['Acme API', 'Bolt'], 'the sample shows the shape with invented names only');
    assert.equal(cfg.stateFile, path.join(os.homedir(), '.local', 'state', 'your-attention', 'triage-example.json'));
  });

  it('ships a card prompt with a text fence that asks for the classifier\'s reply format', () => {
    const fence = /```text\n([\s\S]*?)\n```/.exec(fs.readFileSync(CARD_PROMPT, 'utf8'))?.[1] ?? '';
    for (const part of ['VERDICT: COMPLETE | MISSING_CONTEXT', 'RATIONALE:', 'CLARIFYING_QUESTIONS:', 'recommendation', 'what this agent does', 'in brackets', 'the operator who runs this fleet', 'Never ask to define a common software or GitHub word', 'The evidence behind the recommendation', 'in either order', 'the first two sentences', 'each question states its own change', 'only further down', 'the problem it fixes', 'Never ask for a separate goal sentence', 'Names the reader already knows', 'except the opening that step 1 checks', 'step 4 still checks that it says why', 'a name the card itself makes up', 'an acronym the card never spells out', 'Every other proper name passes']) assert.ok(fence.includes(part), part);
    assert.ok(!fence.includes('Ask about any other internal name'), 'step 2 adds no prompt to look for names');
  });
});

describe('the example triage agent follows the local policy', () => {
  const missingContext = (): string[] => stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] })).argv;

  it('passes a MISSING_CONTEXT card with the questions as advice when the policy says advise', async () => {
    const ruling = await checkCard(card, config({ classifier: missingContext(), policy: { ...DEFAULTS.policy, classifierMissingContext: 'advise' } }), logger().log);
    assert.equal(ruling.verdict, 'pass');
    assert.match(ruling.advice ?? '', /Card classifier, advice:[\s\S]*What is the goal\?/);
  });

  it('leaves out a finding the policy ignores', async () => {
    const ruling = await checkCard(card, config({ classifier: missingContext(), policy: { ...DEFAULTS.policy, classifierMissingContext: 'ignore' } }), logger().log);
    assert.deepEqual([ruling.verdict, ruling.advice], ['pass', undefined]);
  });
});

describe('the example triage agent limits the returns of one card', () => {
  const blocked = (): Partial<ExampleConfig> => ({ classifier: stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] })).argv });

  it('returns a card three times, then lets the next attempt through with the findings as advice', async () => {
    const state = new TriageState(undefined);
    const cfg = config(blocked());
    for (let i = 1; i <= 3; i++) {
      const ruling = await checkCard({ ...card, version: i }, cfg, logger().log, { state });
      assert.equal(ruling.verdict, 'return', `attempt ${i}`);
      assert.match(ruling.reason, new RegExp(`return ${i} of 3`));
    }
    const fourth = await checkCard({ ...card, version: 4 }, cfg, logger().log, { state });
    assert.equal(fourth.verdict, 'pass');
    assert.match(fourth.reason, /after 3 returns/);
    assert.match(fourth.advice ?? '', /What is the goal\?/);
  });

  it('counts a repost that follows the returned card, or that has the same agent and title, as the same card', async () => {
    const state = new TriageState(undefined);
    const cfg = config(blocked());
    await checkCard(card, cfg, logger().log, { state });
    assert.match((await checkCard({ ...card, id: 'c2', follows: 'c1', title: 'Another title' }, cfg, logger().log, { state })).reason, /return 2 of 3/);
    assert.match((await checkCard({ ...card, id: 'c3' }, cfg, logger().log, { state })).reason, /return 3 of 3/);
    assert.match((await checkCard({ ...card, id: 'c4', title: 'A new question' }, cfg, logger().log, { state })).reason, /return 1 of 3/);
  });

  it('starts a new chain for a card that follows another agent\'s card', async () => {
    const state = new TriageState(undefined);
    const cfg = config(blocked());
    for (let i = 0; i < 3; i++) await checkCard(card, cfg, logger().log, { state });
    const other = await checkCard({ ...card, id: 'c9', agent: 's2', follows: 'c1' }, cfg, logger().log, { state });
    assert.equal(other.verdict, 'return');
    assert.match(other.reason, /return 1 of 3/);
    const sameId = await checkCard({ ...card, agent: 's3' }, cfg, logger().log, { state });
    assert.match(sameId.reason, /return 1 of 3/);
  });

  it('keeps two agents apart when a space in an agent name or card id would join them into one key', async () => {
    const state = new TriageState(undefined);
    const cfg = config(blocked());
    for (let i = 0; i < 3; i++) await checkCard({ ...card, agent: 'a b', id: 'c' }, cfg, logger().log, { state });
    const other = await checkCard({ ...card, agent: 'a', id: 'b c' }, cfg, logger().log, { state });
    assert.equal(other.verdict, 'return');
    assert.match(other.reason, /return 1 of 3/);
  });

  it('keeps the count in its state file across a restart', async () => {
    const file = path.join(dir, 'state-restart.json');
    const cfg = config(blocked());
    await checkCard(card, cfg, logger().log, { state: new TriageState(file) });
    await checkCard(card, cfg, logger().log, { state: new TriageState(file) });
    assert.match((await checkCard(card, cfg, logger().log, { state: new TriageState(file) })).reason, /return 3 of 3/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('the example triage agent lets an urgent card through with a bypass code', () => {
  const blocked = (): ExampleConfig => config({ classifier: stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] })).argv });
  const codeIn = (reason: string): string => new RegExp(`${BYPASS_TAG}: ([\\w-]+)`).exec(reason)?.[1] ?? '';

  it('gives a code in every return notice, and passes the next card of that agent that carries it, without running a check', async () => {
    const state = new TriageState(undefined);
    const returned = await checkCard(card, blocked(), logger().log, { state });
    const code = codeIn(returned.reason);
    assert.ok(code.length >= 20, returned.reason);
    const classifier = stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: [] }));
    const { log, lines } = logger();
    const ruling = await checkCard({ ...card, tags: { [BYPASS_TAG]: code } }, config({ classifier: classifier.argv }), log, { state });
    assert.equal(ruling.verdict, 'pass');
    assert.match(ruling.reason, /bypass/);
    assert.equal(classifier.calls().length, 0);
    assert.match(lines.join('\n'), /bypass used by agent s1 on card c1/);
  });

  it('refuses a code a second time, from another agent, or that it never gave, and checks the card', async () => {
    const state = new TriageState(undefined);
    const code = codeIn((await checkCard(card, blocked(), logger().log, { state })).reason);
    const other = await checkCard({ ...card, agent: 's2', tags: { [BYPASS_TAG]: code } }, blocked(), logger().log, { state });
    assert.equal(other.verdict, 'return');
    assert.match(other.reason, /bypass code on this card is not valid: it belongs to another agent/);
    assert.equal((await checkCard({ ...card, tags: { [BYPASS_TAG]: code } }, blocked(), logger().log, { state })).verdict, 'pass');
    const again = await checkCard({ ...card, tags: { [BYPASS_TAG]: code } }, blocked(), logger().log, { state });
    assert.match(again.reason, /not valid: it was used already/);
    const guessed = await checkCard({ ...card, tags: { [BYPASS_TAG]: 'guessed-code-0000000000' } }, blocked(), logger().log, { state });
    assert.match(guessed.reason, /not valid: triage never gave it/);
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
  it('skips a frame it cannot read, logs it, and still answers the next card on the same stream', async () => {
    const good = `data: ${JSON.stringify({ type: 'hook', version: 1, id: 'h5', hook: 'card.created', card, deadline: Date.now() + 60_000, person: { pages: 0, visible: false, activeAt: null } })}\n\n`;
    const stop = new AbortController();
    const lines: string[] = [];
    let streams = 0;
    const verdicts: string[] = [];
    const fetcher = (async (url: string | URL) => {
      const route = new URL(String(url)).pathname;
      if (route === '/v1/extensions/stream') {
        streams++;
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: x\n\ndata: null\n\n${good}`)); } }));
      }
      verdicts.push(route);
      stop.abort();
      return Response.json({ ok: true });
    }) as typeof fetch;
    await runCardHook({ url: 'http://inbox.test', token: 't', name: 'triage-example', fetcher, log: (...a) => lines.push(a.join(' ')) }, async () => ({ verdict: 'pass', reason: 'ok' }), stop.signal);
    assert.deepEqual(verdicts, ['/v1/hooks/h5']);
    assert.equal(streams, 1);
    assert.match(lines.join('\n'), /skipped a frame it could not read/);
  });

  it('logs a verdict the inbox refuses as failed', async () => {
    const event = `data: ${JSON.stringify({ type: 'hook', version: 1, id: 'h9', hook: 'card.created', card, deadline: Date.now() + 60_000, person: { pages: 0, visible: false, activeAt: null } })}\n\n`;
    const stop = new AbortController();
    const lines: string[] = [];
    const fetcher = (async (url: string | URL) => {
      if (new URL(String(url)).pathname === '/v1/extensions/stream') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event)); } }));
      setTimeout(() => stop.abort(), 50);
      return Response.json({ error: 'The hook call is over.' }, { status: 409 });
    }) as typeof fetch;
    await runCardHook({ url: 'http://inbox.test', token: 't', name: 'triage-example', fetcher, log: (...a) => lines.push(a.join(' ')) }, async () => ({ verdict: 'pass', reason: 'ok' }), stop.signal);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(lines.join('\n'), /verdict failed: .*409/);
  });

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

  it('frees the slot of a check that never settles at its card\'s deadline, tells the check to stop, and skips a card that waited past its own', async () => {
    const event = (id: string, inMs: number): string => `data: ${JSON.stringify({ type: 'hook', version: 1, id, hook: 'card.created', card: { ...card, id }, deadline: Date.now() + inMs, person: { pages: 0, visible: false, activeAt: null } })}\n\n`;
    const verdicts: { route: string; body: { verdict: string; reason: string } }[] = [];
    const stop = new AbortController();
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const route = new URL(String(url)).pathname;
      if (route === '/v1/extensions/stream') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event('hung', 200) + event('queued', 100) + event('next', 60_000))); } }));
      verdicts.push({ route, body: JSON.parse(String(init?.body)) });
      if (verdicts.length === 3) stop.abort();
      return Response.json({ ok: true });
    }) as typeof fetch;
    let told = false;
    const checked: string[] = [];
    await runCardHook({ url: 'http://inbox.test', token: 't', name: 'triage-example', fetcher, concurrency: 1, log: () => {} }, (ev, _call, signal) => {
      checked.push(ev.card.id);
      if (ev.card.id !== 'hung') return Promise.resolve({ verdict: 'return', reason: 'No goal.' });
      signal.addEventListener('abort', () => { told = true; });
      return new Promise(() => {});
    }, stop.signal);
    const by = Object.fromEntries(verdicts.map((v) => [v.route.split('/').pop(), v.body]));
    assert.deepEqual(Object.keys(by).sort(), ['hung', 'next', 'queued']);
    for (const late of ['hung', 'queued']) {
      assert.equal(by[late]!.verdict, 'pass');
      assert.match(by[late]!.reason, /did not finish before the card's deadline/);
    }
    assert.equal(by['next']!.verdict, 'return');
    assert.deepEqual(checked, ['hung', 'next'], 'the card that waited past its deadline never reached the check');
    assert.ok(told, 'the hung check heard that its card ran out of time');
  });
});

describe('the example triage agent stops a command that ignores SIGTERM', () => {
  it('kills the whole process group after a grace period', { skip: process.platform === 'win32' ? 'Windows has no process groups' : false }, async () => {
    const pidFile = path.join(dir, 'stubborn.pid');
    const stubborn = stub('classifier', `process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const ruling = await checkCard(card, config({ classifier: stubborn.argv, classifierTimeoutMs: 500 }), logger().log);
    assert.equal(ruling.verdict, 'pass');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(), false, 'the command still runs after the grace period');
  });
});

describe('the example triage agent reads a damaged state file', () => {
  it('starts with an empty state when the file is not JSON, and says so', () => {
    const file = path.join(dir, 'state-damaged.json');
    fs.writeFileSync(file, '{"chains": {"c1": {"agent"');
    const state = new TriageState(file);
    assert.match(state.warning ?? '', /could not read .*state-damaged\.json/);
    assert.equal(state.returns('c1'), 0);
  });

  it('drops a chain entry that is not an object, and counts that card from zero', async () => {
    const file = path.join(dir, 'state-entry.json');
    fs.writeFileSync(file, JSON.stringify({ chains: { c1: 5 }, cards: { c1: 'x' }, bypass: { code: null } }));
    const state = new TriageState(file);
    const cfg = config({ classifier: stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: [] })).argv });
    assert.match((await checkCard(card, cfg, logger().log, { state })).reason, /return 1 of 3/);
  });

  it('joins a new card to the most recently seen chain when two chains of one agent share its title', () => {
    const HOUR = 60 * 60 * 1000;
    let now = 1_000_000_000_000;
    const state = new TriageState(undefined, () => now);
    const first = state.chainOf(card);
    for (let i = 0; i < 3; i++) state.recordReturn(first, card);
    now += 25 * HOUR;
    const second = state.chainOf({ ...card, id: 'c2' });
    assert.notEqual(second, first, 'a day later, the same title starts a new chain');
    now += 60_000;
    state.chainOf(card);
    now += 60_000;
    state.chainOf({ ...card, id: 'c2' });
    now += 60_000;
    assert.equal(state.chainOf({ ...card, id: 'c3' }), second);
    assert.equal(state.returns(second), 0);
  });

  it('keeps the count of a card it still sees, when a week passes after its last return', () => {
    const file = path.join(dir, 'state-prune.json');
    const DAY = 24 * 60 * 60 * 1000;
    let now = 1_000_000_000_000;
    const state = new TriageState(file, () => now);
    const chain = state.chainOf(card);
    for (let i = 0; i < 3; i++) state.recordReturn(chain, card);
    now += 6 * DAY;
    state.chainOf(card);
    now += 2 * DAY;
    state.recordReturn(state.chainOf({ ...card, id: 'other', title: 'Another card' }), { ...card, id: 'other' });
    assert.equal(new TriageState(file, () => now).returns(new TriageState(file, () => now).chainOf(card)), 3);
  });

  it('still returns a card, and logs why, when it cannot write its state file', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a folder this user cannot write' : false }, async () => {
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o500);
    try {
      const state = new TriageState(path.join(locked, 'state.json'));
      const cfg = config({ classifier: stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: [] })).argv });
      const log = logger();
      const ruling = await checkCard(card, cfg, log.log, { state });
      assert.equal(ruling.verdict, 'return');
      assert.match(ruling.reason, /return 1 of 3/);
      assert.match(log.lines.join('\n'), /could not write .*state\.json/);
      assert.match((await checkCard(card, cfg, log.log, { state })).reason, /return 2 of 3/, 'the count goes on in memory');
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('starts empty, and says so, when the file is JSON of the wrong shape, an array included', () => {
    for (const shape of [{ chains: 5 }, [], 7]) {
      const file = path.join(dir, 'state-shape.json');
      fs.writeFileSync(file, JSON.stringify(shape));
      const state = new TriageState(file);
      assert.match(state.warning ?? '', /could not read .*state-shape\.json/, JSON.stringify(shape));
      assert.equal(state.returns(state.chainOf(card)), 0);
    }
  });
});

describe('the limiter', () => {
  it('runs one task at a time when asked for a limit below one', async () => {
    const { limiter } = await import('../../src/extensions/card-hook.ts');
    const run = limiter(0);
    assert.equal(await run(async () => 'ran'), 'ran');
  });

  it('never runs more tasks than its limit, when new tasks arrive as others finish', async () => {
    const { limiter } = await import('../../src/extensions/card-hook.ts');
    const run = limiter(2);
    let running = 0;
    let most = 0;
    const task = (ms: number) => async (): Promise<void> => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
    };
    const all: Promise<void>[] = [];
    for (let i = 0; i < 12; i++) all.push(run(task(i % 3)).then(() => { all.push(run(task(1))); }));
    while (all.length < 24) await new Promise((r) => setTimeout(r, 5));
    await Promise.all(all);
    assert.equal(most, 2);
  });
});
