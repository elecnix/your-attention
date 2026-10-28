// A small Markdown renderer that builds React elements and never sets HTML.
// It covers headings, paragraphs, lists, block quotes, fenced code, tables,
// inline code, bold, italic, links to http, https and mailto addresses, and bare
// http and https addresses. With a cardLink option, [[card-id]] becomes what it returns.
const URL_TAIL = /[.,;:!?'"*_]+$/;
function inline(h, text, key, opts = {}) {
  const out = [];
  // As in CommonMark, an underscore next to a letter or digit on its outer side never opens or closes emphasis,
  // so MY_SERVICE_API_KEY stays one word. A star can, so un*frigging*believable keeps its emphasis.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|(?<![\p{L}\p{N}])_(?!\s)[^_]+?(?<!\s)_(?![\p{L}\p{N}]))|\[\[([\w.:-]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]]+)/gu;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    const a = (href, label) => h('a', { key: k, href, target: '_blank', rel: 'noopener noreferrer' }, label);
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
export function renderMarkdown(h, src, opts = {}) {
  const ins = (text, k) => inline(h, text, k, opts);
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const key = () => `b${blocks.length}`;
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
    } else if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
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
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(h('p', { key: key() }, ins(para.join(opts.breaks ? '\n' : ' '), key())));
    }
  }
  return blocks;
}

