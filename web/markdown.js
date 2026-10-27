// A small Markdown renderer that builds React elements and never sets HTML.
// It covers headings, paragraphs, lists, block quotes, fenced code, tables,
// inline code, bold, italic and links to http, https and mailto addresses.
function inline(h, text, key) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    if (m[1]) out.push(h('code', { key: k }, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', { key: k }, inline(h, m[2].slice(2, -2), k)));
    else if (m[3]) out.push(h('em', { key: k }, inline(h, m[3].slice(1, -1), k)));
    else if (/^(https?:|mailto:)/i.test(m[5])) out.push(h('a', { key: k, href: m[5], target: '_blank', rel: 'noopener noreferrer' }, m[4]));
    else out.push(m[4]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(h, src) {
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
      blocks.push(h(`h${Math.min(level + 2, 6)}`, { key: key() }, inline(h, line.replace(/^#+\s*/, ''), key())));
      i++;
    } else if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s/, ''));
      blocks.push(h(ordered ? 'ol' : 'ul', { key: key() }, items.map((t, j) => h('li', { key: j }, inline(h, t, `${key()}.${j}`)))));
    } else if (/^>\s?/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      blocks.push(h('blockquote', { key: key() }, inline(h, quote.join(' '), key())));
    } else if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      blocks.push(h('table', { key: key() },
        h('thead', null, h('tr', null, head.map((c, j) => h('th', { key: j }, inline(h, c, `${key()}h${j}`))))),
        h('tbody', null, rows.map((r, j) => h('tr', { key: j }, r.map((c, k) => h('td', { key: k }, inline(h, c, `${key()}r${j}.${k}`))))))));
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(h('p', { key: key() }, inline(h, para.join(' '), key())));
    }
  }
  return blocks;
}

