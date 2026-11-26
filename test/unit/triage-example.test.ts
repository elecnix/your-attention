// The example triage agent in examples/triage-agent. Every external command is a small Node script, so the tests run
// the real spawn path on Linux, macOS and Windows without vale, the classifier or a PR-verdict tool installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { BYPASS_TAG, CARD_PROMPT, CARD_QUESTION, cardProse, cardText, checkCard, DEFAULTS, linksCheck, loadConfig, runChecks, runCommand, type ExampleConfig, type RunCommand } from '../../examples/triage-agent/checks.ts';
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
/** A vale report with one alert: an error exits 1, a warning exits 0. */
const valeAlert = (alert: { Check: string; Message: string; Severity: string; Match?: string }, code = 0): ReturnType<typeof stub> =>
  stub('vale', print({ 'stdin.md': [{ Line: 1, Span: [1, 1], ...alert }] }, code));
const complete = (): ReturnType<typeof stub> => stub('classifier', print({ verdict: 'COMPLETE', rationale: 'The card states the goal.', clarifyingQuestions: [] }));
const missing = '/nonexistent/command-for-this-test';

function config(over: Partial<ExampleConfig>): ExampleConfig {
  // Every test writes its rulings log into the temp dir, never the default in the home directory.
  return { ...DEFAULTS, vale: valeClean().argv, classifier: complete().argv, logFile: path.join(dir, `rulings-${n++}.jsonl`), ...over };
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
    const vale = valeAlert({ Check: 'Cards.Hedges', Message: 'Hedge.', Severity: 'warning', Match: 'maybe' });
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
    const vale = valeAlert({ Check: 'Cards.FirstPerson', Message: 'Third person.', Severity: 'error', Match: 'I' }, 1);
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
    assert.equal(cfg.logFile, path.join(os.homedir(), '.local', 'state', 'your-attention', 'triage.jsonl'));
  });

  it('reads logFile from the local config, expanding ~ as stateFile does, and refuses one that is not a path', () => {
    const file = path.join(dir, 'log-file.json');
    fs.writeFileSync(file, JSON.stringify({ logFile: '~/triage-test.jsonl' }));
    assert.equal(loadConfig(file).logFile, path.join(os.homedir(), 'triage-test.jsonl'));
    fs.writeFileSync(file, JSON.stringify({ logFile: 5 }));
    assert.throws(() => loadConfig(file), /logFile must be a path/);
  });

  it('reads a PR-verdict command and fills in the accepted verdicts and the timeout', () => {
    const file = path.join(dir, 'triage-example.json');
    fs.writeFileSync(file, JSON.stringify({ prVerdict: { command: ['/opt/verdict', 'predict'] } }));
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.prVerdict, { command: ['/opt/verdict', 'predict'], acceptVerdicts: ['ACCEPT'], timeoutMs: 300_000 });
  });

  it('screens new cards only by default, and takes screen: "open" to include the open cards', () => {
    const file = path.join(dir, 'screen.json');
    fs.writeFileSync(file, '{}');
    assert.equal(loadConfig(file).screen, 'new');
    fs.writeFileSync(file, JSON.stringify({ screen: 'open' }));
    assert.equal(loadConfig(file).screen, 'open');
    fs.writeFileSync(file, JSON.stringify({ screen: 'backlog' }));
    assert.throws(() => loadConfig(file), /screen must be "new" or "open"/);
  });

  it('reads the policy, and fills in the parts it leaves out', () => {
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ policy: { classifierMissingContext: 'advise', linksNotClickable: 'advise', prVerdictBlockBelow: 0.3 }, maxReturns: 5 }));
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.policy, { valeErrors: 'block', valeWarnings: 'advise', classifierMissingContext: 'advise', linksNotClickable: 'advise', prVerdictBlockBelow: 0.3 });
    assert.equal(cfg.maxReturns, 5);
  });

  it('loads a config that still has knownNames or policy.classifierNames, ignores them, and logs one line', () => {
    const file = path.join(dir, 'names-policy.json');
    for (const [raw, fields] of [
      [{ policy: { classifierNames: 'warn' }, knownNames: ['not a map'] }, 'knownNames and policy.classifierNames'],
      [{ knownNames: { Acme: 'the API' } }, 'knownNames'],
      [{ policy: { classifierNames: 'block' } }, 'policy.classifierNames'],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify(raw));
      const lines: string[] = [];
      const cfg = loadConfig(file, (line) => lines.push(line));
      assert.deepEqual(cfg.policy, DEFAULTS.policy);
      assert.ok(!('knownNames' in cfg) && !('classifierNames' in cfg.policy));
      assert.deepEqual(lines, [`${file}: ${fields} ${fields.includes(' and ') ? 'are' : 'is'} no longer used, so the agent ignores ${fields.includes(' and ') ? 'them' : 'it'}`]);
    }
    const lines: string[] = [];
    fs.writeFileSync(file, JSON.stringify({ maxReturns: 2 }));
    loadConfig(file, (line) => lines.push(line));
    assert.deepEqual(lines, [], 'a config without them logs nothing');
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

  it('asks the classifier the plain reader question, and puts nothing of the operator\'s in it', async () => {
    const classifier = complete();
    await checkCard(card, config({ classifier: classifier.argv }), logger().log);
    const call = classifier.calls()[0]!;
    assert.equal(call.argv[call.argv.indexOf('-q') + 1], CARD_QUESTION);
  });

  it('ships a sample config that loads, with a placeholder command', () => {
    const cfg = loadConfig(path.join(import.meta.dirname, '../../examples/triage-agent/triage-example.sample.json'));
    assert.match(cfg.prVerdict?.command[0] ?? '', /^\/path\/to\//);
    assert.deepEqual(cfg.classifier, ['pr-context-classifier', '-m', 'openai/gpt-oss-120b'], 'the sample runs the classifier on the model the eval favored');
    const raw = fs.readFileSync(path.join(import.meta.dirname, '../../examples/triage-agent/triage-example.sample.json'), 'utf8');
    assert.doesNotMatch(raw, /knownNames|classifierNames/, 'the sample has no field the agent ignores');
    assert.equal(cfg.stateFile, path.join(os.homedir(), '.local', 'state', 'your-attention', 'triage-example.json'));
    assert.equal(cfg.logFile, path.join(os.homedir(), '.local', 'state', 'your-attention', 'triage.jsonl'), 'the sample names the rulings log');
  });

  it('ships a card prompt with a text fence that asks for the classifier\'s reply format', () => {
    const fence = /```text\n([\s\S]*?)\n```/.exec(fs.readFileSync(CARD_PROMPT, 'utf8'))?.[1] ?? '';
    for (const part of ['VERDICT: COMPLETE | MISSING_CONTEXT', 'RATIONALE:', 'CLARIFYING_QUESTIONS:', 'recommendation', 'what this agent does', 'in brackets', 'the operator who runs this fleet', 'The evidence behind the recommendation', 'in either order', 'the first two sentences', 'each question states its own change', 'only further down', 'the problem it fixes', 'Never ask for a separate goal sentence', 'except the opening that step 1 checks', 'step 3 still checks that it says why', 'Never ask what a name, a term or an acronym means', 'such as "- [3] What does this agent do', 'a software developer who knows common software, cloud, AI and developer-tool terms and products']) assert.ok(fence.includes(part), part);
    for (const gone of ['Names the reader already knows', 'a name the card itself makes up', 'Every other proper name passes']) assert.ok(!fence.includes(gone), gone);
    // The steps run from 1 to 7 with no gap, and every step a sentence names exists.
    assert.deepEqual([...fence.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7]);
    for (const m of fence.matchAll(/step (\d+)/g)) assert.ok(Number(m[1]) <= 7, m[0]);
  });
});

describe('the example triage agent follows the local policy', () => {
  const missingContext = (): string[] => stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] })).argv;

  it('passes a MISSING_CONTEXT card with the questions as advice when the policy says advise', async () => {
    const ruling = await checkCard(card, config({ classifier: missingContext(), policy: { ...DEFAULTS.policy, classifierMissingContext: 'advise' } }), logger().log);
    assert.equal(ruling.verdict, 'pass');
    assert.match(ruling.advice ?? '', /Card classifier, advice:[\s\S]*What is the goal\?/);
  });

  const asks = (questions: string[]): string[] => stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'Some gaps.', clarifyingQuestions: questions })).argv;

  it('sends a card back for the questions of every step, with no step that gives advice alone', async () => {
    const ruling = await checkCard(card, config({ classifier: asks(['[2] What problem does the retry fix?', '[5] Which option does this agent recommend?']) }), logger().log);
    assert.equal(ruling.verdict, 'return');
    assert.match(ruling.reason ?? '', /Some gaps\.[\s\S]*\[2\] What problem[\s\S]*\[5\] Which option/);
    assert.equal(ruling.advice, undefined);
  });

  it('blocks a question without a step number, and a MISSING_CONTEXT answer without questions', async () => {
    assert.equal((await checkCard(card, config({ classifier: asks(['What is the goal?']) }), logger().log)).verdict, 'return');
    assert.equal((await checkCard(card, config({ classifier: asks([]) }), logger().log)).verdict, 'return');
  });

  it('leaves out a finding the policy ignores', async () => {
    const ruling = await checkCard(card, config({ classifier: missingContext(), policy: { ...DEFAULTS.policy, classifierMissingContext: 'ignore' } }), logger().log);
    assert.deepEqual([ruling.verdict, ruling.advice], ['pass', undefined]);
  });
});

