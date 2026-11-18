// An agent's feedback on triage pushback: POST /v1/cards/<id>/triage-feedback, the pushback the card keeps, the search
// filter and the owner's export (SPEC.md, "Feedback on triage pushback").
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeReturned } from '../../src/client.ts';
import type { HookEvent } from '../../src/core/hooks.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent, Card } from '../../src/core/types.ts';
import { SecretRequests } from '../../src/integrations/secrets.ts';
import { cardTools } from '../../src/integrations/tools.ts';
import { httpInbox } from './fixture.ts';

type CardCall = Extract<HookEvent, { hook: 'card.created' }>;

/** An inbox behind the HTTP handler with a triage extension connected, whose verdicts the test gives. */
async function setup() {
  let now = 1_000;
  // The hosted inbox leaves the diagram checks to the client, so the page may send back a card it cannot draw.
  const inbox = new Inbox(new MemoryStorage(), () => now, undefined, { clientChecks: true });
  const http = await httpInbox(inbox);
  const calls: CardCall[] = [];
  const ext: Caller = { token: http.ext.split('.')[0]!, role: 'extension' };
  inbox.connectExtension(ext, { name: 'triage', hooks: ['card.created'] }, (e) => calls.push(e as CardCall));
  const events: AgentEvent[] = [];
  inbox.connect({ token: http.agentA.split('.')[0]!, role: 'agent' }, 's1', (e) => events.push(e));
  const post = async (body: Record<string, unknown>, token = http.agentA): Promise<Card> =>
    (await (await http.call('POST', '/v1/cards', { token, body: { agent: 's1', ...body } })).json()) as Card;
  /** The extension's verdict on the newest call for this card. */
  const verdict = (id: string, v: 'pass' | 'hold' | 'return', reason: string) => {
    const call = calls.filter((c) => c.card.id === id).at(-1);
    assert.ok(call, `no hook call for ${id}`);
    return inbox.hookVerdict(ext, call.id, v, reason);
  };
  const feedback = (id: string, body: unknown, token = http.agentA) => http.call('POST', `/v1/cards/${id}/triage-feedback`, { token, body });
  return { ...http, inbox, ext, events, post, verdict, feedback, tick: (ms: number) => { now += ms; } };
}

describe('the pushback a card keeps', () => {
  it('records each return with the extension, the reason and the version it answered, through a revision', async () => {
    const { inbox, post, verdict, tick } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'The card states no goal.');
    assert.deepEqual(inbox.getCard('c1').pushback, [{ kind: 'returned', by: 'triage', reason: 'The card states no goal.', version: 1, at: 1_000 }]);
    tick(500);
    await post({ id: 'c1', title: 'Ship the invoice fix?', text: 'The goal is to stop double billing.' });
    verdict('c1', 'pass', '');
    const card = inbox.getCard('c1');
    assert.equal(card.triage?.state, 'passed');
    assert.equal(card.pushback?.length, 1, 'the revision keeps the reason triage gave the version before');
    assert.equal(card.pushback?.[0]?.reason, 'The card states no goal.');
  });

  it('records nothing when the inbox page sends a card back, which is not triage', async () => {
    const { inbox, post, verdict, owner, call } = await setup();
    await post({ id: 'c1', title: 'q', text: '```mermaid\nflowchart LR\n  A --> B\n```' });
    verdict('c1', 'pass', '');
    const res = await call('POST', '/v1/cards/c1/draw-fault', { token: owner, body: { version: 1, diagrams: [{ source: 'flowchart LR\n  A --> B', error: 'bad' }] } });
    assert.equal(res.status, 200);
    assert.equal(inbox.getCard('c1').closed?.kind, 'returned');
    assert.equal(inbox.getCard('c1').pushback, undefined);
  });
});

