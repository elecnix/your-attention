// The page's search, which runs in the browser over what the page already holds: each card's summary from GET /v1/state, and the
// whole card and answer where the page has fetched them. It never asks the inbox for anything. Matching is case-insensitive
// substring, and a card matches when every word of the query is somewhere in it.

/** The words of a query: lowercase, split on spaces. A blank query has none. */
export const searchTerms = (query) => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);

const flat = (v) => (Array.isArray(v) ? v.map(flat).join(' ') : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

// The fields of a card, each as [label, text]. The title comes first, so a title match needs no snippet.
function fieldsOf(summary, detail) {
  const card = (detail && detail.card) || {};
  const answer = (detail && detail.answer) || null;
  const o = summary.origin || {};
  const tags = Object.entries(summary.tags || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
  const options = (card.options || []).map((x) => `${x.label} ${x.description || ''}`).join(' · ');
  const questions = (card.questions || []).map((q) => [q.header, q.question, q.text, ...(q.options || []).map((x) => `${x.label} ${x.description || ''}`)].filter(Boolean).join(' ')).join(' · ');
  return [
    ['Title', summary.title],
    ['Tag', tags],
    ['Agent', [o.name, summary.from, summary.agent].filter(Boolean).join(' · ')],
    ['Status', summary.status || ''],
    ['Text', card.text ?? summary.preview ?? ''],
    ['Recommendation', card.recommendation || ''],
    ['Options', options],
    ['Questions', questions],
    ['Reply', (card.replies || []).map((r) => r.text).join(' · ')],
    ['Answer', answer ? [answer.comment, ...Object.values(answer.values || {}).map(flat)].filter(Boolean).join(' · ') : ''],
    ['Outcome', summary.closed ? summary.closed.outcome || '' : ''],
  ];
}

const around = (label, text, term) => {
  const one = text.replace(/\s+/g, ' ');
  const at = one.toLowerCase().indexOf(term);
  const start = Math.max(0, at - 30);
  const end = at + term.length;
  return { label, before: (start > 0 ? '…' : '') + one.slice(start, at), hit: one.slice(at, end), after: one.slice(end, end + 60) + (end + 60 < one.length ? '…' : '') };
};

/** Null when the card lacks a term, else `{snippet}` with the first term's place outside the title, when it is not in the title. */
export function matchCard(terms, summary, detail) {
  if (!terms.length) return {};
  const fields = fieldsOf(summary, detail).map(([label, text]) => [label, String(text || '')]);
  const lower = fields.map(([, text]) => text.toLowerCase());
  const all = lower.join('\n');
  if (!terms.every((t) => all.includes(t))) return null;
  if (lower[0].includes(terms[0])) return {};
  const i = lower.findIndex((text) => text.includes(terms[0]));
  return i < 0 ? {} : { snippet: around(fields[i][0], fields[i][1], terms[0]) };
}

/** A text split into parts, each flagged when it matches a term. The parts join back into the text. */
export function highlightParts(text, terms) {
  const t = String(text);
  if (!terms.length) return [{ text: t, hit: false }];
  const lower = t.toLowerCase();
  const marked = new Array(t.length).fill(false);
  for (const term of terms) for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) marked.fill(true, at, at + term.length);
  const parts = [];
  for (let i = 0; i < t.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marked[i]) last.text += t[i]; else parts.push({ text: t[i], hit: marked[i] });
  }
  return parts.length ? parts : [{ text: t, hit: false }];
}
