// How a card becomes OpenUI Lang, and how a filled form becomes the answer. The page and the terminal client share
// this file, so both send the same values for the same card. It touches no browser API.
const J = JSON.stringify;

// OpenUI Lang for a card that brings no body of its own.
export function cardSource(c) {
  // A body with forms of its own keeps them where the agent placed them, and gets the comment and buttons below.
  // So does a body with no form and no options or questions, so the card stays answerable.
  if (c.body && (/\bForm\(/.test(c.body) || (!c.options?.length && !c.questions?.length))) return withAnswerFooter(c.body);
  if (c.kind === 'blocked' && c.options && c.options.length) {
    // The sidecar read these choices from the agent's dialog, and presses the one you pick in that pane.
    return [
      'root = Card([screen, form])',
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      `form = Form(${J(c.id)}, buttons, [fcChoice])`,
      'fcChoice = FormControl("Your answer", choice)',
      `choice = OptionCards("choice", "single", [${c.options.map((_, j) => `c${j}`).join(', ')}])`,
      ...c.options.map((o, j) => `c${j} = OptionCard(${J(optionValue(o))}, ${J(o.label)}, "")`),
      'buttons = Buttons([save, go, skip], "row")',
      'save = Button("Press it in the session", @ToAssistant("send answer"), "primary")',
      'go = Button("Open session", @ToAssistant("open session"), "secondary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    ].join('\n');
  }
  if (c.kind === 'blocked') {
    return [
      'root = Card([screen, buttons])',
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      'buttons = Buttons([go, skip], "row")',
      'go = Button("Open session", @ToAssistant("open session"), "primary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    ].join('\n');
  }
  // The page shows the title above the text and attachments, so a generated card has no header.
  const parts = [];
  const L = [];
  if (c.body) { parts.push('custom'); L.push(c.body.replace(/^\s*root\s*=/m, 'custom =')); }
  const controls = [];
  (c.questions || []).forEach((q, i) => {
    controls.push(`fc${i}`);
    const opts = (q.options || []).map((o, j) => [`o${i}_${j}`, o]);
    L.push(`fc${i} = FormControl(${J(q.question)}, q${i})`);
    L.push(`q${i} = OptionCards("q${i}", ${J(q.multiSelect ? 'multiple' : 'single')}, [${opts.map(([r]) => r).join(', ')}])`);
    opts.forEach(([r, o]) => L.push(`${r} = OptionCard(${J(o.label)}, ${J(o.label)}, ${J(o.description || '')})`));
  });
  if (c.options && c.options.length) {
    controls.push('fcChoice');
    L.push('fcChoice = FormControl("Your answer", choice)');
    L.push(`choice = OptionCards("choice", ${J(c.multiple ? 'multiple' : 'single')}, [${c.options.map((_, j) => `c${j}`).join(', ')}])`);
    c.options.forEach((o, j) => L.push(`c${j} = OptionCard(${J(optionValue(o))}, ${J(o.label)}, ${J(o.description || '')})`));
  }
  controls.push('fcComment');
  L.push('fcComment = FormControl("Comment", comment)', 'comment = TextArea("comment", "Anything to add?", 3)');
  parts.push('form');
  L.push(`form = Form(${J(c.id)}, buttons, [${controls.join(', ')}])`,
    'buttons = Buttons([save, skip], "row")',
    'save = Button("Send answer", @ToAssistant("send answer"), "primary")',
    'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")');
  return [`root = Card([${parts.join(', ')}])`, ...L].join('\n');
}

// Every card ends with the page's comment box, Send answer and Skip. The page's statements start with ya, so they leave
// the agent's names alone. A body with a field of its own named comment keeps it, and the answer joins both texts.
function withAnswerFooter(body) {
  return [
    'root = Card([yaBody, yaAnswer])',
    body.replace(/^\s*root\s*=/m, 'yaBody ='),
    'yaAnswer = Form("yaAnswer", yaButtons, [yaFcComment])',
    'yaFcComment = FormControl("Comment", yaComment)',
    'yaComment = TextArea("comment", "Anything to add?", 3)',
    'yaButtons = Buttons([yaSave, yaSkip], "row")',
    'yaSave = Button("Send answer", @ToAssistant("send answer"), "primary")',
    'yaSkip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
  ].join('\n');
}

/** The statements of OpenUI Lang source, by name: each `name = Call(args)` with its strings, numbers and references. */
export function parseSource(source) {
  const out = {};
  for (const line of String(source || '').split('\n')) {
    const m = /^\s*(\w+)\s*=\s*(\w+)\((.*)\)\s*$/.exec(line);
    if (!m) continue;
    try { out[m[1]] = { call: m[2], args: parseArgs(m[3]) }; } catch {}
  }
  return out;
}

function parseArgs(text) {
  let i = 0;
  const space = () => { while (/\s/.test(text[i] || '')) i++; };
  const value = () => {
    space();
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const s = JSON.parse(text.slice(i, j + 1));
      i = j + 1;
      return s;
    }
    if (ch === '[') { i++; const list = items(']'); return list; }
    if (ch === '{') {
      // An object inside the arguments, such as rules: skip to the matching close.
      const close = '}';
      let depth = 0;
      for (; i < text.length; i++) { if (text[i] === ch) depth++; else if (text[i] === close && --depth === 0) { i++; break; } else if (text[i] === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; } }
      return null;
    }
    const m = /^[@$]?[\w.-]+/.exec(text.slice(i));
    if (!m) throw new Error(`cannot read ${text.slice(i, i + 10)}`);
    i += m[0].length;
    space();
    if (text[i] === '(') { i++; return { call: m[0], args: items(')') }; }
    return /^-?\d/.test(m[0]) ? Number(m[0]) : { ref: m[0] };
  };
  const items = (end) => {
    const list = [];
    space();
    if (text[i] === end) { i++; return list; }
    for (;;) {
      list.push(value());
      space();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === end) { i++; return list; }
      throw new Error('expected a comma');
    }
  };
  text += '\u0000';
  return items('\u0000');
}

/** What each field of a card's own forms asks, and the label of each choice, read from the card's source. */
function fieldLabels(source) {
  const st = parseSource(source);
  // An argument is a reference to another statement, or a call written in place.
  const get = (v) => (v && v.ref ? st[v.ref] : v && v.call ? v : undefined);
  const fields = {};
  const field = (s, label) => {
    if (!s || typeof s.args[0] !== 'string') return;
    const choices = {};
    // The items are the list argument: second for most fields, third for OptionCards.
    for (const it of s.args.find(Array.isArray) ?? []) {
      const item = get(it);
      if (!item) continue;
      const [a0, , a2] = item.args;
      if (item.call === 'RadioItem') choices[a2] = a0;
      else if (item.call === 'SelectItem') choices[a0] = item.args[1];
      else if (item.call === 'OptionCard') choices[a0] = item.args[1];
      else if (item.call === 'CheckBoxItem' || item.call === 'SwitchItem') choices[a2] = a0;
    }
    fields[s.args[0]] = { label: label ?? fields[s.args[0]]?.label, choices };
  };
  for (const s of Object.values(st)) if (/^(RadioGroup|Select|OptionCards|CheckBoxGroup|SwitchGroup|Input|TextArea|Slider|DatePicker)$/.test(s.call)) field(s);
  for (const s of Object.values(st)) if (s.call === 'FormControl') field(get(s.args[1]), s.args[0]);
  return fields;
}

// A pick names the option's id and its label, so a pick stays only while the revised card still offers that option.
const optionValue = (o) => `${o.id}:${o.label}`;

/** The picks the card still offers, by option id. A revision that dropped or relabeled an option drops its pick. */
export function answerValues(card, values) {
  const out = { ...values };
  const keep = (key, lookup) => {
    if (!(key in out)) return;
    const picked = [out[key]].flat().filter((v) => lookup.has(v)).map((v) => lookup.get(v));
    if (Array.isArray(out[key])) out[key] = picked;
    else if (picked.length) out[key] = picked[0];
    else delete out[key];
  };
  keep('choice', new Map((card.options || []).map((o) => [optionValue(o), o.id])));
  (card.questions || []).forEach((q, i) => keep(`q${i}`, new Map((q.options || []).map((o) => [o.label, o.label]))));
  // A pick for a question a revision removed goes too.
  if (card.questions) for (const k of Object.keys(out)) { const m = /^q(\d+)$/.exec(k); if (m && Number(m[1]) >= card.questions.length) delete out[k]; }
  return out;
}

// Form values by field name, without the comment.
export function formValues(formState) {
  const values = {};
  // A body's own comment field comes first, and the page's comment box under the card comes last.
  const comments = [];
  const walk = (o, footer) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && 'value' in v) {
        if (k === 'comment') comments.push([footer, String(v.value || '').trim()]);
        else values[k] = v.value;
      } else walk(v, footer || k === 'yaAnswer');
    }
  };
  walk(formState, false);
  const comment = comments.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, t]) => t).filter(Boolean).join('\n');
  return { values, comment };
}