describe('the returned event', () => {
  it('names the extension, and its notice ends with one sentence that points to card_triage_feedback', async () => {
    const { events, post, verdict } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'The card states no goal.');
    const ev = events.find((e): e is Extract<AgentEvent, { type: 'returned' }> => e.type === 'returned');
    assert.ok(ev);
    assert.equal(ev.extension, 'triage');
    const text = describeReturned(ev);
    assert.ok(text.startsWith('Triage sent back card c1 ("Ship it?"): The card states no goal. Revise it with card_patch or post a better card. '), text);
    assert.match(text, /card_triage_feedback/);
    assert.equal(text.split('card_patch')[1]!.split('. ').length, 2, 'one sentence follows the old notice');
  });

  it('says nothing about feedback when the inbox page sent the card back', () => {
    const card = { id: 'c1', title: 'q' } as Card;
    const text = describeReturned({ type: 'returned', id: 'e1', card, reason: 'The diagram does not draw.', by: 'The inbox page' });
    assert.doesNotMatch(text, /card_triage_feedback/);
  });
});

describe('POST /v1/cards/<id>/triage-feedback', () => {
  it('stores the verdict beside the reason it answers, with the time and the agent', async () => {
    const { inbox, post, verdict, feedback, tick } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'The card states no goal. Option B has no description.');
    tick(2_000);
    const res = await feedback('c1', { verdict: 'partly', comment: 'The goal was in the title.', findings: [{ quote: 'The card states no goal.', verdict: 'disagree', comment: 'The title says it.' }, { index: 2, verdict: 'agree' }] });
    assert.equal(res.status, 200);
    const stored = inbox.getCard('c1').pushback?.[0]?.feedback;
    assert.deepEqual(stored, {
      verdict: 'partly',
      comment: 'The goal was in the title.',
      findings: [{ quote: 'The card states no goal.', verdict: 'disagree', comment: 'The title says it.' }, { index: 2, verdict: 'agree' }],
      agent: 's1',
      at: 3_000,
    });
  });

  it('replaces the feedback on the same pushback, so one pushback holds one verdict', async () => {
    const { inbox, post, verdict, feedback, tick } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'No goal.');
    await feedback('c1', { verdict: 'disagree', comment: 'first' });
    tick(10);
    await feedback('c1', { verdict: 'agree', comment: 'On a second read, it was right.' });
    const pushback = inbox.getCard('c1').pushback ?? [];
    assert.equal(pushback.length, 1);
    assert.equal(pushback[0]?.feedback?.verdict, 'agree');
    assert.equal(pushback[0]?.feedback?.comment, 'On a second read, it was right.');
  });

  it('answers the latest pushback, and keeps the feedback on the earlier one', async () => {
    const { inbox, post, verdict, feedback } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'No goal.');
    await feedback('c1', { verdict: 'agree' });
    await post({ id: 'c1', title: 'Ship it?', text: 'Goal: stop double billing.' });
    verdict('c1', 'return', 'No options.');
    await feedback('c1', { verdict: 'disagree', comment: 'The card asks a yes or no question.' });
    const pushback = inbox.getCard('c1').pushback ?? [];
    assert.deepEqual(pushback.map((p) => [p.version, p.reason, p.feedback?.verdict]), [[1, 'No goal.', 'agree'], [2, 'No options.', 'disagree']]);
  });

  it('takes feedback only from the token that posted the card', async () => {
    const { post, verdict, feedback, agentB, owner } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'No goal.');
    assert.equal((await feedback('c1', { verdict: 'agree' }, agentB)).status, 403);
    assert.equal((await feedback('c1', { verdict: 'agree' }, owner)).status, 403);
  });

  it('refuses a card that triage never pushed back on', async () => {
    const { post, verdict, feedback } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'pass', '');
    const res = await feedback('c1', { verdict: 'agree' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /triage has not pushed back on card c1/);
  });

  it('checks the verdict, the findings and the size of each text', async () => {
    const { post, verdict, feedback } = await setup();
    await post({ id: 'c1', title: 'Ship it?' });
    verdict('c1', 'return', 'No goal.');
    const status = async (body: unknown) => (await feedback('c1', body)).status;
    assert.equal(await status({ verdict: 'maybe' }), 400);
    assert.equal(await status({ verdict: 'agree', comment: 'x'.repeat(2001) }), 400);
    assert.equal(await status({ verdict: 'agree', findings: [{ verdict: 'agree' }] }), 400, 'a finding names its index or a quote');
    assert.equal(await status({ verdict: 'agree', findings: [{ index: 1, verdict: 'nope' }] }), 400);
    assert.equal(await status({ verdict: 'agree', findings: [{ quote: 'x'.repeat(301), verdict: 'agree' }] }), 400);
    assert.equal(await status({ verdict: 'agree', findings: Array.from({ length: 21 }, (_, i) => ({ index: i + 1, verdict: 'agree' })) }), 400);
    assert.equal(await status({ verdict: 'agree', comment: 'x'.repeat(2000) }), 200);
  });
});

