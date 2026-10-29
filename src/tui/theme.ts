// What the terminal can show, and the symbols and styles the client draws with. Color never carries meaning alone:
// every state and priority also has a symbol of its own shape and a text label, and the selected row is in inverse
// video with a marker. Each symbol has an ASCII form for terminals without Unicode.
import type { Caps, Style } from './screen.ts';

export interface Env { [k: string]: string | undefined }

/** The terminal's capabilities, from its environment and the command's options. */
export function detectCaps(env: Env, opts: { mono?: boolean; ascii?: boolean; platform?: string } = {}): Caps {
  const term = env['TERM'] ?? '';
  const program = env['TERM_PROGRAM'] ?? '';
  const forced = env['YOUR_ATTENTION_TUI_COLOR'];
  let color: Caps['color'];
  // https://no-color.org: any non-empty NO_COLOR turns color off. Bold, underline and inverse video stay.
  if (opts.mono || (env['NO_COLOR'] ?? '') !== '' || forced === 'mono' || term === 'dumb') color = 0;
  else if (forced === '16') color = 1;
  else if (forced === '256') color = 2;
  else if (forced === 'truecolor') color = 3;
  else if (/^(truecolor|24bit)$/i.test(env['COLORTERM'] ?? '') || /^(iTerm\.app|WezTerm|ghostty|vscode)$/.test(program) || env['WT_SESSION']) color = 3;
  else if (/256/.test(term) || program === 'Apple_Terminal') color = 2;
  else color = 1;
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  const unicode = !opts.ascii && env['YOUR_ATTENTION_TUI_ASCII'] !== '1' && term !== 'linux'
    && (/utf-?8/i.test(locale) || (!locale && (opts.platform ?? process.platform) !== 'linux'));
  // Apple Terminal and the Linux console have no OSC 8 hyperlinks.
  const hyperlinks = program !== 'Apple_Terminal' && term !== 'linux' && term !== 'dumb';
  return { color, unicode, hyperlinks };
}

export interface Glyphs {
  marker: string; waiting: string; onScreen: string; reply: string; triage: string; held: string;
  stored: string; delivered: string; read: string; closed: string;
  radioOn: string; radioOff: string; checkOn: string; checkOff: string;
  bullet: string; quote: string; rule: string; ellipsis: string; session: string; select: string;
  more: string; up: string; down: string; open: string; shut: string;
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  focusBox: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  table: { h: string; v: string; x: string };
}

const UNICODE: Glyphs = {
  marker: '▶', waiting: '●', onScreen: '◉', reply: '↩', triage: '◌', held: '‖',
  stored: '○', delivered: '◑', read: '✓', closed: '×',
  radioOn: '(•)', radioOff: '( )', checkOn: '[x]', checkOff: '[ ]',
  bullet: '•', quote: '│', rule: '─', ellipsis: '…', session: '❯', select: '▾',
  more: '…', up: '▲', down: '▼', open: '▾', shut: '▸',
  box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  focusBox: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  table: { h: '─', v: '│', x: '┼' },
};

const ASCII: Glyphs = {
  marker: '>', waiting: '*', onScreen: '@', reply: '<', triage: '~', held: '=',
  stored: 'o', delivered: 'd', read: 'v', closed: 'x',
  radioOn: '(*)', radioOff: '( )', checkOn: '[x]', checkOff: '[ ]',
  bullet: '*', quote: '|', rule: '-', ellipsis: '...', session: '>', select: 'v',
  more: '...', up: '^', down: 'v', open: 'v', shut: '>',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  focusBox: { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '#' },
  table: { h: '-', v: '|', x: '+' },
};

export interface Theme {
  caps: Caps;
  g: Glyphs;
  s: {
    title: Style; heading: Style; dim: Style; bold: Style; link: Style; code: Style; accent: Style;
    warn: Style; ok: Style; selected: Style; focus: Style; button: Style; primary: Style; header: Style; bar: Style; error: Style;
  };
  /** The style of a priority level's label and symbol, from the level's color. */
  level(color: string | undefined): Style;
}

// The Okabe-Ito palette, which people with each common kind of color blindness tell apart.
const BLUE = '#56b4e9';
const GREEN = '#009e73';
const ORANGE = '#e69f00';
const PURPLE = '#cc79a7';

export function makeTheme(caps: Caps): Theme {
  const c = caps.color > 0;
  return {
    caps,
    g: caps.unicode ? UNICODE : ASCII,
    s: {
      title: { bold: true },
      heading: { bold: true, underline: true },
      dim: { dim: true },
      bold: { bold: true },
      link: c ? { underline: true, fg: BLUE } : { underline: true },
      code: c ? { fg: PURPLE } : { bold: true },
      accent: c ? { fg: BLUE, bold: true } : { bold: true },
      warn: c ? { fg: ORANGE } : { bold: true },
      ok: c ? { fg: GREEN } : {},
      selected: { inverse: true },
      focus: c ? { fg: BLUE, bold: true } : { bold: true, underline: true },
      button: {},
      primary: { bold: true },
      header: { bold: true },
      bar: { inverse: true },
      error: c ? { fg: ORANGE, bold: true } : { bold: true },
    },
    level: (color) => (c && color ? { fg: color, bold: true } : { bold: true }),
  };
}
