import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkMermaid, MERMAID_VERSION } from '../../src/adapters/mermaid.ts';
import { findDiagrams } from '../../src/core/diagrams.ts';
import { Inbox, InboxError } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { renderMarkdown } from '../../web/markdown.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const agent = { token: 'ta', role: 'agent' as const };
const FLOW = 'flowchart TD\n  A[Agent posts a card] --> B{Diagram parses?}\n  B -- yes --> C[Person sees it]\n  B -- no --> D[400 to the agent]';
// Mermaid 11 rejects a dotted link with text between the dots and a label in pipes.
const DOTTED = 'flowchart TD\n  A -. text .->|label| B';
const inbox = () => new Inbox(new MemoryStorage(), Date.now, undefined, { checkDiagram: checkMermaid });
const rejects = (status: number, pattern: RegExp) => (e: unknown) => e instanceof InboxError && e.status === status && pattern.test(e.message);

describe('the mermaid checker', () => {
  it('accepts diagrams of several types', async () => {
    for (const src of [
      FLOW,
      'sequenceDiagram\n  Agent->>Inbox: POST /v1/cards\n  Inbox-->>Agent: 201',
      'classDiagram\n  Inbox <|-- Card',
      'stateDiagram-v2\n  [*] --> open\n  open --> answered',
      'erDiagram\n  CARD ||--o{ ANSWER : has',
      'gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Build :a1, 2026-01-01, 3d',
      'pie\n  "yes" : 3\n  "no" : 1',
      'gitGraph\n  commit\n  branch fix\n  commit',
    ]) assert.equal(await checkMermaid(src), undefined, src);
  });

  it('quotes mermaid\'s error for a diagram it cannot parse', async () => {
    assert.match((await checkMermaid(DOTTED)) ?? '', /Parse error on line 2[\s\S]*got 'PIPE'/);
    assert.match((await checkMermaid('pie\n  "yes" 3')) ?? '', /Expecting token of type ':'/);
    assert.match((await checkMermaid('not a diagram')) ?? '', /No diagram type detected/);
  });

  it('refuses what the page would refuse to draw: too many edges, or too much text', async () => {
    const edges = `flowchart TD\n${Array.from({ length: 501 }, (_, i) => `  n${i} --> n${i + 1}`).join('\n')}`;
    assert.match((await checkMermaid(edges)) ?? '', /Edge limit exceeded/);
    assert.match((await checkMermaid(`flowchart TD\n  A["${'x'.repeat(50_001)}"]`)) ?? '', /at most 50000 characters/);
  });

  it('leaves no browser globals behind', async () => {
    await checkMermaid(FLOW);
    assert.equal(typeof (globalThis as Record<string, unknown>)['window'], 'undefined');
    assert.equal(typeof (globalThis as Record<string, unknown>)['document'], 'undefined');
  });

  it('is the version the page draws with, pinned exactly', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies['mermaid'], MERMAID_VERSION);
    assert.match(fs.readFileSync(path.join(ROOT, 'web/components.js'), 'utf8'), new RegExp(`MERMAID_VERSION = '${MERMAID_VERSION.replace(/\./g, '\\.')}'`));
  });
});

describe('finding diagrams', () => {
  it('finds a ```mermaid block in text and recommendation, and a Mermaid statement in the body', () => {
    const found = findDiagrams({
      text: `Intro.\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n\`\`\`js\nnot a diagram\n\`\`\``,
      recommendation: '```Mermaid\npie\n  "a" : 1\n```',
      body: `root = Card([intro, flow])\nintro = TextContent("Mermaid(\\"not this\\")")\nflow = Mermaid(${JSON.stringify(FLOW)})`,
    });
    assert.deepEqual(found, [
      { where: 'text, the diagram on line 3', source: FLOW },
      { where: 'recommendation, the diagram on line 1', source: 'pie\n  "a" : 1' },
      { where: 'body, statement flow', source: FLOW },
    ]);
  });

  it('reads a body as OpenUI does: single quotes with their escapes, comments, and ``` fences', () => {
    // A double quote inside a single-quoted string opens nothing, so the Mermaid call after it still counts.
    assert.deepEqual(findDiagrams({ body: "root = Card([t, d])\nt = TextContent('a 5\" screen')\nd = Mermaid('pie\\n  \"it\\'s\" : 1')" }), [{ where: 'body, statement d', source: 'pie\n  "it\'s" : 1' }]);
    // OpenUI drops a comment to the end of its line, so a commented-out call draws nothing.
    assert.deepEqual(findDiagrams({ body: 'root = Card([])\n// d = Mermaid("not drawn")\n# e = Mermaid(src)' }), []);
    assert.deepEqual(findDiagrams({ body: 'Here is the card:\n```openui\nroot = Card([d])\nd = Mermaid("pie")\n```\nd2 = Mermaid(outside)' }), [{ where: 'body, statement d', source: 'pie' }]);
  });

  it('refuses a Mermaid statement whose source is not a string', () => {
    assert.throws(() => findDiagrams({ body: 'root = Card([d])\nsrc = "pie"\nd = Mermaid(src)' }), rejects(400, /statement d: Mermaid takes the diagram source as a string/));
  });

  it('finds the same blocks the page draws as diagrams', () => {
    const text = 'a\n```mermaid\nflowchart LR\n  A --> B\n```\n- item\n```mermaid title\nsequenceDiagram\n  A->>B: hi\n```\n```\nplain\n```\n```mermaid\npie\n  "open" : 1';
    const drawn: string[] = [];
    renderMarkdown((t: string, _p: unknown, ...c: unknown[]) => ({ t, c }), text, { diagram: (src: string) => { drawn.push(src); return null; } });
    assert.deepEqual(drawn, findDiagrams({ text }).map((d) => d.source));
    assert.equal(drawn.length, 3);
  });
});

