// Short stable IDs for each form, field and option of a card. The inbox stores none of them: each one is a hash of the
// card id, the card version, the form's position in the source the page draws, the field name and the option, so every
// reader derives the same ID, and a patch, which bumps the version, changes every ID of the card. The page, the terminal
// client and the agent's client share this file. It touches no browser API.
import { cardSource, optionId, optionValue, parseSource } from './answers.js';

/** Characters per ID. 64 to the power 4 is 2^24 values. */
export const ID_CHARS = 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// FNV-1a over the UTF-8 bytes, then the murmur3 finalizer, so every input bit reaches the 24 bits an ID keeps.
function hash32(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The ID of one set of hash inputs: ID_CHARS characters of a URL-safe alphabet. */
export function shortId(parts) {
  let h = hash32(parts.join('\u0000'));
  let out = '';
  for (let i = 0; i < ID_CHARS; i++, h >>>= 6) out += ALPHABET[h & 63];
  return out;
}

// What each field component of the source asks for. The comment fields are the page's own.
const FIELD_KINDS = {
  OptionCards: 'choice', RadioGroup: 'choice', Select: 'choice', CheckBoxGroup: 'choice', SwitchGroup: 'choice',
  Input: 'text', TextArea: 'text', Slider: 'number', DatePicker: 'date',
  SecretInput: 'secret', SecretAccess: 'access', PrivilegedAction: 'action',
};

// The value each item of a choice names in the answer, by its component.
function itemValue(item) {
  const [a0, , a2] = item.args;
  if (item.call === 'RadioItem' || item.call === 'CheckBoxItem' || item.call === 'SwitchItem') return a2;
  if (item.call === 'SelectItem' || item.call === 'OptionCard') return a0;
  return undefined;
}

/** The forms of a card in the order the page draws them, each with its fields in order, and each choice with the values
 * its items name. A field outside every form sends with the answer form, which comes last. */
function forms(card) {
  const st = parseSource(cardSource(card));
  const out = [];
  const loose = [];
  const seen = new Set();
  const walk = (node, form) => {
    if (Array.isArray(node)) { for (const n of node) walk(n, form); return; }
    if (!node || typeof node !== 'object') return;
    if (node.ref) {
      if (seen.has(node.ref) || !st[node.ref]) return;
      seen.add(node.ref);
      walk(st[node.ref], form);
      return;
    }
    if (!node.call) return;
    if (node.call === 'Form') {
      const f = { name: formName(card, node.args[0]), fields: [] };
      out.push(f);
      walk(node.args.slice(1), f);
      return;
    }
    const kind = FIELD_KINDS[node.call];
    if (kind && typeof node.args[0] === 'string') {
      const name = node.args[0];
      const items = (node.args.find(Array.isArray) ?? []).map((it) => (it && it.ref ? st[it.ref] : it)).filter((it) => it && it.call);
      const options = kind === 'choice' ? items.map(itemValue).filter((v) => typeof v === 'string').map((v) => optionName(card, name, v)) : [];
      const field = { name, kind: name === 'comment' || /^q\d+_comment$/.test(name) ? 'comment' : kind, options };
      (form ? form.fields : loose).push(field);
      return;
    }
    walk(node.args, form);
  };
  if (st.root) { seen.add('root'); walk(st.root, undefined); }
  const last = out.at(-1);
  if (last) last.fields.push(...loose);
  else if (loose.length) out.push({ name: 'answer', fields: loose });
  // The page draws each approval as a switch under the card, and it sends with the answer form.
  (card.approvals ?? []).forEach((_, i) => out.at(-1)?.fields.push({ name: `approval_${i}`, kind: 'approval', options: [] }));
  return out;
}

// The page names its own forms after the card id. An ID list names them without it, so the card id appears once.
function formName(card, name) {
  const n = String(name ?? '');
  if (n === card.id || n === 'yaAnswer') return 'answer';
  return n.startsWith(`${card.id}:`) ? n.slice(card.id.length + 1) : n;
}

// The page's own option boxes name an option by its id and label; the ID list names it by its id alone.
function optionName(card, field, value) {
  if (field !== 'choice') return value;
  const o = (card.options ?? []).find((x) => optionValue(x) === value);
  return o ? optionId(o) : value;
}

/**
 * Every form, field and option of a card at its version, in the order the page draws them. A form is {id, name, kind:
 * "form"}; a field is {id, form, name, kind}, where `form` is its form's ID; an option is {id, form, field, name, kind:
 * "option"}, where `field` is its field's ID. IDs are distinct within one version: the rare input whose hash an earlier
 * entry already took is hashed again with a counter, the same way for every reader.
 */
export function cardFields(card) {
  const taken = new Set();
  const id = (parts) => {
    let out = shortId(parts);
    for (let n = 1; taken.has(out); n++) out = shortId([...parts, String(n)]);
    taken.add(out);
    return out;
  };
  const list = [];
  forms(card).forEach((f, pos) => {
    const base = [card.id, String(card.version), String(pos)];
    const formId = id(base);
    list.push({ id: formId, name: f.name, kind: 'form' });
    for (const field of f.fields) {
      const fieldId = id([...base, field.name]);
      list.push({ id: fieldId, form: formId, name: field.name, kind: field.kind });
      for (const o of field.options) list.push({ id: id([...base, field.name, o]), form: formId, field: fieldId, name: o, kind: 'option' });
    }
  });
  return list;
}

/** The card as it was at one version: the body, HTML, options, questions and approvals that version had, which its
 * history entry holds; storage drops a field the version left empty, so an absent one was empty. A version the history no
 * longer holds keeps the current structure under its own number, so its IDs still differ from the current ones. */
export function cardAt(card, version) {
  if (version === undefined || version === card.version) return card;
  const past = (card.history ?? []).find((h) => h.version === version);
  if (!past) return { ...card, version };
  const { body, html, options, multiple, questions, approvals } = past;
  return { ...card, body, html, options, multiple, questions, approvals, version };
}

/** The ID of each value and of the comment of an answer, from the version it answered, and whether that version is
 * still the card's. `stale` names the version answered and the card's version now, and `unknown` the IDs the card no
 * longer lists. */
export function answerFields(card, answer) {
  // A card without a version, as a stand-in in a test, has one set of IDs, and no answer to it is stale.
  const version = typeof answer.version === 'number' && typeof card.version === 'number' ? answer.version : card.version;
  const then = cardFields(cardAt(card, version));
  const answerForm = then.filter((f) => f.kind === 'form').at(-1);
  const byName = new Map();
  for (const f of then) if (f.kind !== 'form' && f.kind !== 'option' && !byName.has(f.name)) byName.set(f.name, f);
  const fields = [];
  for (const name of Object.keys(answer.values ?? {})) {
    const f = byName.get(name);
    // A field the source does not name, such as one an HTML card sends, takes an ID in the answer form all the same.
    fields.push(f ? { id: f.id, form: f.form, name, kind: f.kind } : { id: shortId([card.id, String(version), 'answer', name]), form: answerForm?.id, name, kind: 'text', unlisted: true });
  }
  const comment = then.find((f) => f.name === 'comment' && f.form === answerForm?.id);
  if (answer.comment && comment) fields.push({ id: comment.id, form: comment.form, name: 'comment', kind: 'comment' });
  const now = new Set(cardFields(card).map((f) => f.id));
  // Only an ID the answered version listed can go missing: a field no version lists is no sign of an earlier one.
  const unknown = fields.filter((f) => !f.unlisted && !now.has(f.id)).map((f) => f.id);
  for (const f of fields) delete f.unlisted;
  const stale = version !== card.version || unknown.length > 0;
  return { version, fields, ...(stale ? { stale: { answered: version, current: card.version, unknown } } : {}) };
}

/** The IDs of a card as an agent reads them, a line per form: each field's ID and name, and each option's ID and name. */
export function describeFields(fields) {
  const lines = [];
  for (const form of fields.filter((f) => f.kind === 'form')) {
    const parts = fields.filter((f) => f.form === form.id && f.kind !== 'option').map((f) => {
      const opts = fields.filter((o) => o.field === f.id).map((o) => `${o.id} ${o.name}`);
      return `${f.id} ${f.name} (${f.kind}${opts.length ? `: ${opts.join(', ')}` : ''})`;
    });
    lines.push(`Form ${form.id} ${form.name}: ${parts.join('; ') || 'no fields'}`);
  }
  return lines.join('\n');
}
