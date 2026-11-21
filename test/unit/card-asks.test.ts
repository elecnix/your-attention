// The timer that asks an inactive session for a card at 2, 5 and 10 minutes, on fake timers. The unit tests share one
// process, so the fake clock is set up inside the suite and never reaches another file.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { afterTurn, CardAsks, memoryStore, type StretchStore } from '../../src/integrations/card-asks.ts';
import { DEFAULT_CARD_DELAYS } from '../../src/core/require-card.ts';

const MIN = 60_000;
/** Let the promises a timer started settle. setImmediate is not faked, so it runs after every pending microtask. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

let store: StretchStore;
let asks: CardAsks;
let asked: number[];
let open: boolean;
let rule: { on: boolean; delays: number[] };

/** Move the fake clock to a minute, a step at a time, so each timer fires at its own moment. */
async function at(minute: number): Promise<void> {
  while (Date.now() < minute * MIN) {
    mock.timers.tick(Math.min(1000, minute * MIN - Date.now()));
    await settle();
  }
}

/** The session runs the turn an ask started, and ends it a few seconds later without posting a card. */
async function answerAsk(): Promise<void> {
  asks.began();
  mock.timers.tick(5000);
  asks.ended();
  await settle();
}

describe('asking an inactive session for a card', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    store = memoryStore();
    asked = [];
    open = false;
    rule = { on: true, delays: [...DEFAULT_CARD_DELAYS] };
    asks = new CardAsks({
      store,
      rule: async () => rule,
      hasOpenCard: async () => open,
      ask: () => { asked.push(Date.now() / MIN); },
      minuteMs: MIN,
    });
  });
  afterEach(() => {
    asks.stop();
    mock.timers.reset();
  });

  it('asks nothing before two minutes of inactivity', async () => {
    asks.ended();
    await settle();
    await at(1.9);
    assert.deepEqual(asked, []);
  });

  it('asks at 2, 5 and 10 minutes from when the session went inactive, then stops', async () => {
    asks.ended();
    await settle();
    await at(2);
    assert.deepEqual(asked, [2]);
    // The ask starts a turn of the session's own: that turn is not activity, so the next ask keeps its minute.
    await answerAsk();
    await at(5);
    assert.deepEqual(asked, [2, 5]);
    await answerAsk();
    await at(10);
    assert.deepEqual(asked, [2, 5, 10]);
    await answerAsk();
    await at(60);
    assert.deepEqual(asked, [2, 5, 10], 'three asks, then nothing until something happens');
  });

  it('restarts the stretch when the session does something at 3 minutes', async () => {
    asks.ended();
    await settle();
    await at(2);
    await answerAsk();
    await at(3);
    // The person types: a turn that no ask started.
    asks.began();
    await at(3.5);
    asks.ended();
    await settle();
    await at(5);
    assert.deepEqual(asked, [2], 'the 5 minute ask was cancelled');
    await at(5.5);
    assert.deepEqual(asked, [2, 5.5], 'the new stretch asks 2 minutes after its own start');
    await answerAsk();
    await at(8.5);
    assert.deepEqual(asked, [2, 5.5, 8.5]);
  });

  it('cancels the asks when activity arrives from outside a turn, such as an answer', async () => {
    asks.ended();
    await settle();
    await at(1);
    asks.activity();
    await at(20);
    assert.deepEqual(asked, []);
  });

  it('cancels the asks once a card of its own is open', async () => {
    asks.ended();
    await settle();
    await at(2);
    await answerAsk();
    open = true;
    await at(20);
    assert.deepEqual(asked, [2], 'an open card ends the stretch');
    assert.equal(store.load(), undefined);
  });

  it('asks nothing while the rule is off, and follows a schedule the rule changes', async () => {
    rule = { on: false, delays: [2, 5, 10] };
    asks.ended();
    await settle();
    await at(15);
    assert.deepEqual(asked, []);
    rule = { on: true, delays: [1, 4] };
    asks.began();
    asks.ended();
    await settle();
    await at(16);
    assert.deepEqual(asked, [16]);
    await answerAsk();
    await at(30);
    assert.deepEqual(asked, [16, 19]);
  });

  it('picks up a stretch a restarted process finds in its store, and asks once for the asks it missed', async () => {
    store.save({ since: 0, asks: 0 });
    await at(6);
    // A fresh process, such as the Claude channel after a restart, reads the same store.
    asks.stop();
    asks = new CardAsks({ store, rule: async () => rule, hasOpenCard: async () => open, ask: () => { asked.push(Date.now() / MIN); }, minuteMs: MIN });
    await asks.sync();
    mock.timers.tick(0);
    await settle();
    assert.deepEqual(asked, [6], 'the 2 and 5 minute asks were missed: one ask covers both');
    assert.deepEqual(store.load(), { since: 0, asks: 2, ours: true });
    await answerAsk();
    await at(10);
    assert.deepEqual(asked, [6, 10]);
  });
});

describe('the stretch after a turn ends', () => {
  it('starts a new stretch after a turn no ask started', () => {
    assert.deepEqual(afterTurn(undefined, 42), { since: 42, asks: 0 });
    assert.deepEqual(afterTurn({ since: 1, asks: 2 }, 42), { since: 42, asks: 0 });
  });
  it('keeps the stretch after the turn an ask started', () => {
    assert.deepEqual(afterTurn({ since: 1, asks: 2, ours: true }, 42), { since: 1, asks: 2 });
  });
});