describe('the size of the pushback', () => {
  it('keeps the newest pushbacks, and full feedback on each never blocks a revision', async () => {
    const { inbox, post, verdict, feedback } = await setup();
    const full = { verdict: 'partly', comment: 'c'.repeat(2000), findings: Array.from({ length: 20 }, (_, i) => ({ index: i + 1, quote: 'q'.repeat(300), verdict: 'agree', comment: 'f'.repeat(1000) })) };
    await post({ id: 'c1', title: 'Ship it?' });
    for (let i = 0; i < 12; i++) {
      verdict('c1', 'return', `${'r'.repeat(990)} ${i}`);
      assert.equal((await feedback('c1', full)).status, 200);
      const revised = await post({ id: 'c1', title: 'Ship it?', text: `Try ${i}.` });
      assert.equal(revised.version, i + 2, `revision ${i + 2} went in`);
    }
    const pushback = inbox.getCard('c1').pushback ?? [];
    assert.equal(pushback.length, 10);
    assert.match(pushback.at(-1)!.reason, / 11$/);
  });
});

describe('finding the feedback', () => {
  async function three() {
    const s = await setup();
    for (const id of ['agreed', 'disputed', 'quiet']) {
      await s.post({ id, title: id });
      s.verdict(id, 'return', `${id} lacks a goal.`);
    }
    await s.post({ id: 'clean', title: 'clean' });
    s.verdict('clean', 'pass', '');
    await s.feedback('agreed', { verdict: 'agree' });
    await s.feedback('disputed', { verdict: 'disagree', comment: 'The goal is in the text.' });
    return s;
  }
  const ids = (page: { results: { card: Card }[] }) => page.results.map((r) => r.card.id).sort();

  it('card_search keeps the cards with feedback, or with one verdict', async () => {
    const { call, agentB } = await three();
    const get = async (q: string) => (await (await call('GET', `/v1/search?format=page&${q}`, { token: agentB })).json()) as { results: { card: Card }[] };
    assert.deepEqual(ids(await get('triage_feedback=any')), ['agreed', 'disputed']);
    assert.deepEqual(ids(await get('triage_feedback=disagree')), ['disputed']);
    assert.equal((await call('GET', '/v1/search?triage_feedback=sometimes', { token: agentB })).status, 400);
    const alone = (await (await call('GET', '/v1/search?triage_feedback=any', { token: agentB })).json()) as { results: { card: Card }[] };
    assert.deepEqual(ids(alone), ['agreed', 'disputed'], 'the filter alone asks for the paged reply, as every filter does');
  });

  it('the export gives the owner one record per card triage pushed back on, with its later outcome', async () => {
    const { call, owner, agentA, post, verdict, inbox } = await three();
    await post({ id: 'agreed', title: 'agreed', text: 'Goal: ship.' });
    verdict('agreed', 'pass', '');
    await inbox.answer('agreed', { values: {}, comment: 'go' });
    assert.equal((await call('GET', '/v1/triage-feedback', { token: agentA })).status, 403);
    const res = await call('GET', '/v1/triage-feedback', { token: owner });
    assert.equal(res.status, 200);
    const records = ((await res.json()) as { records: Record<string, unknown>[] }).records;
    assert.deepEqual(records.map((r) => r['card']).sort(), ['agreed', 'disputed', 'quiet']);
    const agreed = records.find((r) => r['card'] === 'agreed')!;
    assert.equal(agreed['agent'], 's1');
    assert.equal(agreed['outcome'], 'answered');
    assert.deepEqual((agreed['pushback'] as { by: string; reason: string; feedback: { verdict: string } }[]).map((p) => [p.by, p.reason, p.feedback.verdict]), [['triage', 'agreed lacks a goal.', 'agree']]);
    assert.equal(records.find((r) => r['card'] === 'quiet')!['outcome'], 'returned');
    const disputed = (await (await call('GET', '/v1/triage-feedback?triage_feedback=disagree', { token: owner })).json()) as { records: Record<string, unknown>[] };
    assert.deepEqual(disputed.records.map((r) => r['card']), ['disputed']);
  });

  it('the export says a card passed on a later attempt, or expired', async () => {
    const { call, owner, post, verdict, tick, inbox } = await setup();
    await post({ id: 'later', title: 'later' });
    verdict('later', 'return', 'No goal.');
    await post({ id: 'later', title: 'later', text: 'Goal: ship.' });
    verdict('later', 'pass', '');
    await post({ id: 'gone', title: 'gone', expiresAt: 2_000 });
    verdict('gone', 'return', 'No goal.');
    await post({ id: 'gone', title: 'gone', text: 'Goal: ship.', expiresAt: 2_000 });
    verdict('gone', 'pass', '');
    tick(5_000);
    inbox.sweep();
    const records = ((await (await call('GET', '/v1/triage-feedback', { token: owner })).json()) as { records: Record<string, unknown>[] }).records;
    assert.equal(records.find((r) => r['card'] === 'later')!['outcome'], 'passed');
    assert.equal(records.find((r) => r['card'] === 'gone')!['outcome'], 'expired');
  });
});

