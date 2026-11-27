// Short IDs for each form, field and option of a card. Every reader derives them from the card id, the version, the
// form's position and the field name, so the agent's post reply and the answer it gets back name the same fields, and a
// patch, which bumps the version, changes every ID.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAnswer, describeCardFields } from '../../src/client.ts';
import { InboxError } from '../../src/core/inbox.ts';
import { describe as describeForPerson } from '../../web/answers.js';
import { answerFields, cardFields, ID_CHARS } from '../../web/field-ids.js';
import { agent, setup } from './fixture.ts';

// Two forms of two fields each: a choice and a text in the first, a date and a slider in the second.
const TWO_FORMS = [
  'root = Card([plan, when])',
  'plan = Form("plan", planButtons, [pickControl, noteControl])',
  'planButtons = Buttons([])',
  'pickControl = FormControl("Which plan?", RadioGroup("pick", [small, large]))',
  'small = RadioItem("Small", "", "small")',
  'large = RadioItem("Large", "", "large")',
  'noteControl = FormControl("Why?", Input("note", "Why"))',
  'when = Form("when", whenButtons, [dayControl, sizeControl])',
  'whenButtons = Buttons([])',
  'dayControl = FormControl("Which day?", DatePicker("day"))',
  'sizeControl = FormControl("How many?", Slider("size", 1, 10, 1))',
].join('\n');

const ofForm = (fields: ReturnType<typeof cardFields>, name: string) => {
  const form = fields.find((f) => f.kind === 'form' && f.name === name);
  return fields.filter((f) => f.form === form?.id && f.kind !== 'option');
};

