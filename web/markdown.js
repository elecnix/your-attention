// A small Markdown renderer that builds React elements and never sets HTML.
// It covers headings, paragraphs, lists, block quotes, fenced code, tables,
// inline code, bold, italic, links to http, https and mailto addresses, and bare
// http and https addresses. With a cardLink option, [[card-id]] becomes what it returns.
// A herdr link, https://herdr.invalid/v1/..., is a session link: the page opens it in herdr.
export const SESSION_LINK = /^https:\/\/herdr\.invalid\/v1\//;
const URL_TAIL = /[.,;:!?'"*_]+$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
/**
 * As in CommonMark, an underscore next to a letter or digit on its outer side never opens or closes emphasis,
 * so MY_SERVICE_API_KEY stays one word, and the text inside must not start or end with a space. Stars have no
 * such rule, so un*frigging*believable keeps its emphasis. A check in code, since some phone browsers lack regex lookbehind.
 */
function underscoreEmphasis(text, at, match) {
  const before = text[at - 1] || '';
  const after = text[at + match.length] || '';
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after) && !/^\s|\s$/.test(match.slice(1, -1));
}

function inline(h, text, key, opts = {}) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|\[\[([\w.:-]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]]+)/g;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    // An underscore pair that is not emphasis stays text, and the scan resumes one character later.
    if (m[3] && m[3][0] === '_' && !underscoreEmphasis(text, m.index, m[3])) { re.lastIndex = m.index + 1; continue; }
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    // A session link opens another agent's session in herdr, through the page, so it gets no new tab.
    const a = (href, label) => (SESSION_LINK.test(href)
      ? h('a', { key: k, href, className: 'session-link', title: 'Open this session in herdr' }, label)
      : h('a', { key: k, href, target: '_blank', rel: 'noopener noreferrer' }, label));
    if (m[1]) out.push(h('code', { key: k }, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', { key: k }, inline(h, m[2].slice(2, -2), k, opts)));
    else if (m[3]) out.push(h('em', { key: k }, inline(h, m[3].slice(1, -1), k, opts)));
    else if (m[4]) out.push(opts.cardLink ? opts.cardLink(m[4], k) : m[0]);
    else if (m[5]) out.push(/^(https?:|mailto:)/i.test(m[6]) ? a(m[6], m[5]) : m[5]);
    else {
      // A sentence's closing period is not part of the address before it.
      const url = m[7].replace(URL_TAIL, '');
      out.push(a(url, url));
      re.lastIndex = m.index + url.length;
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// With breaks, a line break inside a paragraph stays a line break, as in a chat message.
/** One line of inline Markdown, such as a field label: links, code, bold and italic, with no paragraph around it. */
export function renderInline(h, text, opts = {}) {
  return inline(h, String(text ?? ''), 'i', opts);
}

export function renderMarkdown(h, src, opts = {}) {
  const ins = (text, k) => inline(h, text, k, opts);
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const key = () => `b${blocks.length}`;
  // A table starts with a row of cells and a row of dashes. It can follow a line of text with no blank line between.
  const tableAt = (n) => /^\|.*\|\s*$/.test(lines[n] || '') && /^\|[\s:|-]+\|\s*$/.test(lines[n + 1] || '');
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push(h('pre', { key: key() }, h('code', null, code.join('\n'))));
    } else if (/^#{1,6}\s/.test(line)) {
      const level = /^#+/.exec(line)[0].length;
      blocks.push(h(`h${Math.min(level + 2, 6)}`, { key: key() }, ins(line.replace(/^#+\s*/, ''), key())));
      i++;
    } else if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s/, ''));
      blocks.push(h(ordered ? 'ol' : 'ul', { key: key() }, items.map((t, j) => h('li', { key: j }, ins(t, `${key()}.${j}`)))));
    } else if (/^>\s?/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      blocks.push(h('blockquote', { key: key() }, ins(quote.join(' '), key())));
    } else if (tableAt(i)) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      blocks.push(h('table', { key: key() },
        h('thead', null, h('tr', null, head.map((c, j) => h('th', { key: j }, ins(c, `${key()}h${j}`))))),
        h('tbody', null, rows.map((r, j) => h('tr', { key: j }, r.map((c, k) => h('td', { key: k }, ins(c, `${key()}r${j}.${k}`))))))));
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+\.)\s)/.test(lines[i]) && !tableAt(i); i++) para.push(lines[i]);
      blocks.push(h('p', { key: key() }, ins(para.join(opts.breaks ? '\n' : ' '), key())));
    }
  }
  return blocks;
}

