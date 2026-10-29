// `your-attention tui`: the inbox page, full screen in a terminal. It reads the inbox as the owner, follows it live,
// and answers cards with the values the page would send. web/app.js is the model for each behavior here: which card
// opens, what Skip for now and Send answer do, and when a card counts as seen.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { after, buildQueue, type InboxState, type Queue } from '../../web/queue.js';
import type { Attachment, Card } from '../core/types.ts';
import { notOwnerAdvice } from '../client.ts';
import { ApiError, InboxApi, ownerConfig } from './api.ts';
import { loadParser, parserReady, type Action } from './body.ts';
import { CardView, type CardViewHost } from './cardview.ts';
import type { Hit } from './doc.ts';
import type { InputEvent, KeyEvent, MouseEvent } from './input.ts';
import { encodeFrame, type Grid } from './screen.ts';
import { Terminal, type TerminalIo } from './terminal.ts';
import { detectCaps, makeTheme } from './theme.ts';
import { drawFrame, type Frame, type Model } from './view.ts';

export interface TuiOptions {
  env: NodeJS.ProcessEnv;
  io: TerminalIo;
  mono?: boolean;
  ascii?: boolean;
}

/** The buttons Ctrl+Enter and Ctrl+S press, in the order the page's cards offer them. */
const SEND_BUTTONS = ['button:Send answer', 'button:Press it in the session', 'button:Send sealed', 'button:Approve and send'];