describe('cards with diagrams', () => {
  it('accept a diagram in text, and reject one mermaid cannot parse, naming it and quoting mermaid', async () => {
    const box = inbox();
    const ok = await box.postCardWithFiles(agent, { id: 'd1', agent: 's1', title: 'Flow', text: `\`\`\`mermaid\n${FLOW}\n\`\`\`` });
    assert.equal(ok.version, 1);
    await assert.rejects(box.postCardWithFiles(agent, { id: 'd2', agent: 's1', title: 'Bad', text: `Why:\n\n\`\`\`mermaid\n${DOTTED}\n\`\`\`` }),
      rejects(400, /^The Mermaid diagram in text, the diagram on line 3 does not parse, so the inbox did not take the card\. Mermaid 11\.\d+\.\d+ says:\nParse error on line 2/));
    assert.throws(() => box.getCard('d2'), /unknown card/);
  });

  it('check a Mermaid statement in the body', async () => {
    const box = inbox();
    await box.postCardWithFiles(agent, { id: 'b1', agent: 's1', title: 'Body', body: `root = Card([d])\nd = Mermaid(${JSON.stringify(FLOW)})` });
    await assert.rejects(box.postCardWithFiles(agent, { id: 'b2', agent: 's1', title: 'Body', body: `root = Card([d])\nd = Mermaid(${JSON.stringify(DOTTED)})` }), rejects(400, /body, statement d does not parse/));
  });

  it('check a patch before it lands', async () => {
    const box = inbox();
    await box.postCardWithFiles(agent, { id: 'p1', agent: 's1', title: 'Patch', text: `\`\`\`mermaid\n${FLOW}\n\`\`\`` });
    await assert.rejects(box.patchCardChecked(agent, 'p1', [{ old: 'A[Agent posts a card] --> B', new: 'A -. text .->|label| B' }]), rejects(400, /text, the diagram on line 1 does not parse/));
    assert.equal(box.getCard('p1').version, 1);
    const next = await box.patchCardChecked(agent, 'p1', [{ old: 'Person sees it', new: 'The person sees it' }]);
    assert.equal(next.version, 2);
  });

  it('check the diagram a widget or a template expands into', async () => {
    const box = inbox();
    box.saveWidget('flow', 'root = Card([d])\nd = Mermaid({{source}})');
    box.saveTemplate('flow-card', 'root = Card([d])\nd = Mermaid({{source}})');
    await box.postCardWithFiles(agent, { id: 'w1', agent: 's1', title: 'Widget', body: `root = Card([f])\nf = widget flow ${JSON.stringify({ source: FLOW })}` });
    await assert.rejects(box.postCardWithFiles(agent, { id: 'w2', agent: 's1', title: 'Widget', body: `root = Card([f])\nf = widget flow ${JSON.stringify({ source: DOTTED })}` }), rejects(400, /body, statement f_d does not parse/));
    await assert.rejects(box.postCardWithFiles(agent, { id: 't1', agent: 's1', title: 'Template', template: { name: 'flow-card', vars: { source: DOTTED } } }), rejects(400, /body, statement d does not parse/));
  });

  it('place the built-in mermaid widget, listed in the catalog, which no one can save over', async () => {
    const box = inbox();
    const card = await box.postCardWithFiles(agent, { id: 'm1', agent: 's1', title: 'Built in', body: `root = Card([d])\nd = widget mermaid ${JSON.stringify({ source: FLOW })}` });
    assert.equal(card.body, `root = Card([d])\nd = Mermaid(${JSON.stringify(FLOW)})`);
    assert.match(box.widgetCatalog(), /^- mermaid: /m);
    assert.throws(() => box.saveWidget('mermaid', 'root = Card([])'), rejects(400, /mermaid is a built-in widget/));
  });

  it('refuse a diagram where the inbox has no checker, and a diagram the sync path never checked', async () => {
    const plain = new Inbox(new MemoryStorage());
    await assert.rejects(plain.postCardWithFiles(agent, { agent: 's1', title: 'No checker', text: `\`\`\`mermaid\n${FLOW}\n\`\`\`` }), rejects(400, /cannot check Mermaid diagrams/));
    assert.throws(() => inbox().postCard(agent, { agent: 's1', title: 'Sync', text: `\`\`\`mermaid\n${FLOW}\n\`\`\`` }), rejects(409, /did not check/));
    // Only the inbox's own system cards skip the check: an agent that sets kind system gets none.
    assert.throws(() => inbox().postCard(agent, { agent: 's1', kind: 'system', title: 'Sync', text: `\`\`\`mermaid\n${FLOW}\n\`\`\`` }), rejects(409, /did not check/));
  });
});