describe('card field IDs', () => {
  it('give a card with two forms and four fields four distinct IDs of four characters', () => {
    const { inbox } = setup();
    const card = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which plan?', body: TWO_FORMS });
    const fields = cardFields(card);
    const own = [...ofForm(fields, 'plan'), ...ofForm(fields, 'when')];
    assert.deepEqual(own.map((f) => [f.name, f.kind]), [['pick', 'choice'], ['note', 'text'], ['day', 'date'], ['size', 'number']]);
    assert.equal(new Set(own.map((f) => f.id)).size, 4);
    for (const f of fields) assert.match(f.id, new RegExp(`^[A-Za-z0-9_-]{${ID_CHARS}}$`));
    assert.equal(ID_CHARS, 4);
    // Every entry of the card is distinct, the forms, the page's comment and the options included.
    assert.equal(new Set(fields.map((f) => f.id)).size, fields.length);
    assert.deepEqual(fields.filter((f) => f.kind === 'option').map((f) => f.name), ['small', 'large']);
    // The page's own answer form comes last, with the comment, and no entry repeats the card id.
    assert.deepEqual(ofForm(fields, 'answer').map((f) => f.kind), ['comment']);
    assert.ok(!JSON.stringify(fields).includes('c1'));
  });

  it('come back in the reply to card_post, a line per form', () => {
    const { inbox } = setup();
    const card = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which size?', options: [{ id: 'o1', label: 'Small' }, { id: 'o2', label: 'Large' }] });
    const [form, choice, small, large, comment] = cardFields(card);
    assert.deepEqual([form?.kind, choice?.name, small?.name, large?.name, comment?.name], ['form', 'choice', 'o1', 'o2', 'comment']);
    const text = describeCardFields(card);
    assert.match(text, /IDs of version 1/);
    assert.ok(text.includes(`Form ${form!.id} answer: ${choice!.id} choice (choice: ${small!.id} o1, ${large!.id} o2); ${comment!.id} comment (comment)`), text);
  });

  it('change on a patch, and an answer to the version the person opened carries the IDs the patched card no longer lists', async () => {
    const { inbox, connect, events } = setup();
    const posted = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which plan?', body: TWO_FORMS });
    const before = cardFields(posted);
    // The person opens the page on version 1; the agent patches the card meanwhile.
    const opened = inbox.state().cards.find((c) => c.id === 'c1')!;
    assert.equal(opened.version, 1);
    const patched = inbox.patchCard(agent, 'c1', [{ old: '"Why?"', new: '"Why this plan?"' }]);
    const after = cardFields(patched);
    assert.equal(patched.version, 2);
    for (const f of after) assert.ok(!before.some((b) => b.id === f.id), `${f.name} keeps no ID of version 1`);
    connect('s1');
    await inbox.answer('c1', { values: { pick: 'large', note: 'Room to grow' }, comment: 'Go', version: opened.version });
    const ev = events.find((e) => e.type === 'answer');
    assert.ok(ev && ev.type === 'answer');
    const ids = answerFields(ev.card, ev.answer);
    assert.equal(ids.version, 1);
    const byName = new Map(before.filter((f) => f.kind !== 'form').map((f) => [f.name, f.id]));
    assert.deepEqual(ids.fields.map((f) => [f.name, f.id]), [['pick', byName.get('pick')], ['note', byName.get('note')], ['comment', byName.get('comment')]]);
    assert.deepEqual(ids.stale, { answered: 1, current: 2, unknown: ids.fields.map((f) => f.id) });
    // The agent reads the version it answered first, then each value beside its ID.
    const text = describeAnswer(ev.card, ev.answer);
    assert.match(text.split('\n')[0]!, /version 1 of the card, and the card is now version 2/);
    assert.ok(text.includes(`[${byName.get('pick')}] pick: large`), text);
    assert.ok(text.includes(`[${byName.get('comment')}] Comment: Go`), text);
    // The card says which version the person answered, on the page and in the terminal client.
    assert.match(describeForPerson(inbox.getCard('c1'), inbox.state().answers['c1']), /^\(to version 1, before the agent revised the card to version 2\)\n/);
  });

  it('match the current version when the person answers the patched card, and the answer is not marked', async () => {
    const { inbox } = setup();
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which plan?', body: TWO_FORMS });
    const patched = inbox.patchCard(agent, 'c1', [{ old: '"Why?"', new: '"Why this plan?"' }]);
    const answer = await inbox.answer('c1', { values: { note: 'Room' }, version: 2 });
    const ids = answerFields(inbox.getCard('c1'), answer);
    assert.equal(ids.stale, undefined);
    assert.equal(ids.fields[0]!.id, cardFields(patched).find((f) => f.name === 'note')!.id);
    assert.doesNotMatch(describeAnswer(inbox.getCard('c1'), answer), /version/);
    assert.doesNotMatch(describeForPerson(inbox.getCard('c1'), answer), /before the agent revised/);
  });

  it('mark an answer whose IDs the card no longer has, and refuse a version the card never had', async () => {
    const { inbox } = setup();
    // Version 1 asks with options; version 2 drops them for a question. The history keeps what version 1 asked.
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which size?', options: [{ id: 'o1', label: 'Small' }] });
    const v1 = cardFields(inbox.getCard('c1'));
    inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which size?', questions: [{ question: 'How big?' }] });
    const answer = await inbox.answer('c1', { values: { choice: 'o1' }, version: 1 });
    const ids = answerFields(inbox.getCard('c1'), answer);
    assert.equal(ids.fields[0]!.id, v1.find((f) => f.name === 'choice')!.id);
    assert.deepEqual(ids.stale?.unknown, [ids.fields[0]!.id]);
    await assert.rejects(inbox.answer('c1', { values: {}, version: 3 }), (e: InboxError) => e.status === 400 && /from 1 to 2/.test(e.message));
    await assert.rejects(inbox.answer('c1', { values: {}, version: 0 }), (e: InboxError) => e.status === 400);
  });

  it('differ between two cards posted with the same content, because the card id differs', () => {
    const { inbox } = setup();
    const a = cardFields(inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which plan?', body: TWO_FORMS }));
    const b = cardFields(inbox.postCard(agent, { id: 'c2', agent: 's1', title: 'Which plan?', body: TWO_FORMS }));
    assert.deepEqual(a.map((f) => f.name), b.map((f) => f.name));
    for (const f of a) assert.ok(!b.some((x) => x.id === f.id), `${f.name} differs between the two cards`);
  });

  it('change for a renamed field and for every unchanged one on a patch, and hold still while the version does', () => {
    const { inbox } = setup();
    const v1 = inbox.postCard(agent, { id: 'c1', agent: 's1', title: 'Which plan?', body: TWO_FORMS });
    // The same version read twice gives the same IDs: nothing is random and nothing is stored.
    assert.deepEqual(cardFields(v1), cardFields(inbox.getCard('c1')));
    const v2 = inbox.patchCard(agent, 'c1', [{ old: 'Input("note"', new: 'Input("reason"' }]);
    const id = (card: typeof v1, name: string) => cardFields(card).find((f) => f.name === name)?.id;
    assert.equal(id(v2, 'note'), undefined);
    assert.ok(id(v2, 'reason'));
    assert.notEqual(id(v2, 'reason'), id(v1, 'note'));
    // The field the patch left alone changes too: an ID names a field of one version.
    assert.notEqual(id(v2, 'pick'), id(v1, 'pick'));
  });
});