export async function runTui(opts: TuiOptions): Promise<number> {
  const found = ownerConfig(opts.env);
  if (typeof found === 'string') { process.stderr.write(`${found}\n`); return 1; }
  const config = found;
  const trace = opts.env['YOUR_ATTENTION_TUI_TRACE'];
  const mark = (event: string, data: Record<string, unknown> = {}) => {
    if (trace) fs.appendFileSync(trace, `${JSON.stringify({ event, ms: Math.round(performance.now() * 10) / 10, ...data })}\n`);
  };
  const theme = makeTheme(detectCaps(opts.env, { mono: opts.mono, ascii: opts.ascii }));
  const api = new InboxApi(config);
  const term = new Terminal(opts.io, opts.env['YOUR_ATTENTION_TUI_SIZE']);
  const remote = !!opts.env['SSH_CONNECTION'];

  const m: Model = {
    theme, width: term.cols, height: term.rows, state: null, queue: null, current: null, view: null, zone: 'list',
    listScroll: 0, cardScroll: 0, groupBy: 'none', fresh: new Set(), connected: false, connecting: true, blank: 'Loading the inbox…',
    help: false, cleared: false, now: Date.now(),
  };
  let focus: string | null = null;
  let pinned: string | null = null;
  let known: Set<string> | null = null;
  const views = new Map<string, CardView>();
  const scrolls = new Map<string, number>();
  const files = new Map<string, string | null>();
  let frame: Frame | null = null;
  let last: Grid | null = null;
  let dirty = false;
  let firstPaint = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let pinTyped = '';
  let confirmAction: (() => void) | undefined;
  let reported: string | null | undefined;
  let seenKey: string | null = null;
  let frames = 0;
  let slowest = 0;
  let done: (code: number) => void = () => {};
  const finished = new Promise<number>((r) => { done = r; });

  const status = (text: string, kind: 'info' | 'ok' | 'warn' = 'info', ms = 4000) => {
    m.status = { text, kind };
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { m.status = undefined; schedule(); }, ms);
    schedule();
  };

  const address = (id: string) => `${config.url}/#card=${encodeURIComponent(id)}`;
  const open = (url: string) => {
    if (remote) { status(`Open this address: ${url}`, 'info', 10_000); return; }
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [url], (err) => status(err ? `Could not open ${url}: ${err.message}` : `Opened ${url}`, err ? 'warn' : 'info'));
  };

  const host: CardViewHost = {
    theme,
    address,
    now: () => Date.now(),
    fileText: (f: Attachment) => {
      if (!f.id) return undefined;
      const have = files.get(f.id);
      if (have !== undefined) return have ?? '';
      files.set(f.id, null);
      api.file(f.id).then((t) => { files.set(f.id!, t); schedule(); }, () => { files.set(f.id!, ''); schedule(); });
      return undefined;
    },
    act: (view, action) => { void act(view, action); },
  };

  /** What a button or link does, as the page's onAction decides it. */
  async function act(view: CardView, action: Action | { kind: 'open'; target: string } | { kind: 'api'; path: string }): Promise<void> {
    const c = view.card;
    if (action.kind === 'url') { open(action.url); return; }
    if (action.kind === 'api') {
      try { await api.post(action.path); status('Done.', 'ok'); } catch (e) { status(`The inbox refused: ${(e as Error).message}`, 'warn'); }
      return;
    }
    if (action.kind === 'open') {
      const [kind, ...rest] = action.target.split(':');
      const target = rest.join(':');
      if (kind === 'card') { go(target); return; }
      if (kind === 'url') { open(target); return; }
      if (kind === 'session') {
        try { await api.post('/v1/focus', { href: target }); status('Opened in herdr.', 'ok'); } catch (e) { status(`Could not open: ${(e as Error).message}`, 'warn'); }
      }
      return;
    }
    const msg = action.message;
    if (msg === 'skip' || msg === 'Skip for now') { skip(); return; }
    if (c.kind === 'blocked' && msg !== 'send answer') {
      try { await api.post(`/v1/cards/${encodeURIComponent(c.id)}/open`); status('Opened the session.', 'ok'); } catch (e) { status(`Could not open the session: ${(e as Error).message}`, 'warn'); }
      return;
    }
    let body: { values: Record<string, unknown>; comment: string; version?: number };
    if (c.kind === 'secret' && c.secret) {
      const comment = String(view.store.get('secret', 'comment') ?? '').trim();
      if (msg === 'decline') body = { values: {}, comment, version: c.version };
      else {
        const value = String(view.store.get('secret', 'value') ?? '');
        if (!value) { view.notice = { text: 'Type the value first, or press Decline.', style: 'warn' }; schedule(); return; }
        try {
          const { seal } = await import('../../web/sealed.js');
          body = { values: { sealed: await seal(c.secret.publicKey, value) }, comment, version: c.version };
        } catch (e) {
          view.notice = { text: `The value could not be sealed: ${(e as Error).message}`, style: 'warn' };
          schedule();
          return;
        }
      }
    } else if (c.broadcast && !c.closed) {
      const picked = (view.store.get('broadcast', 'agents') ?? {}) as Record<string, boolean>;
      body = { values: { choice: msg === 'approve' ? 'approve' : 'reject', agents: c.broadcast.agents.filter((a) => picked[a] ?? true) }, comment: '' };
    } else {
      body = { ...view.answer(), version: c.version };
    }
    try {
      await api.post(`/v1/cards/${encodeURIComponent(c.id)}/answer`, body);
    } catch (e) {
      view.notice = { text: `The answer did not go: ${(e as Error).message}`, style: 'warn' };
      schedule();
      return;
    }
    view.notice = undefined;
    status(`Sent your answer to “${c.title}”.`, 'ok');
    answered(c.id);
    await refresh();
  }

  // ---- which card is open ----
  const order = (): Card[] => (m.queue ? m.queue.order : []);
  const go = (id: string | null) => {
    if (m.current) scrolls.set(m.current.id, m.cardScroll);
    focus = id;
    m.cleared = false;
    if (id) m.fresh.delete(id);
    m.cardScroll = id ? scrolls.get(id) ?? 0 : 0;
    m.revealList = true;
    pick();
    schedule();
  };
  const skip = () => { pinned = null; go(after(order(), m.current ? m.current.id : null)); };
  // An answer shows its receipt for a moment, then opens the card after the answered one, so a skipped card stays skipped.
  const answered = (id: string) => {
    const then = after(order(), id);
    setTimeout(() => {
      if ((m.current ? m.current.id : null) !== id) return;
      pinned = null;
      if (then && then !== id) go(then);
      else { focus = null; pick(); schedule(); }
    }, 700);
  };

  /** Choose the card on screen and its view, as the page does: the picked one, else the one already open, else the first waiting. */
  function pick(): void {
    const q = m.queue;
    if (!q || !m.state) { m.current = null; m.view = null; return; }
    const stillPinned = q.pending.find((c) => c.id === pinned);
    const current = m.cleared ? null : (focus ? q.byId[focus] : undefined) ?? stillPinned ?? q.replied[0] ?? q.pending[0] ?? null;
    if (focus && !q.byId[focus]) focus = null;
    pinned = current ? current.id : null;
    if (current?.id !== m.current?.id) { m.reveal = true; m.revealList = true; if (m.zone === 'card' && !current) m.zone = 'list'; }
    m.current = current;
    if (!current) { m.view = null; reportFocus(null); return; }
    const a = m.state.answers[current.id];
    const key = `${current.id}:${a ? a.savedAt : 0}`;
    let view = views.get(key);
    if (!view) {
      view = new CardView(current, host);
      views.set(key, view);
      for (const k of views.keys()) if (k.startsWith(`${current.id}:`) && k !== key) views.delete(k);
    }
    view.card = current;
    m.view = view;
    reportFocus(current.id);
    // A reply you have looked at for a moment counts as seen.
    const sk = `${current.id}:${current.replies.length}`;
    if (current.replies.some((r) => !r.seenAt) && seenKey !== sk) {
      seenKey = sk;
      setTimeout(() => {
        // A glance shorter than the delay does not count, and the next visit starts the delay again.
        if (m.current?.id !== current.id) { if (seenKey === sk) seenKey = null; return; }
        api.post(`/v1/cards/${encodeURIComponent(current.id)}/seen`).catch(() => {});
      }, 1500);
    }
  }

  function reportFocus(id: string | null): void {
    if (reported === id) return;
    reported = id;
    api.report({ focus: id, active: true });
  }

  // ---- the inbox ----
  let refreshing: Promise<void> | null = null;
  let again = false;
  async function refresh(): Promise<void> {
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      do {
        again = false;
        try {
          const s = await api.state();
          setState(s);
        } catch (e) {
          if (e instanceof ApiError && e.status === 423) { m.pin = m.pin ?? { typed: 0 }; m.blank = 'This inbox is locked.'; }
          else if (e instanceof ApiError && e.status === 401) m.blank = `The inbox at ${config.url} refused the token in ${config.source}.\nPair again, or start the inbox on this machine.`;
          else if (e instanceof ApiError && e.status === 403) m.blank = notOwnerAdvice(config.url);
          else if (!m.state) m.blank = `The inbox at ${config.url} does not answer. Trying again…`;
          m.connected = false;
          m.connecting = false;
          schedule();
        }
      } while (again);
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  function setState(s: InboxState): void {
    if (known) {
      for (const c of s.cards) if (!known.has(c.id) && !c.closed) m.fresh.add(c.id);
    }
    known = new Set(s.cards.map((c) => c.id));
    m.state = s;
    m.queue = buildQueue(s, m.groupBy) as Queue;
    m.blank = undefined;
    m.pin = undefined;
    pinTyped = '';
    m.connected = true;
    m.connecting = false;
    pick();
    schedule();
  }

  // ---- drawing ----
  function schedule(): void {
    if (dirty) return;
    dirty = true;
    setImmediate(render);
  }

  function render(): void {
    dirty = false;
    const t0 = performance.now();
    m.width = term.cols;
    m.height = term.rows;
    m.now = Date.now();
    frame = drawFrame(m);
    const out = encodeFrame(last, frame.grid, theme.caps);
    term.write(out);
    last = frame.grid;
    const ms = performance.now() - t0;
    frames++;
    slowest = Math.max(slowest, ms);
    if (!firstPaint && m.state) {
      firstPaint = true;
      mark('first-paint', { cards: m.state.cards.length, frameMs: Math.round(ms * 10) / 10, bytes: out.length, parser: parserReady() });
    }
    if (out) mark('frame', { frameMs: Math.round(ms * 10) / 10, bytes: out.length });
  }

  // ---- input ----
  const quit = (code = 0) => { stop(); done(code); };
  const groups = (): string[] => ['none', 'priority', 'agent', ...(m.queue?.tagKeys ?? []).map((k) => `tag:${k}`)];
  const cycleGroup = () => {
    const g = groups();
    m.groupBy = g[(g.indexOf(m.groupBy) + 1) % g.length] ?? 'none';
    if (m.state) m.queue = buildQueue(m.state, m.groupBy) as Queue;
    status(`Group by ${m.groupBy === 'none' ? 'nothing' : m.groupBy.replace(/^tag:/, '')}.`);
  };
  const clearDealt = () => {
    const n = m.queue?.dealt.length ?? 0;
    if (!n) { status('No answered or closed card to clear.'); return; }
    m.confirm = `Clear ${n} answered or closed card${n === 1 ? '' : 's'}? Search still finds them.`;
    confirmAction = () => { api.post('/v1/archive').then(() => { status(`Cleared ${n} card${n === 1 ? '' : 's'}.`, 'ok'); void refresh(); }, (e: Error) => status(`The inbox refused: ${e.message}`, 'warn')); };
    schedule();
  };
  const move = (dir: 1 | -1, by = 1) => {
    const ids = frame?.listCards ?? [];
    if (!ids.length) return;
    const i = m.current ? ids.indexOf(m.current.id) : -1;
    const j = i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + dir * by));
    go(ids[j] ?? null);
    
  };
  const enterCard = (last = false) => {
    if (!m.view) return;
    m.zone = 'card';
    if (last) { m.view.focus = undefined; m.view.move(-1); } else if (!m.view.focus) m.view.focusFirstField();
    m.reveal = true;
  };
  const pressSend = () => {
    const v = m.view;
    if (!v) return;
    const id = SEND_BUTTONS.find((b) => v.widgets.has(b));
    if (!id) { status('This card has no Send answer button.'); return; }
    v.widgets.get(id)!.key?.({ type: 'key', name: 'enter', ctrl: false, alt: false, shift: false });
  };
  const pressSkip = () => {
    const w = m.view?.widgets.get('button:Skip for now');
    if (w) w.key?.({ type: 'key', name: 'enter', ctrl: false, alt: false, shift: false });
    else skip();
  };

  let lastActive = 0;
  function onInput(ev: InputEvent): void {
    if (ev.type === 'focus') { api.report({ visible: ev.on, active: true }); return; }
    if (Date.now() - lastActive > 20_000) { lastActive = Date.now(); api.report({ active: true }); }
    if (ev.type === 'key') onKey(ev);
    else if (ev.type === 'mouse') onMouse(ev);
    else if (ev.type === 'paste') {
      if (m.pin) { for (const ch of ev.text.replace(/\D/g, '')) pinKey(ch); }
      else if (m.zone === 'card' && m.view?.paste(ev.text)) m.reveal = true;
    }
    schedule();
  }

  function pinKey(ch: string): void {
    if (pinTyped.length < 12) pinTyped += ch;
    m.pin = { typed: pinTyped.length, message: m.pin?.message };
  }

  function onKey(ev: KeyEvent): void {
    if (ev.ctrl && ev.name === 'c') { quit(0); return; }
    if (m.pin) {
      if (/^\d$/.test(ev.name) && !ev.ctrl) pinKey(ev.name);
      else if (ev.name === 'backspace') { pinTyped = pinTyped.slice(0, -1); m.pin = { typed: pinTyped.length, message: m.pin.message }; }
      else if (ev.name === 'enter' && pinTyped.length >= 4) {
        const pin = pinTyped;
        pinTyped = '';
        m.pin = { typed: 0, message: 'Checking…' };
        api.unlockWith(pin).then(() => { m.pin = undefined; void refresh(); }, (e: unknown) => {
          const body = e instanceof ApiError ? e.body : {};
          const message = typeof body['triesLeft'] === 'number' ? `Wrong PIN. ${body['triesLeft']} tries left.`
            : typeof body['lockedUntil'] === 'number' ? `Too many tries. Try again at ${new Date(body['lockedUntil']).toLocaleTimeString()}.`
            : `The inbox refused: ${(e as Error).message}`;
          m.pin = { typed: 0, message };
          schedule();
        });
      } else if (ev.name === 'escape' || (ev.name === 'q' && !ev.ctrl)) quit(0);
      return;
    }
    if (m.confirm) {
      const yes = ev.name === 'y' || ev.name === 'Y' || ev.name === 'enter';
      const run = yes ? confirmAction : undefined;
      m.confirm = undefined;
      confirmAction = undefined;
      run?.();
      return;
    }
    if (m.help) { m.help = false; return; }
    if (ev.ctrl && ev.name === 'z') { term.suspend(() => { last = null; schedule(); }); return; }
    const sendKey = (ev.name === 'enter' && (ev.ctrl || ev.alt)) || (ev.ctrl && ev.name === 's');
    if (sendKey) { pressSend(); m.reveal = true; return; }
    if (ev.ctrl && ev.name === 'n') { pressSkip(); return; }
    if (ev.ctrl && ev.name === 'l') { last = null; return; }
    if (m.zone === 'card' && m.view) {
      const v = m.view;
      const w = v.focused();
      if (ev.name === 'tab') {
        if (!v.move(ev.shift ? -1 : 1)) { m.zone = 'list'; v.focus = undefined; }
        m.reveal = true;
        return;
      }
      if (ev.name === 'pageup' || ev.name === 'pagedown') { m.cardScroll += (ev.name === 'pageup' ? -1 : 1) * Math.max(1, (frame?.cardHeight ?? 10) - 2); return; }
      if (w?.key?.(ev)) { m.reveal = true; return; }
      if (ev.name === 'escape') { m.zone = 'list'; return; }
      if (!w && (ev.name === 'enter' || ev.name === 'space')) { v.focusFirstField(); m.reveal = true; return; }
      if (w?.text) return;
      if (ev.name === 'up' || ev.name === 'down' || ev.name === 'k' || ev.name === 'j') {
        const dir = ev.name === 'up' || ev.name === 'k' ? -1 : 1;
        if (v.move(dir)) m.reveal = true;
        else m.cardScroll += dir;
        return;
      }
      if (ev.name === 'home') { m.cardScroll = 0; return; }
      if (ev.name === 'end') { m.cardScroll = frame?.cardLines ?? 0; return; }
    } else {
      if (ev.name === 'up' || ev.name === 'k') { move(-1); return; }
      if (ev.name === 'down' || ev.name === 'j') { move(1); return; }
      if (ev.name === 'pageup') { move(-1, 10); return; }
      if (ev.name === 'pagedown') { move(1, 10); return; }
      if (ev.name === 'home') { const ids = frame?.listCards ?? []; go(ids[0] ?? null); return; }
      if (ev.name === 'end') { const ids = frame?.listCards ?? []; go(ids.at(-1) ?? null);  return; }
      if (ev.name === 'enter' || ev.name === 'right' || ev.name === 'l' || ev.name === 'space' || (ev.name === 'tab' && !ev.shift)) { enterCard(); return; }
      if (ev.name === 'tab' && ev.shift) { enterCard(true); return; }
      if (ev.name === 'escape') { focus = null; pinned = null; m.cleared = true; pick(); return; }
    }
    if (ev.ctrl || ev.alt) return;
    if (ev.name === 'q') { quit(0); return; }
    if (ev.name === '?') { m.help = true; return; }
    if (ev.name === 'g') { cycleGroup(); return; }
    if (ev.name === 'C') { clearDealt(); return; }
    if (ev.name === 'r') { void refresh(); status('Reloaded.'); return; }
    if (ev.name === 'o' && m.current) { open(address(m.current.id)); return; }
  }

  function hitAt(x: number, y: number): Hit | undefined {
    return frame?.hits.find((h) => h.y === y && x >= h.x0 && x < h.x1);
  }

  function onMouse(ev: MouseEvent): void {
    if (!frame) return;
    if (ev.action === 'wheel-up' || ev.action === 'wheel-down') {
      const d = ev.action === 'wheel-up' ? -3 : 3;
      if (frame.listBox.w && ev.x < frame.listBox.x + frame.listBox.w) m.listScroll += d;
      else m.cardScroll += d;
      return;
    }
    if (ev.action !== 'down' || ev.button !== 0) return;
    if (m.help) { m.help = false; return; }
    if (m.confirm || m.pin) return;
    const h = hitAt(ev.x, ev.y);
    if (!h) {
      if (frame.cardBox.w && ev.x >= frame.cardBox.x && ev.y > 0 && ev.y < m.height - 1 && m.view) m.zone = 'card';
      return;
    }
    if (h.target === 'bar:help') { m.help = true; return; }
    if (h.target === 'list:group') { cycleGroup(); return; }
    if (h.target === 'list:clear') { clearDealt(); return; }
    if (h.target.startsWith('list:')) { m.zone = 'list'; go(h.target.slice(5)); return; }
    if (m.view) {
      m.zone = 'card';
      m.view.click(h.target, h.row, h.col + (ev.x - h.x0));
    }
  }

  // ---- start and stop ----
  let stopLive: () => void = () => {};
  const tick = setInterval(schedule, 60_000);
  function stop(): void {
    clearInterval(tick);
    clearTimeout(statusTimer);
    stopLive();
    term.stop();
    mark('exit', { frames, slowestFrameMs: Math.round(slowest * 10) / 10 });
  }

  term.onInput = onInput;
  term.onResize = () => { last = null; m.revealList = true; m.reveal = true; schedule(); };
  term.start();
  mark('start', { pid: process.pid });
  schedule();
  void loadParser().then(() => { mark('parser-ready'); schedule(); }, (e: Error) => status(`The card forms did not load: ${e.message}`, 'warn', 60_000));
  await refresh();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  stopLive = api.live((type) => {
    if (type === 'change' || type === 'presence') { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void refresh(); }, 30); }
  }, (up, code) => {
    // A page socket closed with 4423 lost its unlock: the PIN goes in again.
    if (code === 4423) void refresh();
    if (up !== m.connected) { m.connected = up; schedule(); }
    if (!up && !m.state) void refresh();
  });
  return finished;
}
