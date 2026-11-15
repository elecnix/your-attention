// The require-a-card rule in the inbox settings (SPEC.md, "The require-a-card rule"), and the environment override
// that a session obeys instead.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox, type Caller } from '../../src/core/inbox.ts';
import { MemoryBlobs, MemoryStorage } from '../../src/core/storage.ts';
import type { AgentEvent } from '../../src/core/types.ts';
import { envRequireCard, ENV_REMINDERS, resolveRequireCard } from '../../src/integrations/require-card.ts';

const agentCaller: Caller = { token: 'ta', role: 'agent' };
const ownerCaller: Caller = { token: 'to', role: 'owner' };

const fresh = () => new Inbox(new MemoryStorage(), Date.now, new MemoryBlobs());

describe('the require-a-card rule', () => {
  it('turns on for one session at once, and leaves the others alone', () => {
    const inbox = fresh();
    assert.equal(inbox.requireCardFor('s1').on, false, 'nobody is asked until someone says so');
    const rule = inbox.setRequireCardForAgent('s1', true);
    assert.deepEqual(rule, { mode: 'agents', agents: ['s1'], reminders: 3 });
    assert.equal(inbox.requireCardFor('s1').on, true);
    assert.equal(inbox.requireCardFor('s2').on, false, 'the rule names one agent, not every one');
    // Turning it off takes the name away, and the mode falls back to off when the list empties.
    assert.deepEqual(inbox.setRequireCardForAgent('s1', false), { mode: 'off', reminders: 3 });
    assert.equal(inbox.requireCardFor('s1').on, false);
  });

  it('asks for the person\'s approval before it holds every agent, and a rejection changes nothing', () => {
    const inbox = fresh();
    const card = inbox.proposeRequireCard({ on: true, by: { caller: agentCaller, agent: 's1' } });
    assert.match(card.id, /^require-card-/);
    assert.equal(card.kind, 'system');
    assert.equal(card.deliver, 'none', 'a rule proposal is nobody\'s work');
    assert.deepEqual(card.requireCard, { mode: 'all', reminders: 3, from: 's1' });
    assert.equal(inbox.requireCardFor('s2').on, false, 'a proposal holds nobody until the person answers');
    return inbox.answer(card.id, { values: { choice: 'reject' } }).then((answer) => {
      assert.equal(inbox.requireCardFor('s2').on, false);
      assert.match(String(inbox.getCard(card.id).closed?.outcome), /Rejected/);
      assert.equal(answer.values['choice'], 'reject');
    });
  });

  it('holds every agent once the person approves, and says so for each stream it reached', async () => {
    const inbox = fresh();
    const heard: AgentEvent[] = [];
    inbox.connect(agentCaller, 's2', (e) => heard.push(e));
    const card = inbox.proposeRequireCard({ on: true, by: { caller: agentCaller, agent: 's1' } });
    assert.equal(heard.some((e) => e.type === 'settings'), false, 'a proposal tells nobody until it is approved');
    await inbox.answer(card.id, { values: { choice: 'approve' } });
    assert.equal(inbox.requireCard().mode, 'all');
    assert.equal(inbox.requireCardFor('s2').on, true);
    assert.equal(inbox.requireCardFor('anyone else').on, true);
    // A live stream hears the new rule, which is what spares a running session a restart.
    assert.ok(heard.some((e) => e.type === 'settings'), 'the connected agent hears the rule change');
    assert.match(String(inbox.getCard(card.id).closed?.outcome), /Approved/);
  });

  it('changes nothing when the card is gone before the person answers', async () => {
    const inbox = fresh();
    const card = inbox.proposeRequireCard({ on: true, by: { caller: agentCaller, agent: 's1' } });
    // The person dismisses it without choosing, and the rule stays as it was.
    inbox.dismiss(ownerCaller, card.id, { comment: 'Never mind.' });
    assert.equal(inbox.requireCardFor('s1').on, false, 'a dismissed proposal applies nothing');
    // Answering the dismissed proposal again does not apply what the first answer dropped.
    await inbox.answer(card.id, { values: { choice: 'approve' } });
    assert.equal(inbox.requireCardFor('s1').on, false, 'a closed proposal applies nothing, whoever answers it later');
    // A card that expired before it was answered is gone, and answering it says so rather than applying a rule.
    await assert.rejects(() => inbox.answer(`${card.id}-gone`, { values: { choice: 'approve' } }), /unknown card/);
    const later = inbox.proposeRequireCard({ on: true });
    await inbox.answer(later.id, { values: { choice: 'approve' } });
    assert.equal(inbox.requireCardFor('s1').on, true);
  });

  it('is answered by the person alone, never by an agent of the inbox', async () => {
    const inbox = fresh();
    const handle = createHandler(inbox, { heartbeatMs: 50 });
    const owner = (await inbox.createToken('page', 'owner')).secret;
    const agentRecord = await inbox.createToken('agent a', 'agent');
    const agentToken = agentRecord.secret;
    const post = await handle(new Request('http://inbox.local/v1/settings/require-card', {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', on: true, agent: 's1' }),
    }));
    assert.equal(post.status, 201);
    const card = await post.json() as { id: string };
    // An agent of this inbox reads the card and cannot approve the rule that governs its neighbours.
    const refused = await handle(new Request(`http://inbox.local/v1/cards/${card.id}/answer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: { choice: 'approve' } }),
    }));
    assert.equal(refused.status, 403);
    assert.equal(inbox.requireCardFor('s1').on, false, 'the refused answer changed nothing');
    // The person, and only the person, applies it.
    const applied = await handle(new Request(`http://inbox.local/v1/cards/${card.id}/answer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: { choice: 'approve' } }),
    }));
    assert.equal(applied.status, 200);
    assert.equal(inbox.requireCardFor('s1').on, true);

    // A rule says whether someone is asked, so a lookalike value is refused rather than read as off.
    const lookalike = await handle(new Request('http://inbox.local/v1/settings/require-card', {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', on: 'true', agent: 's1' }),
    }));
    assert.equal(lookalike.status, 400);

    // A session changes its own rule: a token with no stream as that agent cannot change one it does not run.
    const selfPath = 'http://inbox.local/v1/settings/require-card';
    const stranger = await handle(new Request(selfPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'self', on: false, agent: 'someone-else' }),
    }));
    assert.equal(stranger.status, 403);
    assert.equal(inbox.requireCardFor('someone-else').on, true, 'the refused change left the rule alone');
    inbox.connect({ token: agentRecord.token.id, role: 'agent' }, 'agent a', () => {});
    const mine = await handle(new Request(selfPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'self', on: true, agent: 'agent a' }),
    }));
    assert.equal(mine.status, 200);
    assert.equal(inbox.requireCardFor('agent a').on, true);
  });

  it('stops a session from stepping out of a rule that names every agent', () => {
    const inbox = fresh();
    inbox.setSettings({ requireCard: { mode: 'all', reminders: 2 } });
    assert.throws(() => inbox.setRequireCardForAgent('s1', false), /asks every agent for a card/);
    assert.equal(inbox.requireCardFor('s1').on, true);
  });

  it('refuses a rule the inbox cannot keep', () => {
    const inbox = fresh();
    assert.throws(() => inbox.setSettings({ requireCard: { mode: 'agents', reminders: 3 } }), /needs at least one agent/);
    assert.throws(() => inbox.setSettings({ requireCard: { mode: 'all', reminders: 11 } }), /whole number from 0 to 10/);
    // `agents` takes a list, so a string is refused with 400 rather than crashing on map.
    assert.throws(() => inbox.setSettings({ requireCard: { mode: 'agents', agents: 's1' } } as never), /must be a list of agent ids/);
    assert.throws(() => inbox.setSettings({ requireCard: { mode: 'sometimes', reminders: 3 } } as never), /must be off, all or agents/);
  });
});

describe('the environment override', () => {
  it('decides for the session, and beats the inbox in both directions', () => {
    assert.equal(envRequireCard({}), undefined, 'no value hands the session to the inbox');
    assert.deepEqual(envRequireCard({ YOUR_ATTENTION_REQUIRE_CARD: '1' }), { on: true, reminders: ENV_REMINDERS });
    assert.deepEqual(envRequireCard({ YOUR_ATTENTION_REQUIRE_CARD: '0' }), { on: false, reminders: ENV_REMINDERS });
    // The inbox asks every agent, the environment says not this one, and the environment wins.
    assert.deepEqual(resolveRequireCard({ YOUR_ATTENTION_REQUIRE_CARD: '0' }, { on: true, reminders: 3 }), { on: false, reminders: ENV_REMINDERS });
    // The inbox asks nobody, the environment says this one posts, and the environment wins.
    assert.deepEqual(resolveRequireCard({ YOUR_ATTENTION_REQUIRE_CARD: '1' }, { on: false, reminders: 0 }), { on: true, reminders: ENV_REMINDERS });
    // Without a value the inbox's own count applies, including 0, which never asks.
    assert.deepEqual(resolveRequireCard({}, { on: true, reminders: 0 }), { on: true, reminders: 0 });
  });
});