export function describe(card, a) {
  if (!a) return '';
  if (card.kind === 'secret') return [a.values && a.values.sealed ? 'Sent sealed' : 'Declined', a.comment].filter(Boolean).join('\n');
  let fields;
  const picks = Object.entries(a.values || {}).map(([k, v]) => {
    const list = [].concat(v);
    if (k === 'choice' && card.options) return list.map((x) => (card.options.find((o) => o.id === x) || {}).label || x).join(', ');
    const qi = /^q(\d+)$/.exec(k);
    if (qi && card.questions) return `${card.questions[Number(qi[1])]?.question || k} ${list.join(', ')}`;
    const f = (fields ??= fieldLabels(card.body))[k];
    // A check box or switch group answers with each item on or off: the summary lists the ones turned on.
    const picked = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((x) => v[x]) : list;
    const shown = picked.map((x) => (f && f.choices[x]) || x).join(', ');
    if (!shown) return '';
    // A field without a label keeps its name, unless its choices carry the labels, as a switch group's do.
    const label = (f && f.label) || (f && Object.keys(f.choices).length ? '' : k);
    return label ? `${label}: ${shown}` : shown;
  });
  return [...picks, a.comment].filter(Boolean).join('\n') || 'Empty answer';
}

// What changed since the version before, line by line.
const FIELDS = [['title', 'Title'], ['text', 'Text'], ['recommendation', 'Recommendation'], ['body', 'Body'], ['html', 'HTML']];
function diff(before, after) {
  const b = String(before ?? '').split('\n');
  const a = String(after ?? '').split('\n');
  return { removed: b.filter((l) => l && !a.includes(l)), added: a.filter((l) => l && !b.includes(l)) };
}

/** Every revision, newest first: for each one, the lines it removed and added in each field. */
export function changeSteps(card) {
  const versions = [...(card.history || []), card];
  const steps = [];
  for (let i = versions.length - 1; i > 0; i--) {
    const before = versions[i - 1];
    const after = versions[i];
    const fields = FIELDS.map(([k, label]) => ({ label, ...diff(before[k], after[k]) })).filter((f) => f.removed.length || f.added.length);
    if (fields.length) steps.push({ version: after.version, fields });
  }
  return steps;
}
