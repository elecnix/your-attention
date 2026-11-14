// The agents panel of the page: who the inbox knows, and how it reads each one's state.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Presence } from '../../src/core/types.ts';
import { agentList } from '../../web/agents.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

type Cards = Parameters<typeof agentList>[0]['cards'];

/** GET /v1/state, cut to what the panel reads: the card summaries, and presence. */
const state = (presence: Record<string, Presence>, cards: Cards = []) => ({ cards, presence });

/** A card summary, cut to the fields the panel reads. */
const card = (agent: string, origin: { name?: string; cwd?: string }, createdAt = NOW - HOUR) =>
  ({ id: `c-${agent}`, agent, kind: 'ask', title: 'Deploy now?', priority: 'soon', deliver: 'stream', version: 1, createdAt, updatedAt: createdAt, origin, rev: 'r' }) as unknown as NonNullable<Cards>[number];

describe('the agents the panel lists', () => {
  it('lists a connected agent with the name and the working directory its card reports', () => {
    const rows = agentList(state({ 'claude:s1': { agent: 'claude:s1', online: true, lastSeen: NOW - HOUR } }, [card('claude:s1', { name: 'storage', cwd: '/home/nicolas/Source/acme/api' })]), NOW);
    assert.deepEqual(rows, [{
      id: 'claude:s1',
      name: 'storage',
      cwd: '/home/nicolas/Source/acme/api',
      online: true,
      lastSeen: null,
      channelOff: false,
      status: 'online',
      label: 'Connected now',
    }]);
  });

  it('shows an agent that went offline as offline, with when the inbox last saw it', () => {
    const rows = agentList(state({ 'pi:5f2a': { agent: 'pi:5f2a', online: false, lastSeen: NOW - 3 * HOUR } }, [card('pi:5f2a', { name: 'release' })]), NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.online, false, 'an offline agent never reads as connected');
    assert.equal(rows[0]?.status, 'offline');
    assert.equal(rows[0]?.label, 'Last seen 3 h ago');
    assert.equal(rows[0]?.lastSeen, NOW - 3 * HOUR);
    assert.equal(rows[0]?.cwd, null, 'the inbox shows no directory it does not have');
  });

  it('lists an agent whose presence the inbox never kept, from its card, as never connected', () => {
    const rows = agentList(state({}, [card('cli:deploy', { name: 'deploy' })]), NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 'cli:deploy');
    assert.equal(rows[0]?.online, false);
    assert.equal(rows[0]?.status, 'unknown');
    assert.equal(rows[0]?.lastSeen, null);
    assert.equal(rows[0]?.label, 'Never connected');
  });

  it('says a connected session drops channel notifications, since a card pushed there reaches no model', () => {
    const rows = agentList(state({ 'claude:s2': { agent: 'claude:s2', online: true, lastSeen: NOW, channelOff: true } }), NOW);
    assert.equal(rows[0]?.channelOff, true);
    assert.equal(rows[0]?.label, 'Connected, but its session drops channel notifications');
  });

  it('puts the connected agents first, then the one seen most recently', () => {
    const rows = agentList(state({
      'a:old': { agent: 'a:old', online: false, lastSeen: NOW - 30 * HOUR },
      'b:recent': { agent: 'b:recent', online: false, lastSeen: NOW - HOUR },
      'c:away': { agent: 'c:away', online: false, lastSeen: NOW - 5 * HOUR },
      'd:here': { agent: 'd:here', online: true, lastSeen: NOW },
    }), NOW);
    assert.deepEqual(rows.map((r) => r.id), ['d:here', 'b:recent', 'c:away', 'a:old']);
  });

  it('leaves out the inbox\'s own system agent, which is no session to send a card to', () => {
    assert.deepEqual(agentList(state({ system: { agent: 'system', online: true, lastSeen: NOW } as Presence }), NOW), []);
  });

  it('names an agent by its id when no card reported a session name', () => {
    const rows = agentList(state({ 'pi:9c1': { agent: 'pi:9c1', online: true, lastSeen: NOW } }), NOW);
    assert.equal(rows[0]?.name, 'pi:9c1');
  });
});