describe('the example triage agent checks that every reference renders as a link', () => {
  const links = (over: Partial<Card>): string[] => linksCheck({ ...card, ...over }, config({})).sections.flatMap((s) => s.lines);
  const pr = 'PrizmalAi/PrizmalSwitch#3750';

  it('names each finding by its field, the exact text and the fix, and reads a plain field as written', () => {
    const cases: [string, Partial<Card>, RegExp][] = [
      ['a reference in the text', { text: `Merge ${pr} once CI passes.` },
        /^text: PrizmalAi\/PrizmalSwitch#3750 shows as plain text\. Write it as \[PrizmalAi\/PrizmalSwitch#3750\]\(https:\/\/github\.com\/PrizmalAi\/PrizmalSwitch\/pull\/3750\)\.$/],
      ['a reference in the title', { title: `Merge ${pr}` },
        /^title: PrizmalAi\/PrizmalSwitch#3750 shows as plain text, in a field that draws no Markdown\. Write the link in the card's text as \[/],
      ['a reference inside inline code', { text: 'Merge `acme/api#42` once CI passes.' },
        /^text: acme\/api#42 sits inside `backticks`, so it shows as code, not a link\. Move it out of the code span and write it as \[acme\/api#42\]\(https:\/\/github\.com\/acme\/api\/pull\/42\)\.$/],
      ['a Markdown link in the title', { title: 'See [the run](https://ci.test/run)' },
        /^title: \[the run\]\(https:\/\/ci\.test\/run\) shows as written, because this field draws no Markdown\. Write the link in the card's text instead\.$/],
      ['an address in the title', { title: 'See https://ci.test/run before deciding' },
        /^title: https:\/\/ci\.test\/run shows as plain text, in a field that draws no Markdown\. Write the link in the card's text as \[a label\]\(https:\/\/ci\.test\/run\)\.$/],
    ];
    for (const [what, over, expected] of cases) {
      const lines = links(over);
      assert.equal(lines.length, 1, what);
      assert.match(lines[0] ?? '', expected, what);
    }
  });

  it('quotes an address in a plain field whole: a parenthesis the address opened stays, and the sentence\'s goes', () => {
    const cases: [string, string][] = [
      ['See https://ci.test/a_(b) before deciding', 'https://ci.test/a_(b)'],
      ['(see https://ci.test/run)', 'https://ci.test/run'],
      ['See https://ci.test/run. Done', 'https://ci.test/run'],
    ];
    for (const [title, url] of cases) {
      const lines = links({ title });
      assert.equal(lines.length, 1, title);
      assert.match(lines[0] ?? '', new RegExp(`^title: ${url.replace(/[()._]/g, (c) => `\\${c}`)} shows as plain text`), title);
      assert.ok((lines[0] ?? '').includes(`[a label](${url})`), `${title}: ${lines[0]}`);
    }
  });

  it('never calls a plain field a link the page draws, since its brackets show as they were written', () => {
    const lines = links({ title: 'See [the run](https://ci.test/run)' });
    assert.doesNotMatch(lines[0] ?? '', /shows the label alone/);
  });

  it('flags a Markdown link whose target is not an address the page links', () => {
    const lines = links({ text: 'See [the run](/run/17) and [the pull request](acme/api#42).' });
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, /^text: .*is not a link/);
    assert.match(lines[0] ?? '', /\/run\/17/);
  });

  it('leaves the pr tag alone, since it holds a pull-request reference by design', () => {
    assert.deepEqual(links({ tags: { pr: 'acme/api#42' } }), []);
  });

  it('leaves a reference that is already a link, or inside a link, alone', () => {
    const text = `See [${pr}](https://github.com/PrizmalAi/PrizmalSwitch/pull/3750), [the run](https://ci.test/each#12) and [[c9]].`;
    assert.deepEqual(links({ text }), []);
    assert.deepEqual(links({ text: 'A bare https://ci.test/run and [it](mailto:me@example.test).' }), []);
  });

  it('follows the policy: a card goes back for Links, then passes with the finding as advice, or ignores it', async () => {
    const broken = { ...card, text: `Merge ${pr} once CI passes.` };
    assert.equal((await checkCard(broken, config({}), logger().log)).verdict, 'return');
    const advised = await checkCard(broken, config({ policy: { ...DEFAULTS.policy, linksNotClickable: 'advise' } }), logger().log);
    assert.equal(advised.verdict, 'pass');
    assert.match(advised.advice ?? '', /Links, advice:[\s\S]*PrizmalAi\/PrizmalSwitch#3750/);
    const ignored = await checkCard(broken, config({ policy: { ...DEFAULTS.policy, linksNotClickable: 'ignore' } }), logger().log);
    assert.deepEqual([ignored.verdict, ignored.advice], ['pass', undefined]);
  });

  it('collects every check, so one notice carries both the Links finding and a vale error', async () => {
    const vale = valeAlert({ Check: 'Cards.FirstPerson', Message: 'Third person.', Severity: 'error', Match: 'I' }, 1);
    const broken = { ...card, text: `Merge ${pr} once CI passes.` };
    const ruling = await checkCard(broken, config({ vale: vale.argv }), logger().log);
    assert.equal(ruling.verdict, 'return');
    assert.match(ruling.reason, /Vale, must fix:[\s\S]*Links, must fix:[\s\S]*PrizmalAi\/PrizmalSwitch#3750/);
  });

  it('runs inside runChecks with the other checks, and passes a card whose references all render', async () => {
    const reports = await runChecks({ ...card, text: `See [${pr}](https://github.com/PrizmalAi/PrizmalSwitch/pull/3750) and https://ci.test/run.` }, config({}), undefined);
    assert.ok(reports.some((r) => r.check === 'Links'));
    assert.deepEqual(reports.find((r) => r.check === 'Links')?.sections, []);
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

describe('the example triage agent logs every ruling as one JSON line', () => {
  const logPath = (): string => path.join(dir, `rulings-${n++}.jsonl`);
  const readLines = (file: string): Record<string, any>[] =>
    fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
  const codeIn = (reason: string): string => new RegExp(`${BYPASS_TAG}: ([\\w-]+)`).exec(reason)?.[1] ?? '';
  const blocked = (): string[] => stub('classifier', print({ verdict: 'MISSING_CONTEXT', rationale: 'No goal.', clarifyingQuestions: ['What is the goal?'] })).argv;

  it('writes one parseable line for a ruling, with the card, each check, the verdict, the return count and the time', async () => {
    const file = logPath();
    const ruling = await checkCard({ ...card, tags: { pr: 'acme/api#42' } }, config({ classifier: blocked(), logFile: file }), logger().log);
    assert.equal(ruling.verdict, 'return');
    const lines = readLines(file);
    assert.equal(lines.length, 1);
    const entry = lines[0]!;
    assert.ok(!Number.isNaN(Date.parse(String(entry['at']))), `at is an ISO timestamp: ${String(entry['at'])}`);
    assert.deepEqual(entry['card'], { id: 'c1', agent: 's1', title: card.title, tags: { pr: 'acme/api#42' } });
    assert.equal(entry['pr'], 'acme/api#42');
    assert.equal(entry['verdict'], 'return');
    assert.equal(entry['reason'], ruling.reason);
    assert.deepEqual(entry['returns'], { count: 1, max: 3 });
    assert.equal(typeof entry['ms'], 'number');
    const checks = entry['checks'] as Record<string, any>[];
    assert.deepEqual(checks.map((c) => c['name']), ['Vale', 'Card classifier', 'PR verdict', 'Links']);
    const byName = Object.fromEntries(checks.map((c) => [c['name'], c]));
    assert.deepEqual(byName['Vale']['sections'], []);
    assert.deepEqual(byName['Vale']['detail'], { vale: [] });
    assert.deepEqual(byName['Card classifier']['sections'].map((s: { level: string }) => s.level), ['block']);
    assert.match(byName['Card classifier']['sections'][0].lines.join('\n'), /What is the goal\?/);
    assert.equal(byName['Card classifier']['detail'].classifier.verdict, 'MISSING_CONTEXT');
    assert.match(String(byName['PR verdict']['skipped']), /PR verdict is off/);
    assert.ok(!('detail' in byName['PR verdict']), 'a skipped check has no detail');
  });

  it('logs a returned card and a passed card, each with the return count of its chain', async () => {
    const file = logPath();
    const state = new TriageState(undefined);
    const returned = await checkCard(card, config({ classifier: blocked(), logFile: file }), logger().log, { state });
    assert.equal(returned.verdict, 'return');
    const passed = await checkCard({ ...card, id: 'c2', title: 'A different decision' }, config({ logFile: file }), logger().log, { state });
    assert.equal(passed.verdict, 'pass');
    const [r, p] = readLines(file) as [Record<string, any>, Record<string, any>];
    assert.equal(r['verdict'], 'return');
    assert.deepEqual(r['returns'], { count: 1, max: 3 });
    assert.equal(p['verdict'], 'pass');
    assert.equal(p['reason'], passed.reason);
    assert.deepEqual(p['returns'], { count: 0, max: 3 });
    assert.ok(!('advice' in p), 'a card that passed with no finding has no advice');
  });

  it('logs the advice of a card that passed with findings', async () => {
    const file = logPath();
    const vale = valeAlert({ Check: 'Cards.Hedges', Message: 'Hedge.', Severity: 'warning', Match: 'maybe' });
    const ruling = await checkCard(card, config({ vale: vale.argv, logFile: file }), logger().log);
    assert.equal(ruling.verdict, 'pass');
    const [entry] = readLines(file) as [Record<string, any>];
    assert.equal(entry['verdict'], 'pass');
    assert.equal(entry['advice'], ruling.advice);
    const valeEntry = (entry['checks'] as Record<string, any>[]).find((c) => c['name'] === 'Vale')!;
    assert.deepEqual(valeEntry['sections'], [{ level: 'advise', lines: ['- title, line 1: Cards.Hedges: Hedge. ("maybe")'] }]);
  });

  it('logs a bypass code that was used, and one that was refused, and leaves the field out when there is no code', async () => {
    const file = logPath();
    const state = new TriageState(undefined);
    const cfg = config({ classifier: blocked(), logFile: file });
    const returned = await checkCard(card, cfg, logger().log, { state });
    const code = codeIn(returned.reason);
    assert.ok(code, returned.reason);
    assert.equal((await checkCard({ ...card, tags: { [BYPASS_TAG]: code } }, cfg, logger().log, { state })).verdict, 'pass');
    assert.equal((await checkCard({ ...card, tags: { [BYPASS_TAG]: code } }, cfg, logger().log, { state })).verdict, 'return');
    const entries = readLines(file) as Record<string, any>[];
    assert.equal(entries.length, 3);
    assert.ok(!('bypass' in entries[0]!), 'a card without a code has no bypass field');
    assert.deepEqual(entries[1]!['bypass'], { used: true, issuedFor: 'c1' });
    assert.deepEqual(entries[1]!['checks'], [], 'a bypass card runs no check');
    assert.equal(entries[1]!['verdict'], 'pass');
    assert.deepEqual(entries[2]!['bypass'], { used: false, why: 'it was used already' });
    assert.equal(entries[2]!['verdict'], 'return');
  });

  it('creates the log file mode 0600 and its directory mode 0700', { skip: process.platform === 'win32' ? 'Windows has no POSIX modes' : false }, async () => {
    const folder = path.join(dir, `log-modes-${n++}`);
    const file = path.join(folder, 'triage.jsonl');
    await checkCard(card, config({ logFile: file }), logger().log);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  });

  it('rotates the log past 5 MB, replacing the earlier previous file so exactly one remains', async () => {
    const file = path.join(dir, `log-rotate-${n++}.jsonl`);
    // A fake runner answers both checks, so the 3 MB titles never go through a spawned command or its call record.
    const run: RunCommand = async (argv) => argv[0] === 'vale'
      ? { code: 0, stdout: JSON.stringify({ 'stdin.md': [] }), stderr: '' }
      : { code: 0, stdout: JSON.stringify({ verdict: 'COMPLETE', rationale: '', clarifyingQuestions: [] }), stderr: '' };
    const cfg = config({ vale: ['vale'], classifier: ['classifier'], logFile: file });
    const big = 'x'.repeat(3_000_000);
    for (let i = 0; i < 4; i++) await checkCard({ ...card, id: `big-${i}`, title: `big ${big}` }, cfg, logger().log, { run });
    const base = path.basename(file);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort(), [base, `${base}.1`], 'the main file and one previous file');
    assert.deepEqual(readLines(file).map((e) => (e['card'] as { id: string }).id), ['big-3'], 'the main file holds the newest ruling');
    assert.deepEqual(readLines(`${file}.1`).map((e) => (e['card'] as { id: string }).id), ['big-2'], 'the previous file holds the one before it');
  });

  it('leaves the verdict, the reason and the advice unchanged when the log cannot be written', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a folder this user cannot write' : false }, async () => {
    const locked = path.join(dir, `log-locked-${n++}`);
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o500);
    try {
      const vale = valeAlert({ Check: 'Cards.Hedges', Message: 'Hedge.', Severity: 'warning', Match: 'maybe' });
      const { log, lines } = logger();
      const ruling = await checkCard(card, config({ vale: vale.argv, logFile: path.join(locked, 'triage.jsonl') }), log);
      assert.equal(ruling.verdict, 'pass');
      assert.equal(ruling.reason, 'Passed with advice for the agent.');
      assert.match(ruling.advice ?? '', /Cards\.Hedges/);
      assert.match(lines.join('\n'), /could not write the rulings log .*triage\.jsonl/);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe('the example vale config', () => {
  const hasVale = ((): boolean => { try { execFileSync('vale', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it('returns a card whose prose breaks a rule, with the vale on this machine and no styles to download', { skip: hasVale ? false : 'vale is not installed' }, async () => {
    const ruling = await checkCard({ ...card, title: 'I think we should retry the export', text: 'TODO: explain the the failure.' }, { ...DEFAULTS, classifier: [missing], logFile: path.join(dir, `vale-real-${n++}.jsonl`) }, logger().log);
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

  it('lets the process exit when it stops, even while a check that ignores the stop still runs', () => {
    const script = path.join(dir, 'hook-exit.ts');
    // A file URL, since an ESM import of a Windows drive path fails.
    const hook = pathToFileURL(path.resolve(import.meta.dirname, '../../src/extensions/card-hook.ts')).href;
    fs.writeFileSync(script, `
import { runCardHook } from ${JSON.stringify(hook)};
const event = 'data: ' + JSON.stringify({ type: 'hook', version: 1, id: 'h1', hook: 'card.created', card: ${JSON.stringify(card)}, deadline: Date.now() + 60_000, person: { pages: 0, visible: false, activeAt: null } }) + '\\n\\n';
const stop = new AbortController();
const fetcher = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event)); } }))) as typeof fetch;
setTimeout(() => stop.abort(), 200);
await runCardHook({ url: 'http://inbox.test', token: 't', name: 'triage-example', fetcher, log: () => {} }, () => new Promise(() => {}), stop.signal);
`);
    const started = Date.now();
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], { timeout: 20_000 });
    assert.ok(Date.now() - started < 10_000, `the process took ${Date.now() - started} ms to exit, waiting on the card's 60 s deadline`);
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

  it('refuses a bypass code it cannot mark used on disk, so a restart cannot make it work twice', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a folder this user cannot write' : false }, () => {
    const folder = path.join(dir, 'bypass-locked');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'state.json');
    const state = new TriageState(file);
    const { code } = state.recordReturn(state.chainOf(card), card);
    fs.chmodSync(folder, 0o500);
    try {
      const use = state.useBypass(code, card.agent, 'urgent');
      assert.equal(use.ok, false);
      assert.match(use.ok ? '' : use.why, /could not record its use/);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
    assert.equal(state.useBypass(code, card.agent, 'urgent').ok, true, 'the code works once a write does');
    assert.equal(new TriageState(file).useBypass(code, card.agent, 'again').ok, false, 'and a restart sees it used');
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
