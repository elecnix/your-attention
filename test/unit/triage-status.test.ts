// The triage status the card header shows: not triaged, being checked, triaged, or triaged without checks because the
// agent used a bypass code. Each one carries the sentence the page puts in the badge's tooltip.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { triageState } from '../../web/queue.js';

const card = (triage?: unknown) => ({ id: 'c1', agent: 's1', kind: 'ask', title: 'q', priority: 'soon', deliver: 'stream', version: 1, createdAt: 1, updatedAt: 1, replies: [], ...(triage === undefined ? {} : { triage }) });

describe('the triage status of a card', () => {
  it('says not triaged when no extension checked it, and quotes the reason the inbox stored', () => {
    const [tone, why] = triageState(card({ state: 'skipped', reason: 'No triage extension was connected.', at: 1 }) as never);
    assert.equal(tone, 'none');
    assert.match(why, /^Not triaged/);
    assert.match(why, /No triage extension was connected/);
  });

  it('says not triaged on a card with no triage field at all', () => {
    const [tone, why] = triageState(card() as never);
    assert.equal(tone, 'none');
    assert.match(why, /^Not triaged/);
  });

  it('says checking, with the extension that is checking, while an extension is still deciding', () => {
    const [tone, why] = triageState(card({ state: 'pending', by: 'triage-example', at: 1 }) as never);
    assert.equal(tone, 'checking');
    assert.equal(why, 'Not triaged yet: triage-example is checking this card');
  });

  it('says triaged when an extension passed the card, and names the extension', () => {
    const [tone, why] = triageState(card({ state: 'passed', by: 'triage-example', reason: 'Every check that ran passed the card.', at: 1 }) as never);
    assert.equal(tone, 'done');
    assert.match(why, /^Triaged by triage-example/);
    assert.match(why, /Every check that ran passed the card/);
  });

  it('says triaged on a card an extension sent back, without quoting the whole notice', () => {
    const [tone, why] = triageState(card({ state: 'returned', by: 'triage-example', reason: 'x'.repeat(4000), at: 1 }) as never);
    assert.equal(tone, 'done');
    assert.match(why, /sent this card back/);
    assert.ok(why.length < 200);
  });

  it('says triaged when an extension held the card', () => {
    const [tone, why] = triageState(card({ state: 'held', by: 'triage', reason: 'Waiting for the owner.', at: 1 }) as never);
    assert.equal(tone, 'done');
    assert.match(why, /held/);
  });

  it('says bypass when the extension reported that a bypass code skipped its checks', () => {
    const [tone, why] = triageState(card({ state: 'passed', by: 'triage-example', reason: 'Passed without checks: the agent used a triage bypass code for an urgent card.', bypass: true, at: 1 }) as never);
    assert.equal(tone, 'bypass');
    assert.match(why, /bypass/i);
  });
});
