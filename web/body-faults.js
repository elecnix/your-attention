// What keeps the page from drawing all of a card body, and what it draws instead. Both read a body with the result of
// the OpenUI parser, `{root, meta}`: the inbox gets it from @openuidev/lang-core (src/adapters/openui-body.ts), and the page
// from its Renderer. So a laptop inbox and a page on the hosted inbox, which takes bodies unchecked, find the same faults.
// This module reads no browser globals, so Node can load it.

/** What keeps the page from drawing all of a body, one sentence each. Empty when the page draws it whole. */
export function bodyFaults(body, parsed) {
  const { root, meta } = parsed;
  const starts = statementStarts(body);
  // Any line that reads as a root statement counts, even one an unclosed string hides, so that error names the string.
  if (!/^[ \t]*root[ \t]*=/m.test(body)) return ['the body has no `root = ...` statement. Put Markdown in text, and OpenUI Lang in body.'];
  const errors = [];
  if (meta.incomplete) {
    const last = starts[meta.statementCount - 1];
    const where = last ? `\`${last.name}\` (line ${last.line})` : 'the last statement';
    errors.push(`${where} has a string that never closes, so the page drops it and every statement after it. Open and close each string with a plain ", and write \\" only for a quote inside a string.`);
  }
  for (const name of meta.unresolved) errors.push(`\`${name}\` is used but never defined.`);
  for (const e of meta.errors) errors.push(`\`${e.statementId ?? 'root'}\`: ${e.message}.`);
  if (!root && !errors.length) errors.push('the page draws nothing from this body.');
  return errors;
}

/** Two bodies to draw in place of one with faults. `partial` keeps the statements before the first broken one as the agent
 * wrote them, then the source from it on, and is undefined when its root can't take the source. `whole` is the source alone.
 * The caller draws `partial` when it has no faults of its own, and `whole` otherwise. */
export function fallbackSources(body, parsed) {
  const { meta } = parsed;
  const starts = statementStarts(body);
  // An unclosed string hides every statement from its own on. Before it, a statement with a broken call draws nothing.
  const cut = meta.incomplete ? (starts[meta.statementCount - 1]?.at ?? 0) : body.length;
  const failed = new Set(meta.errors.map((e) => e.statementId).filter((id) => !!id && id !== 'root'));
  const segments = starts.filter((st) => st.at < cut).map((st, i, all) => ({ ...st, text: body.slice(st.at, all[i + 1]?.at ?? cut).replace(/\n+$/, '') }));
  const kept = segments.filter((st) => !failed.has(st.name));
  const shown = [...segments.filter((st) => failed.has(st.name)).map((st) => st.text), body.slice(cut).replace(/\n+$/, '')].filter(Boolean).join('\n');
  const source = (text) => `yaSource = CodeBlock("text", ${JSON.stringify(text)})`;
  const whole = `root = Card([yaSource])\n${source(body)}`;
  // The root keeps the children the kept statements define, then the source, after what did draw.
  const defined = new Set(kept.map((st) => st.name));
  let joined = false;
  const lines = kept.map((st) => st.name !== 'root' ? st.text : st.text.replace(/^([ \t]*root[ \t]*=[ \t]*Card\(\[)([^\]\n]*)\]/, (_, open, kids) => {
    joined = true;
    return `${open}${[...kids.split(',').map((k) => k.trim()).filter((k) => defined.has(k)), 'yaSource'].join(', ')}]`;
  }));
  return { partial: joined ? `${lines.join('\n')}\n${source(shown || bodyFaults(body, parsed).join('\n'))}` : undefined, whole };
}

/** Each line that starts a statement, in order, as the parser counts them. A line inside a string belongs to the statement before it. */
function statementStarts(body) {
  const starts = [];
  let quote = '';
  let line = 1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\n') line++;
    if (quote) {
      if (c === '\\') { if (body[i + 1] === '\n') line++; i++; } else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (i === 0 || body[i - 1] === '\n') {
      const m = /^[ \t]*([A-Za-z_]\w*)[ \t]*=/.exec(body.slice(i, i + 200));
      if (m) starts.push({ name: m[1], line, at: i });
    }
  }
  return starts;
}
