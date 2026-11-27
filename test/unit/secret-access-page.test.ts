import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accessCandidates, accessValue, candidateDetail, candidateGroups, candidateKey, CEILINGS, describe as describeAnswer, revocableGrants } from '../../web/answers.js';
import { GRANT_DEFAULT_MS, GRANT_IDLE_MS, GRANT_MAX_MS } from '../../src/core/secret-sources.ts';
import { GRANT_IDLE_MS as PAGE_IDLE_MS } from '../../web/answers.js';
import type { Card } from '../../src/core/types.ts';

const list = [
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'laptop', type: 'api-key', host: 'api.openai.com' },
  { id: 'openai', label: 'OpenAI key, team', source: 'vault', instance: 'laptop', status: 'off', reason: 'the vault is locked' },
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'desktop' },
];

describe('the candidates of a secret_access field', () => {
  it('reads a missing status as ready, and keeps the status a source gave', () => {
    const c = accessCandidates(JSON.stringify(list));
    assert.deepEqual(c.map((x) => x.ready), [true, false, true]);
    assert.equal(c[1]?.reason, 'the vault is locked');
  });

  it('reads text that is not a list of candidates as none', () => {
    assert.deepEqual(accessCandidates('not json'), []);
    assert.deepEqual(accessCandidates('{"id": "x"}'), []);
    assert.deepEqual(accessCandidates('[{"id": "x"}]'), []);
  });

  it('tells apart one id offered by two sources and by two instances', () => {
    const keys = accessCandidates(JSON.stringify(list)).map(candidateKey);
    assert.equal(new Set(keys).size, 3);
  });

  it('names the store, so two age files of one name in two folders draw as two different rows', () => {
    const [a, b] = accessCandidates(JSON.stringify([
      { id: '/home/me/.secrets/db.age', label: 'db', store: '~/.secrets', source: 'age', instance: 'laptop', type: 'file' },
      { id: '/home/me/work/.secrets/db.age', label: 'db', store: '~/work/.secrets', source: 'age', instance: 'laptop', type: 'file' },
    ]));
    assert.equal(candidateDetail(a!), 'age on laptop · ~/.secrets · file');
    assert.notEqual(candidateDetail(a!), candidateDetail(b!));
  });

  it('groups the candidates by instance, in the order the inbox gave them', () => {
    const groups = candidateGroups(accessCandidates(JSON.stringify(list)));
    assert.deepEqual(groups.map((g) => [g.instance, g.candidates.length]), [['laptop', 2], ['desktop', 1]]);
  });
});

describe('the value a secret_access field answers', () => {
  const candidates = accessCandidates(JSON.stringify(list));
  const now = 1_700_000_000_000;

  const grant = (i: number, ceiling?: number) => accessValue({ pick: candidateKey(candidates[i]!), ...(ceiling === undefined ? {} : { ceiling }) }, candidates, now);

  it('grants the picked candidate until the answer time plus the ceiling', () => {
    assert.deepEqual(grant(2, 4 * 3600_000), { grant: 'openai', source: 'age', instance: 'desktop', until: now + 4 * 3600_000 });
  });

  it('caps the ceiling at 24 hours, and uses one hour when none was picked', () => {
    assert.deepEqual(grant(0, 48 * 3600_000), { grant: 'openai', source: 'age', instance: 'laptop', until: now + GRANT_MAX_MS });
    assert.deepEqual(grant(0), { grant: 'openai', source: 'age', instance: 'laptop', until: now + GRANT_DEFAULT_MS });
  });

  it('declines only on an explicit decline', () => {
    assert.deepEqual(accessValue({ pick: 'decline' }, candidates, now), { decline: true });
  });

  it('answers nothing for an untouched field, an unavailable candidate, or a typed value it must seal first', () => {
    assert.equal(accessValue({}, candidates, now), undefined);
    assert.equal(accessValue({ pick: candidateKey(candidates[1]!) }, candidates, now), undefined);
    assert.equal(accessValue({ pick: 'type', value: 'x' }, candidates, now), undefined);
  });

  it('offers ceilings from the default up to 24 hours, and the same idle window as the grant store', () => {
    assert.ok(CEILINGS.some((c) => c.ms === GRANT_DEFAULT_MS));
    assert.equal(Math.max(...CEILINGS.map((c) => c.ms)), GRANT_MAX_MS);
    assert.equal(PAGE_IDLE_MS, GRANT_IDLE_MS);
  });
});

describe('an answered secret_access field', () => {
  const body = [
    'root = Card([db, ai])',
    'db = Form("DATABASE_URL", b1, [f1])', 'b1 = Buttons([])', 'f1 = FormControl("DATABASE_URL", SecretAccess("DATABASE_URL", "{}", "[]"))',
    'ai = Form("OPENAI_API_KEY", b2, [f2])', 'b2 = Buttons([])', 'f2 = FormControl("OPENAI_API_KEY", SecretAccess("OPENAI_API_KEY", "{}", "[]"))',
  ].join('\n');
  const card = { id: 'c1', agent: 'a', kind: 'ask', title: 't', priority: 'now', deliver: 'stream', version: 1, createdAt: 0, updatedAt: 0, replies: [], body, secrets: ['DATABASE_URL', 'OPENAI_API_KEY'] } as unknown as Card;
  const sealed = { alg: 'RSA-OAEP-256+A256GCM', key: 'k', iv: 'i', data: 'd' };
  const at = Date.UTC(2026, 10, 27, 15, 0);
  const grant = { grant: 'db', source: 'age', instance: 'laptop', until: at + 3600_000, case: 'K7Q2', sealed };

  it('reads as a grant with its case, and as a decline, never as ciphertext', () => {
    const text = describeAnswer(card, { values: { DATABASE_URL: grant, OPENAI_API_KEY: { decline: true } }, comment: '', savedAt: at } as never);
    assert.match(text, /DATABASE_URL: Granted db from age on laptop until .*, case K7Q2/);
    assert.match(text, /OPENAI_API_KEY: Declined/);
    assert.doesNotMatch(text, /RSA-OAEP|"data"/);
  });

  it('says when the person revoked it', () => {
    const text = describeAnswer(card, { values: { DATABASE_URL: { ...grant, revokedAt: at + 60_000 } }, comment: '', savedAt: at } as never);
    assert.match(text, /DATABASE_URL: Granted .*, revoked at/);
  });

  it('can be revoked until its ceiling passes, and not once revoked', () => {
    const answer = { values: { DATABASE_URL: grant, OPENAI_API_KEY: { ...grant, grant: 'ai', revokedAt: at } }, comment: '', savedAt: at } as never;
    assert.deepEqual(revocableGrants(answer, at + 60_000).map((g) => g.field), ['DATABASE_URL']);
    assert.deepEqual(revocableGrants(answer, at + 3600_000), []);
    assert.deepEqual(revocableGrants(undefined, at), []);
  });
});
