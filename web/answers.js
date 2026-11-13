// How a card becomes OpenUI Lang, and how a filled form becomes the answer. The page and the terminal client share
// this file, so both send the same values for the same card. It touches no browser API.
const J = JSON.stringify;

// Every row of buttons ends with Dismiss. It closes the card without the agent hearing anything, and the page keeps what
// the person had typed. The button's name is also its tooltip and its accessible label.
export const DISMISS = 'Dismiss without telling the agent';
const dismissButton = (name) => `${name} = IconButton(${J(DISMISS)}, Icon("eye-off"), @ToAssistant("dismiss"), "secondary")`;

// OpenUI Lang for a card that brings no body of its own.
export function cardSource(c) {
  // A secret card that an older inbox stored asks for one value, in the field `sealed`, as the secret widget draws it.
  if (c.kind === 'secret' && c.secret) {
    return withAnswerFooter([
      'root = Form("secret", secretButtons, [secretField])',
      'secretButtons = Buttons([])',
      `secretField = FormControl(${J(c.secret.name)}, SecretInput("sealed", ${J(JSON.stringify(c.secret.publicKey))}))`,
    ].join('\n'));
  }
  // A body with forms of its own keeps them where the agent placed them, and gets the comment and buttons below.
  // So does a body with no form and no options or questions, so the card stays answerable.
  if (keepsOwnForm(c)) return withAnswerFooter(c.body);
  if (c.kind === 'blocked' && c.options && c.options.length) {
    // The sidecar read these choices from the agent's dialog, and presses the one you pick in that pane.
    return [
      'root = Card([screen, form])',
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      `form = Form(${J(c.id)}, buttons, [fcChoice])`,
      'fcChoice = FormControl("Your answer", choice)',
      `choice = OptionCards("choice", "single", [${c.options.map((_, j) => `c${j}`).join(', ')}])`,
      ...c.options.map((o, j) => `c${j} = OptionCard(${J(optionValue(o))}, ${J(o.label)}, "")`),
      'buttons = Buttons([save, go, skip, dismiss], "row")',
      'save = Button("Press it in the session", @ToAssistant("send answer"), "primary")',
      'go = Button("Open session", @ToAssistant("open session"), "secondary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
      dismissButton('dismiss'),
    ].join('\n');
  }
  if (c.kind === 'blocked') {
    return [
      'root = Card([screen, buttons])',
      `screen = CodeBlock("text", ${J(c.screen || '(screen unavailable)')})`,
      'buttons = Buttons([go, skip, dismiss], "row")',
      'go = Button("Open session", @ToAssistant("open session"), "primary")',
      'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
      dismissButton('dismiss'),
    ].join('\n');
  }
  // The page shows the title above the text and attachments, so a generated card has no header.
  const parts = [];
  const L = [];
  if (c.body) { parts.push('custom'); L.push(c.body.replace(/^\s*root\s*=/m, 'custom =')); }
  // Each question is a section of its own: the question as a heading, its text, its options and a comment field, so the
  // person answers it while it is in mind. Each section is a form without buttons, and Send answer carries every form.
  (c.questions || []).forEach((q, i) => {
    parts.push(`qt${i}`, `qf${i}`);
    L.push(`qt${i} = TextContent(${J([`### ${q.question}`, q.text].filter(Boolean).join('\n\n'))})`);
    const opts = (q.options || []).map((o, j) => [`o${i}_${j}`, o]);
    if (!opts.length) {
      L.push(`qf${i} = Form(${J(`${c.id}:q${i}`)}, qb${i}, [fc${i}])`, `qb${i} = Buttons([])`, `fc${i} = FormControl("Your answer", TextArea("q${i}", "", 3))`);
      return;
    }
    L.push(`qf${i} = Form(${J(`${c.id}:q${i}`)}, qb${i}, [fc${i}, fcc${i}])`, `qb${i} = Buttons([])`);
    L.push(`fc${i} = FormControl(${J(q.multiSelect ? 'Your answers' : 'Your answer')}, q${i})`);
    L.push(`q${i} = OptionCards("q${i}", ${J(q.multiSelect ? 'multiple' : 'single')}, [${opts.map(([r]) => r).join(', ')}])`);
    opts.forEach(([r, o]) => L.push(`${r} = OptionCard(${J(o.label)}, ${J(o.label)}, ${J(o.description || '')})`));
    L.push(`fcc${i} = FormControl("Comment on this question", TextArea(${J(`q${i}_comment`)}, "Why, or anything to add", 2))`);
  });
  const controls = [];
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
    'buttons = Buttons([save, skip, dismiss], "row")',
    'save = Button("Send answer", @ToAssistant("send answer"), "primary")',
    'skip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    dismissButton('dismiss'));
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
    'yaButtons = Buttons([yaSave, yaSkip, yaDismiss], "row")',
    'yaSave = Button("Send answer", @ToAssistant("send answer"), "primary")',
    'yaSkip = Button("Skip for now", @ToAssistant("skip"), "secondary")',
    dismissButton('yaDismiss'),
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

// The name a pick and the page's lookups use for an option: its id, or its label when the card has none, as a card
// stored before the inbox gave every option an id does.
export const optionId = (o) => o.id ?? o.label;
// A pick names the option and its label both, so a pick stays only while the revised card still offers that option.
export const optionValue = (o) => `${optionId(o)}:${o.label}`;

const keepsOwnForm = (c) => !!c.body && (/\bForm\(/.test(c.body) || (!c.options?.length && !c.questions?.length));
// The page draws a card's options as boxes unless the card brings its own HTML, form or kind of form.
const drawsOptions = (c) => !!c.options?.length && c.html === undefined && !c.broadcast && !keepsOwnForm(c);
// Markdown emphasis out, so "**Go ahead.**" reads as "Go ahead.". An underscore inside a word, as in MY_KEY, stays.
const plain = (s) => String(s ?? '').replace(/\*+/g, '').replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1').trim();
const ENDS_CLAUSE = /^[.!?,:]/;

/** Whether a recommendation starts with this label, then a sentence end, a comma, a colon or the end of the text. Case and emphasis do not count. */
export function recommendationNames(recommendation, label) {
  const rec = plain(recommendation).toLowerCase();
  const name = plain(label).toLowerCase();
  if (!name || !rec.startsWith(name)) return false;
  const rest = rec.slice(name.length);
  return rest.trim() === '' || ENDS_CLAUSE.test(rest) || ENDS_CLAUSE.test(name.slice(-1));
}

/**
 * The recommendation without the label it starts with, as the option that shows that label draws it: the label, the
 * emphasis around it, and the punctuation and spaces after it go, and what remains starts with a capital. A recommendation
 * that does not start with the label stays as it is.
 */
export function recommendationRest(recommendation, label) {
  const rec = String(recommendation ?? '');
  if (!recommendationNames(rec, label)) return rec;
  const name = plain(label);
  let at = /^\s*/.exec(rec)[0].length;
  // The label as the recommendation spells it. Each emphasis mark it opens, before or inside the label, closes after it.
  let open = 0;
  for (let seen = 0; seen < name.length && at < rec.length; at++) {
    if (/[*_]/.test(rec[at]) && rec[at] !== name[seen]) open++;
    else seen++;
  }
  let rest = rec.slice(at);
  while (rest && (/^[.!?,:]/.test(rest) || (open > 0 && /^[*_]/.test(rest)))) {
    if (/^[*_]/.test(rest)) open--;
    rest = rest.slice(1);
  }
  return rest.trim().replace(/^([*_]*)(\p{Ll})/u, (_, marks, c) => marks + c.toUpperCase());
}

/**
 * The options a card recommends: the ones it marks, else the one its recommendation starts with, the longest label first.
 * `inside` says the recommendation goes inside that option, when there is one such option, and `text` is what it shows there. The page and the terminal
 * client draw both from this, and leave the recommendation in its own box otherwise.
 */
export function recommendedOptions(c) {
  if (!drawsOptions(c)) return { ids: [], inside: false, text: '' };
  let ids = c.options.filter((o) => o.recommended === true).map(optionId);
  if (!ids.length && c.recommendation) {
    const best = c.options.filter((o) => recommendationNames(c.recommendation, o.label)).sort((a, b) => plain(b.label).length - plain(a.label).length)[0];
    if (best) ids = [optionId(best)];
  }
  const inside = ids.length === 1 && !!c.recommendation;
  // Inside the option, the recommendation drops the option's label, so the box says the pick once.
  const text = inside ? recommendationRest(c.recommendation, c.options.find((o) => optionId(o) === ids[0]).label) : '';
  return { ids, inside, text };
}

// The fields the page builds for a card's questions: q0 for the first one's answer, q0_comment for its comment.
const QUESTION_FIELD = /^q(\d+)(_comment)?$/;

/** The answer to each question, in order: the question, what the person picked or wrote, and the comment. */
export function questionAnswers(card, values) {
  // A body with forms of its own draws no questions, so none has an answer.
  if (keepsOwnForm(card)) return [];
  return (card.questions || []).map((q, i) => {
    const v = [values[`q${i}`] ?? []].flat().map(String).filter((x) => x.trim());
    const comment = String(values[`q${i}_comment`] ?? '').trim();
    return { question: q.question, answer: v.length ? v.join(', ') : q.options?.length ? '(no option picked)' : '(no answer)', comment };
  });
}

/** The answer text for a card's questions, one line per question and an indented line per comment. The page and the agent read the same lines. */
export function questionLines(card, values) {
  return questionAnswers(card, values).flatMap((a) => [`${a.question} ${a.answer}`, ...(a.comment ? [`  Comment: ${a.comment}`] : [])]);
}

/** The options each question recommends, by field name: {q0: ['SQLite']}. The page and the terminal client tag them. */
export function questionRecommendations(card) {
  const out = {};
  (card.questions || []).forEach((q, i) => {
    const labels = (q.options || []).filter((o) => o.recommended === true).map((o) => o.label);
    if (labels.length) out[`q${i}`] = labels;
  });
  return out;
}

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
  keep('choice', new Map((card.options || []).map((o) => [optionValue(o), optionId(o)])));
  // A question without options takes its answer as text, and an empty comment says nothing.
  (card.questions || []).forEach((q, i) => {
    if (q.options?.length) keep(`q${i}`, new Map(q.options.map((o) => [o.label, o.label])));
    for (const k of q.options?.length ? [`q${i}_comment`] : [`q${i}`]) if (k in out && !String(out[k] ?? '').trim()) delete out[k];
  });
  // A pick or comment for a question a revision removed goes too.
  if (card.questions) for (const k of Object.keys(out)) { const m = QUESTION_FIELD.exec(k); if (m && Number(m[1]) >= card.questions.length) delete out[k]; }
  return out;
}

/** One approval_<i> value per approval on the card: true for each the person turned on, false for the rest. */
export function approvalValues(card, picks) {
  return Object.fromEntries((card.approvals || []).map((_, i) => [`approval_${i}`, !!(picks && picks[i])]));
}

/** The line under an approval that names its pane, and the agent and tab when herdr knew them. */
export function approvalPlace(a) {
  const p = a.place || {};
  const who = [p.agent, p.title].filter(Boolean).join(', ');
  const where = p.tab ? `tab ${p.tab}${p.workspace ? ` in workspace ${p.workspace}` : ''}` : p.workspace ? `workspace ${p.workspace}` : '';
  return [`Pane ${a.pane}`, who, where].filter(Boolean).join(' · ');
}

/** What the inbox did with one approval, or '' for one it did not touch. */
export function approvalResult(a, r) {
  if (!r) return '';
  if (r.sentAt) return `Sent to ${a.pane} at ${new Date(r.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (r.sendingAt) return `Sending to ${a.pane}`;
  return `Not sent to ${a.pane}: ${r.error}`;
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

/** The fields of a card that take only a sealed value, as the inbox's sealedFields reads them: the card's `secrets`, or
 * `sealed` on a secret card that an older inbox stored. */
export const secretFieldsOf = (c) => c.secrets ?? (c.kind === 'secret' && c.secret ? ['sealed'] : []);

/** Whether an answer value is a secret the page sealed. */
const isSealedValue = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.alg === 'string' && typeof v.data === 'string';

export function describe(card, a) {
  if (!a) return '';
  let fields;
  const values = a.values || {};
  const asked = card.questions?.length ? questionLines(card, values) : [];
  const picks = Object.entries(values).map(([k, v]) => {
    const list = [].concat(v);
    if (k === 'choice' && card.options) return list.map((x) => (card.options.find((o) => optionId(o) === x) || {}).label || x).join(', ');
    const ai = /^approval_(\d+)$/.exec(k);
    if (ai && card.approvals) { const ap = card.approvals[Number(ai[1])]; return v === true && ap ? `Approved: ${ap.label || ap.text}` : ''; }
    if (asked.length && QUESTION_FIELD.test(k)) return '';
    const f = (fields ??= fieldLabels(card.body))[k];
    // A sealed secret shows that it went, never its ciphertext.
    if (isSealedValue(v)) return `${(f && f.label) || (card.secret && k === 'sealed' ? card.secret.name : k)}: Sent sealed`;
    // A check box or switch group answers with each item on or off: the summary lists the ones turned on.
    const picked = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((x) => v[x]) : list;
    const shown = picked.map((x) => (f && f.choices[x]) || x).join(', ');
    if (!shown) return '';
    // A field without a label keeps its name, unless its choices carry the labels, as a switch group's do.
    const label = (f && f.label) || (f && Object.keys(f.choices).length ? '' : k);
    return label ? `${label}: ${shown}` : shown;
  });
  // A secret card an older inbox stored, answered without a value, declined the request.
  if (card.kind === 'secret' && card.secret && !isSealedValue(values.sealed)) picks.unshift(`${card.secret.name}: Declined`);
  return [...asked, ...picks, a.comment && (asked.length ? `Comment: ${a.comment}` : a.comment)].filter(Boolean).join('\n') || 'Empty answer';
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

// The words that differ between a removed line and the added line that replaced it,
// from the longest common run of words. Lines that share no word, or are very long,
// get no word marks: the whole line changed.
export function wordDiff(before, after) {
  const x = before.split(/(\s+)/);
  const y = after.split(/(\s+)/);
  if (x.length * y.length > 250000) return null;
  const t = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const del = [];
  const add = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { del.push([x[i++], false]); add.push([y[j++], false]); }
    else if (t[i + 1][j] >= t[i][j + 1]) del.push([x[i++], true]);
    else add.push([y[j++], true]);
  }
  while (i < x.length) del.push([x[i++], true]);
  while (j < y.length) add.push([y[j++], true]);
  if (!del.some(([w, changed]) => !changed && w.trim())) return null;
  return { del, add };
}

// The proposed guidance against the current guidance, line by line in order, from the longest common run of lines.
// A run of removed lines and the run of added lines after it pair up, line by line, for word marks, as Changes pairs
// them. With `base`, the guidance the proposal started from, a removed line is marked `undone` when the current guidance
// has more copies of it than `base`: it came after the proposal, and approving removes it.
export function guidanceDiff(current, proposed, base) {
  const x = String(current ?? '').split('\n');
  const y = String(proposed ?? '').split('\n');
  // The lines both texts start and end with need no table, and a proposal usually changes a few lines in the middle.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xm = x.slice(head, x.length - tail);
  const ym = y.slice(head, y.length - tail);
  const rows = x.slice(0, head).map((text) => ({ kind: 'same', text }));
  const w = ym.length + 1;
  // One flat table of at most four million cells, 16 MB. Past that the middle shows as removed, then added.
  if ((xm.length + 1) * w > 4000000) {
    for (const text of xm) rows.push({ kind: 'del', text });
    for (const text of ym) rows.push({ kind: 'add', text });
  } else {
    const t = new Uint32Array((xm.length + 1) * w);
    for (let i = xm.length - 1; i >= 0; i--) for (let j = ym.length - 1; j >= 0; j--) t[i * w + j] = xm[i] === ym[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < xm.length && j < ym.length) {
      if (xm[i] === ym[j]) { rows.push({ kind: 'same', text: xm[i++] }); j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) rows.push({ kind: 'del', text: xm[i++] });
      else rows.push({ kind: 'add', text: ym[j++] });
    }
    while (i < xm.length) rows.push({ kind: 'del', text: xm[i++] });
    while (j < ym.length) rows.push({ kind: 'add', text: ym[j++] });
  }
  for (const text of x.slice(x.length - tail)) rows.push({ kind: 'same', text });
  for (let k = 0; k < rows.length;) {
    if (rows[k].kind !== 'del') { k++; continue; }
    let d = k;
    while (d < rows.length && rows[d].kind === 'del') d++;
    let e = d;
    while (e < rows.length && rows[e].kind === 'add') e++;
    for (let n = 0; n < Math.min(d - k, e - d); n++) {
      const w = wordDiff(rows[k + n].text, rows[d + n].text);
      if (w) { rows[k + n].words = w.del; rows[d + n].words = w.add; }
    }
    k = e;
  }
  if (base !== undefined && base !== current) {
    const gained = new Map();
    for (const l of x) gained.set(l, (gained.get(l) || 0) + 1);
    for (const l of String(base).split('\n')) gained.set(l, (gained.get(l) || 0) - 1);
    for (const r of rows) {
      if (r.kind !== 'del' || !r.text.trim() || !(gained.get(r.text) > 0)) continue;
      r.undone = true;
      gained.set(r.text, gained.get(r.text) - 1);
    }
  }
  return rows;
}