describe('the card_triage_feedback tool', () => {
  it('tells the agent when to use it', () => {
    const tool = cardTools.find((t) => t.name === 'card_triage_feedback');
    assert.ok(tool);
    assert.match(tool.description, /sent your card back/);
    assert.deepEqual((tool.schema['required'] as string[]).sort(), ['card_id', 'verdict']);
  });

  it('sends the verdict, the comment and the findings through the client', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const sent: unknown[] = [];
    const inbox = { triageFeedback: async (id: string, body: unknown) => { sent.push([id, body]); return { id, pushback: [{ kind: 'returned', by: 'triage', reason: 'No goal.', version: 1, at: 1 }] }; } } as never;
    const text = await runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_triage_feedback', { card_id: 'c1', verdict: 'disagree', comment: 'The goal is in the title.', findings: [{ index: 1, verdict: 'disagree' }] });
    assert.deepEqual(sent, [['c1', { verdict: 'disagree', comment: 'The goal is in the title.', findings: [{ index: 1, verdict: 'disagree' }] }]]);
    assert.match(text, /triage/);
  });

  it('leaves a null comment out rather than storing the word null', async () => {
    const { runTool } = await import('../../src/integrations/run-tool.ts');
    const sent: unknown[] = [];
    const inbox = { triageFeedback: async (id: string, body: unknown) => { sent.push(body); return { id, pushback: [] }; } } as never;
    await runTool({ inbox, secrets: new SecretRequests(), agent: 's1', origin: async () => undefined, arrival: 'as a test' }, 'card_triage_feedback', { card_id: 'c1', verdict: 'agree', comment: null, findings: null });
    assert.deepEqual(sent, [{ verdict: 'agree' }]);
  });
});
